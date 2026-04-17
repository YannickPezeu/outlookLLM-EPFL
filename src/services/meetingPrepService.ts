import { config } from "../config";
import type { CalendarEvent, LightEmail, EmailMessage, MailDataSource } from "./mailTypes";
import { batchEmbed, rankBySimilarity } from "./embeddingService";
import { chatCompletionStream, chatCompletion, ChatMessage } from "./rcpApiService";
import { cleanEmailBody } from "./cleanEmailBody";
import { cleanEmailBodyFull } from "./cleanEmailBody";
// Dynamic import to avoid pulling pdfjs-dist in Node.js eval environment
const loadAttachmentService = () => import("./attachmentService");

// ─── Types ───────────────────────────────────────────────────────────

export interface Participant {
  name: string;
  email: string;
}

export interface ParticipantBriefing {
  participant: Participant;
  summary: string;
  emailCount: number;
  relevantEmailIds: string[];
}

export interface MeetingBriefing {
  event: CalendarEvent;
  participants: Participant[];
  participantBriefings: ParticipantBriefing[];
  finalBriefing: string;
}

export type PipelinePhase =
  | "extracting_context"
  | "collecting_emails"
  | "embedding_ranking"
  | "filtering_emails"
  | "searching_nonparticipants"
  | "reading_emails"
  | "summarizing_participants"
  | "generating_briefing"
  | "done"
  | "error";

export interface PipelineProgress {
  phase: PipelinePhase;
  message: string;
  detail?: string;
  percent: number;
}

type ProgressCallback = (progress: PipelineProgress) => void;
type StreamCallback = (chunk: string) => void;

// ─── Phase 1: Extract Context ───────────────────────────────────────

async function extractContext(
  ds: MailDataSource,
  eventId: string,
  onProgress: ProgressCallback
): Promise<{ event: CalendarEvent; participants: Participant[]; query: string }> {
  onProgress({
    phase: "extracting_context",
    message: "Extraction du contexte de la réunion...",
    percent: 5,
  });

  const event = await ds.getCalendarEvent(eventId);

  const participants: Participant[] = (event.attendees || [])
    .filter((a) => a.type !== "resource")
    .map((a) => ({
      name: a.emailAddress.name || a.emailAddress.address,
      email: a.emailAddress.address.toLowerCase(),
    }));

  // Build the semantic query from subject + cleaned body
  const eventBody = event.body?.content ? cleanEmailBody(event.body.content) : event.bodyPreview;
  const query = [event.subject, eventBody].filter(Boolean).join(" ");

  onProgress({
    phase: "extracting_context",
    message: `Réunion : ${event.subject}`,
    detail: `${participants.length} participant(s) trouvé(s)`,
    percent: 10,
  });

  return { event, participants, query };
}

// ─── Phase 2: Collect Emails ────────────────────────────────────────

async function collectEmails(
  ds: MailDataSource,
  participants: Participant[],
  onProgress: ProgressCallback
): Promise<Map<string, LightEmail[]>> {
  onProgress({
    phase: "collecting_emails",
    message: "Collecte des emails par participant...",
    percent: 15,
  });

  const emailsByParticipant = new Map<string, LightEmail[]>();

  // Sequential collection to avoid Graph API throttling (429)
  let totalEmails = 0;
  for (let i = 0; i < participants.length; i++) {
    const p = participants[i];
    onProgress({
      phase: "collecting_emails",
      message: `Collecte des emails : ${p.name} (${i + 1}/${participants.length})...`,
      percent: 15 + (i / participants.length) * 10,
    });
    const emails = await ds.collectEmailsWithParticipant(p.email);
    emailsByParticipant.set(p.email, emails);
    totalEmails += emails.length;
  }

  onProgress({
    phase: "collecting_emails",
    message: `${totalEmails} emails collectés (dédupliqués par conversation)`,
    percent: 25,
  });

  return emailsByParticipant;
}

// ─── Phase 3: Embed + Rank ──────────────────────────────────────────

interface RankedEmail {
  email: LightEmail;
  score: number;
  participantEmail: string;
  cleanBody?: string;         // Set after readFullEmails (cleanEmailBody — no reply chain)
  cleanBodyFull?: string;     // Set after readFullEmails (cleanEmailBodyFull — with reply chain)
  fullEmail?: EmailMessage;   // Set after readFullEmails
  gemmaScore?: number;        // Set after Gemma E2B filter
}

async function embedAndRank(
  query: string,
  emailsByParticipant: Map<string, LightEmail[]>,
  onProgress: ProgressCallback
): Promise<RankedEmail[]> {
  // Flatten all emails, deduplicate by ID (same email may appear from multiple participants)
  const allEmails: Array<{ email: LightEmail; participantEmail: string }> = [];
  const seenIds = new Set<string>();
  for (const [participantEmail, emails] of emailsByParticipant) {
    for (const email of emails) {
      if (seenIds.has(email.id)) continue;
      seenIds.add(email.id);
      allEmails.push({ email, participantEmail });
    }
  }

  if (allEmails.length === 0) {
    onProgress({
      phase: "embedding_ranking",
      message: "Aucun email trouvé avec les participants.",
      percent: 40,
    });
    return [];
  }

  onProgress({
    phase: "embedding_ranking",
    message: `Embedding de ${allEmails.length} emails...`,
    percent: 30,
  });

  // Prepare texts for embedding: query + all emails (subject + bodyPreview for embedding)
  const emailTexts = allEmails.map(
    ({ email }) => `${email.subject} ${email.bodyPreview}`
  );
  const allTexts = [query, ...emailTexts];

  // Batch embed everything in one call
  const embeddings = await batchEmbed(allTexts);
  const queryEmbedding = embeddings[0];
  const emailEmbeddings = embeddings.slice(1);

  onProgress({
    phase: "embedding_ranking",
    message: "Classement par pertinence...",
    percent: 38,
  });

  // Rank by cosine similarity
  const ranked = rankBySimilarity(queryEmbedding, emailEmbeddings);

  // Take top K
  const topK = Math.min(config.defaults.embeddingTopK, ranked.length);
  const topRanked: RankedEmail[] = ranked.slice(0, topK).map(({ index, score }) => ({
    email: allEmails[index].email,
    score,
    participantEmail: allEmails[index].participantEmail,
  }));

  onProgress({
    phase: "embedding_ranking",
    message: `Top ${topRanked.length} emails sélectionnés par pertinence sémantique`,
    percent: 40,
  });

  return topRanked;
}

// ─── Phase 3b: Read Full Emails ─────────────────────────────────────

async function readFullEmails(
  ds: MailDataSource,
  rankedEmails: RankedEmail[],
  onProgress: ProgressCallback
): Promise<void> {
  onProgress({
    phase: "reading_emails",
    message: `Lecture complète de ${rankedEmails.length} emails...`,
    percent: 42,
  });

  const messageIds = rankedEmails.map((r) => r.email.id);
  const fullEmails = await ds.getEmailsBatch(messageIds);

  // Extract attachments from emails that have them
  const emailsWithAttachments = fullEmails.filter((e) => e.hasAttachments);
  if (emailsWithAttachments.length > 0) {
    onProgress({
      phase: "reading_emails",
      message: `Extraction des pièces jointes (${emailsWithAttachments.length} emails)...`,
      percent: 44,
    });

    for (const email of emailsWithAttachments) {
      try {
        const attachments = await ds.getMessageAttachments(email.id);
        if (attachments.length > 0) {
          const { extractTextFromAttachments } = await loadAttachmentService();
          email.attachmentTexts = await extractTextFromAttachments(attachments);
        }
      } catch (err) {
        console.warn(`[MeetingPrep] Failed to extract attachments for ${email.id}:`, err);
      }
    }
  }

  // Attach full email + clean bodies to each ranked email
  let totalOrigChars = 0;
  let totalCleanChars = 0;
  for (let i = 0; i < rankedEmails.length; i++) {
    const full = fullEmails[i];
    if (full) {
      rankedEmails[i].fullEmail = full;
      const origBody = full.body?.content || full.bodyPreview;
      rankedEmails[i].cleanBody = cleanEmailBody(origBody);
      rankedEmails[i].cleanBodyFull = cleanEmailBodyFull(origBody);
      totalOrigChars += origBody.length;
      totalCleanChars += rankedEmails[i].cleanBody!.length;
    }
  }

  const attachmentCount = fullEmails.reduce(
    (sum, e) => sum + (e.attachmentTexts?.length || 0),
    0
  );
  console.log(`[MeetingPrep] Phase 3b — Full body: ${fullEmails.length} emails lus, ` +
    `${totalOrigChars.toLocaleString()} → ${totalCleanChars.toLocaleString()} chars cleanBody ` +
    `(${((1 - totalCleanChars / Math.max(totalOrigChars, 1)) * 100).toFixed(0)}% réduction)` +
    (attachmentCount > 0 ? `, ${attachmentCount} pièces jointes` : ""));

  onProgress({
    phase: "reading_emails",
    message: `Emails chargés${attachmentCount > 0 ? ` (${attachmentCount} pièces jointes extraites)` : ""}`,
    percent: 48,
  });
}

// ─── Phase 4: Gemma E2B Filter ──────────────────────────────────────

const GEMMA_FILTER_SYSTEM_PROMPT = `Tu es un assistant expert qui filtre des emails avant une réunion.

CONTEXTE : Les participants à cette réunion travaillent sur PLUSIEURS projets différents. Tu vas recevoir des emails échangés avec ces participants — certains sont utiles pour préparer cette réunion, d'autres non.

CRITÈRE : L'email contient-il de l'information exploitable pour rédiger un briefing de cette réunion ?

Échelle :
- 9-10 : Indispensable. Décisions, résultats, problèmes critiques directement liés à la réunion.
  Ex: "Les tests montrent une réduction de 40% de latence. Je recommande la prod."
  Ex: "Le budget est réduit de 30%. Il faut couper le module NLP ou reporter."
- 7-8 : Très utile. Avancées concrètes, engagements, questions ouvertes.
  Ex: "L'intégration du module multilingue avance. Résultats FR/DE prometteurs."
  Ex: "Le partenariat Milano est confirmé. 3 datasets d'ici fin mars."
- 5-6 : Contexte secondaire. Logistique, coordination informative.
  Ex: "Salle BC 410 réservée pour la démo du 20 mars."
  Ex: "Budget GPU restant : 12'000 CHF. Arbitrage nécessaire."
- 3-4 : Faible valeur. Accusés de réception, relances sans contenu.
  Ex: "OK pour mardi."
  Ex: "Bien reçu, on en parle jeudi."
- 1-2 : Quasi inutile.
- 0 : Aucun rapport avec la réunion.

Réponds UNIQUEMENT en JSON : [{"index":0,"score":7},{"index":1,"score":3}, ...]`;

async function filterWithGemmaE2B(
  rankedEmails: RankedEmail[],
  event: CalendarEvent,
  participants: Participant[],
  onProgress: ProgressCallback
): Promise<RankedEmail[]> {
  const BATCH_SIZE = config.defaults.filterBatchSize;
  const THRESHOLD = config.defaults.filterThreshold;
  const MAX_BODY_CHARS = 3000; // Cap body for context window safety

  const participantNames = participants.map((p) => p.name).join(", ");
  const eventDate = new Date(event.start.dateTime).toLocaleDateString("fr-FR");

  onProgress({
    phase: "filtering_emails",
    message: `Filtrage intelligent de ${rankedEmails.length} emails (Gemma E2B)...`,
    percent: 50,
  });

  let scored = 0;
  let parseFails = 0;

  for (let i = 0; i < rankedEmails.length; i += BATCH_SIZE) {
    const batch = rankedEmails.slice(i, i + BATCH_SIZE);

    // Build email descriptions using cleanBodyFull (with reply chain for context)
    const emailsStr = batch.map((r, idx) => {
      const body = (r.cleanBodyFull || r.cleanBody || r.email.bodyPreview).slice(0, MAX_BODY_CHARS);
      return `[${idx}] Sujet: ${r.email.subject}\n${body}`;
    }).join("\n\n---\n\n");

    const userPrompt =
      `## Réunion\nSujet : ${event.subject}\nDate : ${eventDate}\n` +
      `Participants : ${participantNames}\n\n` +
      `## Emails à noter\n\n${emailsStr}\n\nNote chaque email de 0 à 10.`;

    const messages: ChatMessage[] = [
      { role: "system", content: GEMMA_FILTER_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ];

    try {
      const response = await chatCompletion(messages, config.rcp.filterModel);
      const text = response.choices?.[0]?.message?.content || "";
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const arr = JSON.parse(match[0]) as Array<{ index: number; score: number }>;
        for (const s of arr) {
          if (typeof s.index === "number" && s.index >= 0 && s.index < batch.length) {
            batch[s.index].gemmaScore = s.score;
            scored++;
          }
        }
      } else {
        parseFails++;
        console.warn(`[MeetingPrep] Phase 4 — Gemma parse fail on batch ${Math.floor(i / BATCH_SIZE) + 1}`);
      }
    } catch (err) {
      parseFails++;
      console.warn(`[MeetingPrep] Phase 4 — Gemma error on batch ${Math.floor(i / BATCH_SIZE) + 1}:`, err);
    }

    onProgress({
      phase: "filtering_emails",
      message: `Filtrage : ${Math.min(i + BATCH_SIZE, rankedEmails.length)}/${rankedEmails.length} emails analysés...`,
      percent: 50 + ((i + BATCH_SIZE) / rankedEmails.length) * 12,
    });
  }

  // Filter by threshold
  const filtered = rankedEmails.filter((r) => (r.gemmaScore ?? 0) >= THRESHOLD);

  // Sort by Gemma score desc (best first)
  filtered.sort((a, b) => (b.gemmaScore ?? 0) - (a.gemmaScore ?? 0));

  console.log(`[MeetingPrep] Phase 4 — Gemma E2B: ${rankedEmails.length} → ${filtered.length} emails ` +
    `(seuil≥${THRESHOLD}, scored=${scored}, parseFails=${parseFails})`);
  console.log(`[MeetingPrep] Phase 4 — Score distribution: ` +
    `≥9: ${rankedEmails.filter((r) => (r.gemmaScore ?? 0) >= 9).length}, ` +
    `7-8: ${rankedEmails.filter((r) => (r.gemmaScore ?? 0) >= 7 && (r.gemmaScore ?? 0) < 9).length}, ` +
    `5-6: ${rankedEmails.filter((r) => (r.gemmaScore ?? 0) >= 5 && (r.gemmaScore ?? 0) < 7).length}, ` +
    `<5: ${rankedEmails.filter((r) => (r.gemmaScore ?? 0) < 5).length}`);

  onProgress({
    phase: "filtering_emails",
    message: `${filtered.length} emails retenus après filtrage intelligent`,
    percent: 62,
  });

  return filtered;
}

// ─── Phase 5: Non-Participant Email Search ──────────────────────────

async function searchNonParticipantEmails(
  ds: MailDataSource,
  query: string,
  event: CalendarEvent,
  existingEmailIds: Set<string>,
  participants: Participant[],
  onProgress: ProgressCallback
): Promise<RankedEmail[]> {
  onProgress({
    phase: "searching_nonparticipants",
    message: "Recherche d'emails hors participants...",
    percent: 64,
  });

  const participantEmails = new Set(participants.map((p) => p.email));

  // Search by meeting subject keywords
  let searchResults: LightEmail[];
  try {
    searchResults = await ds.searchEmailsByKeyword(event.subject, 50);
  } catch (err) {
    console.warn("[MeetingPrep] Phase 5 — Non-participant search failed:", err);
    return [];
  }

  // Filter out emails already collected and emails from participants
  const newEmails = searchResults.filter((e) => {
    if (existingEmailIds.has(e.id)) return false;
    const fromAddr = e.from?.emailAddress?.address?.toLowerCase();
    if (fromAddr && participantEmails.has(fromAddr)) return false;
    return true;
  });

  if (newEmails.length === 0) {
    console.log("[MeetingPrep] Phase 5 — No new non-participant emails found");
    onProgress({
      phase: "searching_nonparticipants",
      message: "Aucun email hors participants trouvé",
      percent: 68,
    });
    return [];
  }

  // Embed and rank these new emails
  const emailTexts = newEmails.map((e) => `${e.subject} ${e.bodyPreview}`);
  const allTexts = [query, ...emailTexts];
  const embeddings = await batchEmbed(allTexts);
  const queryEmbedding = embeddings[0];
  const emailEmbeddings = embeddings.slice(1);
  const ranked = rankBySimilarity(queryEmbedding, emailEmbeddings);

  const topK = Math.min(config.defaults.nonParticipantTopK, ranked.length);
  const topRanked: RankedEmail[] = ranked.slice(0, topK).map(({ index, score }) => ({
    email: newEmails[index],
    score,
    participantEmail: "__non_participant__",
  }));

  // Read full body for these emails
  const messageIds = topRanked.map((r) => r.email.id);
  const fullEmails = await ds.getEmailsBatch(messageIds);
  for (let i = 0; i < topRanked.length; i++) {
    const full = fullEmails[i];
    if (full) {
      topRanked[i].fullEmail = full;
      const origBody = full.body?.content || full.bodyPreview;
      topRanked[i].cleanBody = cleanEmailBody(origBody);
      topRanked[i].cleanBodyFull = cleanEmailBodyFull(origBody);
    }
  }

  console.log(`[MeetingPrep] Phase 5 — Non-participant: ${searchResults.length} trouvés → ${newEmails.length} nouveaux → top ${topRanked.length}`);

  onProgress({
    phase: "searching_nonparticipants",
    message: `${topRanked.length} emails hors participants trouvés`,
    percent: 68,
  });

  return topRanked;
}

// ─── Phase 6: Per-Participant Summaries ─────────────────────────────

async function summarizeParticipant(
  participant: Participant,
  rankedEmails: RankedEmail[],
  meetingSubject: string
): Promise<ParticipantBriefing> {
  if (rankedEmails.length === 0) {
    return {
      participant,
      summary: "Aucun échange préalable trouvé avec ce participant.",
      emailCount: 0,
      relevantEmailIds: [],
    };
  }

  // Format all emails into text blocks using cleanBodyFull (with reply chain)
  const emailTexts = rankedEmails.map((r) => {
    const e = r.fullEmail || r.email;
    const from = e.from?.emailAddress?.address || "inconnu";
    const date = new Date(e.receivedDateTime).toLocaleDateString("fr-FR");
    const gemmaTag = r.gemmaScore !== undefined ? ` [pertinence: ${r.gemmaScore}/10]` : "";
    const bodyText = r.cleanBodyFull || r.cleanBody || e.bodyPreview;
    let text = `[${date}] De: ${from} | Sujet: ${e.subject}${gemmaTag}\n${bodyText}`;

    const full = r.fullEmail;
    if (full?.attachmentTexts && full.attachmentTexts.length > 0) {
      const attachmentSection = full.attachmentTexts
        .map((a) => `  [PJ: ${a.name}]\n  ${a.text}`)
        .join("\n");
      text += `\n\nPièces jointes :\n${attachmentSection}`;
    }

    return text;
  });

  // Split into chunks that fit the context window (~200k tokens ≈ 800k chars for 26B)
  const MAX_CHUNK_CHARS = 700_000;
  const chunks: string[][] = [];
  let currentChunk: string[] = [];
  let currentSize = 0;

  for (const text of emailTexts) {
    if (currentSize + text.length > MAX_CHUNK_CHARS && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentSize = 0;
    }
    currentChunk.push(text);
    currentSize += text.length;
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  const today = new Date().toLocaleDateString("fr-FR", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const systemPrompt =
    `Tu es un assistant qui prépare des briefings pour des réunions. ` +
    `Nous sommes le ${today}. ` +
    "Résume les échanges email avec un participant de manière structurée en français. " +
    "Inclus : les sujets abordés, le ton général, les points en suspens, les engagements pris. " +
    "Si des pièces jointes sont présentes, intègre leur contenu dans l'analyse. " +
    "Sois concis mais complet.";

  let summary: string;

  if (chunks.length === 1) {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          `Réunion à préparer : "${meetingSubject}"\n` +
          `Participant : ${participant.name} (${participant.email})\n\n` +
          `Voici les ${rankedEmails.length} emails les plus pertinents échangés avec cette personne :\n\n${chunks[0].join("\n---\n")}`,
      },
    ];

    summary = "";
    await chatCompletionStream(messages, (chunk) => {
      summary += chunk;
    }, config.rcp.synthesisModel);
  } else {
    // Map-reduce: summarize each chunk, then merge
    console.log(`[MeetingPrep] ${participant.name}: ${chunks.length} chunks (content too large for single call)`);

    const chunkSummaries: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content:
            `Réunion à préparer : "${meetingSubject}"\n` +
            `Participant : ${participant.name} (${participant.email})\n` +
            `(Partie ${i + 1}/${chunks.length} des emails)\n\n` +
            `Voici des emails échangés avec cette personne :\n\n${chunks[i].join("\n---\n")}`,
        },
      ];

      let chunkSummary = "";
      await chatCompletionStream(messages, (c) => {
        chunkSummary += c;
      }, config.rcp.synthesisModel);
      chunkSummaries.push(chunkSummary);
    }

    // Reduce: merge chunk summaries into one
    const mergeMessages: ChatMessage[] = [
      {
        role: "system",
        content:
          "Tu es un assistant qui prépare des briefings pour des réunions. " +
          "On te donne plusieurs résumés partiels des échanges avec un même participant. " +
          "Fusionne-les en un seul résumé structuré et cohérent en français, sans répétitions. " +
          "Inclus : les sujets abordés, le ton général, les points en suspens, les engagements pris.",
      },
      {
        role: "user",
        content:
          `Réunion à préparer : "${meetingSubject}"\n` +
          `Participant : ${participant.name} (${participant.email})\n\n` +
          `Voici ${chunkSummaries.length} résumés partiels à fusionner :\n\n` +
          chunkSummaries.map((s, i) => `### Partie ${i + 1}\n${s}`).join("\n\n"),
      },
    ];

    summary = "";
    await chatCompletionStream(mergeMessages, (chunk) => {
      summary += chunk;
    }, config.rcp.synthesisModel);
  }

  return {
    participant,
    summary,
    emailCount: rankedEmails.length,
    relevantEmailIds: rankedEmails.map((r) => r.email.id),
  };
}

async function summarizeAllParticipants(
  participants: Participant[],
  emailsByParticipant: Map<string, RankedEmail[]>,
  meetingSubject: string,
  onProgress: ProgressCallback
): Promise<ParticipantBriefing[]> {
  onProgress({
    phase: "summarizing_participants",
    message: "Résumé des échanges par participant...",
    percent: 70,
  });

  // Parallelize per-participant summaries (up to 3 concurrent)
  const briefings: ParticipantBriefing[] = [];
  const concurrency = 3;

  for (let i = 0; i < participants.length; i += concurrency) {
    const batch = participants.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((p) =>
        summarizeParticipant(
          p,
          emailsByParticipant.get(p.email) || [],
          meetingSubject
        )
      )
    );
    briefings.push(...results);

    onProgress({
      phase: "summarizing_participants",
      message: `${Math.min(i + concurrency, participants.length)}/${participants.length} participants analysés`,
      percent: 70 + ((i + concurrency) / participants.length) * 15,
    });
  }

  return briefings;
}

// ─── Phase 7: Non-Participant Summary ───────────────────────────────

async function summarizeNonParticipantEmails(
  nonParticipantEmails: RankedEmail[],
  meetingSubject: string
): Promise<string> {
  if (nonParticipantEmails.length === 0) return "";

  const today = new Date().toLocaleDateString("fr-FR", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const emailTexts = nonParticipantEmails.map((r) => {
    const e = r.fullEmail || r.email;
    const from = e.from?.emailAddress?.name || e.from?.emailAddress?.address || "inconnu";
    const date = new Date(e.receivedDateTime).toLocaleDateString("fr-FR");
    const bodyText = r.cleanBodyFull || r.cleanBody || e.bodyPreview;
    return `[${date}] De: ${from} | Sujet: ${e.subject}\n${bodyText}`;
  }).join("\n---\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `Tu es un assistant qui prépare des briefings pour des réunions. ` +
        `Nous sommes le ${today}. ` +
        "On te donne des emails provenant de personnes qui ne sont PAS des participants directs de la réunion, " +
        "mais dont le contenu peut être pertinent pour le contexte. " +
        "Résume ce contexte externe de manière structurée en français. Sois concis.",
    },
    {
      role: "user",
      content:
        `Réunion à préparer : "${meetingSubject}"\n\n` +
        `Voici ${nonParticipantEmails.length} emails de contexte externe :\n\n${emailTexts}`,
    },
  ];

  let summary = "";
  await chatCompletionStream(messages, (chunk) => {
    summary += chunk;
  }, config.rcp.synthesisModel);

  return summary;
}

// ─── Phase 8: Final Briefing ────────────────────────────────────────

async function generateFinalBriefing(
  event: CalendarEvent,
  participants: Participant[],
  participantBriefings: ParticipantBriefing[],
  nonParticipantSummary: string,
  onStream: StreamCallback,
  onProgress: ProgressCallback
): Promise<string> {
  onProgress({
    phase: "generating_briefing",
    message: "Génération du briefing final...",
    percent: 90,
  });

  const startDate = new Date(event.start.dateTime).toLocaleDateString("fr-FR", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const participantSummaries = participantBriefings
    .map(
      (b) =>
        `### ${b.participant.name} (${b.participant.email})\n` +
        `Emails pertinents trouvés : ${b.emailCount}\n\n${b.summary}`
    )
    .join("\n\n");

  const nonParticipantSection = nonParticipantSummary
    ? `\n\n## Contexte externe (hors participants)\n\n${nonParticipantSummary}`
    : "";

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "Tu es un assistant expert en préparation de réunions. " +
        `Nous sommes le ${new Date().toLocaleDateString("fr-FR", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}. ` +
        "À partir des résumés d'échanges par participant, génère un briefing final structuré en français. " +
        "Le briefing doit inclure :\n" +
        "1. **Contexte** : pourquoi cette réunion a lieu\n" +
        "2. **Points clés par participant** : résumé bref de chaque relation\n" +
        "3. **Sujets probables à aborder** : déduits des emails\n" +
        "4. **Actions en attente** : engagements non tenus, questions ouvertes\n" +
        "5. **Emails clés à relire** : les plus importants avec date et sujet\n\n" +
        "Utilise le format Markdown. Sois concis, actionnable, et utile. " +
        "IMPORTANT : écris directement en Markdown, ne mets PAS le contenu dans un bloc de code (pas de ```markdown).",
    },
    {
      role: "user",
      content:
        `# Réunion : ${event.subject}\n` +
        `**Date :** ${startDate}\n` +
        `**Participants :** ${participants.map((p) => p.name).join(", ")}\n` +
        `**Description :** ${event.bodyPreview || "(aucune)"}\n\n` +
        `## Résumés par participant\n\n${participantSummaries}${nonParticipantSection}\n\n` +
        `Génère le briefing final pour préparer cette réunion.`,
    },
  ];

  const fullText = await chatCompletionStream(messages, onStream, config.rcp.synthesisModel);

  onProgress({
    phase: "done",
    message: "Briefing terminé !",
    percent: 100,
  });

  return fullText;
}

// ─── Trace Log ──────────────────────────────────────────────────────

function buildTraceLog(
  event: CalendarEvent,
  participants: Participant[],
  filteredEmails: RankedEmail[],
  nonParticipantEmails: RankedEmail[],
  totalCollected: number,
  totalEmbedded: number
): string {
  const lines: string[] = [];
  const sep = "═".repeat(70);

  lines.push(sep);
  lines.push(`Réunion : ${event.subject}`);
  lines.push(`Date : ${new Date(event.start.dateTime).toLocaleDateString("fr-FR")}`);
  lines.push(`Participants : ${participants.map((p) => p.name).join(", ")}`);
  lines.push(`Pipeline : ${totalCollected} collectés → ${totalEmbedded} embedded → ${filteredEmails.length} filtrés (Gemma E2B)`);
  lines.push(sep);

  // Group filtered emails by participant
  const byParticipant = new Map<string, RankedEmail[]>();
  for (const r of filteredEmails) {
    if (!byParticipant.has(r.participantEmail)) {
      byParticipant.set(r.participantEmail, []);
    }
    byParticipant.get(r.participantEmail)!.push(r);
  }

  for (const p of participants) {
    const emails = byParticipant.get(p.email) || [];
    lines.push(`\n--- Emails de ${p.name} (${emails.length} retenus, seuil≥${config.defaults.filterThreshold}) ---`);
    for (const r of emails) {
      const date = new Date(r.email.receivedDateTime).toLocaleDateString("fr-FR");
      lines.push(`  [gemma=${r.gemmaScore ?? "?"}] ${date} | ${r.email.subject}`);
    }
  }

  if (nonParticipantEmails.length > 0) {
    lines.push(`\n--- Emails hors participants (${nonParticipantEmails.length}, par sujet) ---`);
    for (const r of nonParticipantEmails) {
      const date = new Date(r.email.receivedDateTime).toLocaleDateString("fr-FR");
      const from = r.email.from?.emailAddress?.name || "?";
      lines.push(`  [emb=${r.score.toFixed(2)}] ${date} | ${from} | ${r.email.subject}`);
    }
  }

  return lines.join("\n");
}

// ─── Main Pipeline ──────────────────────────────────────────────────

/**
 * Run the full meeting preparation pipeline.
 *
 * Pipeline:
 *   Phase 1: Extract context (event + participants + query)
 *   Phase 2: Collect emails per participant (6 months, dedup by conversation)
 *   Phase 3: Embed + rank → top 200
 *   Phase 3b: Read full body of top 200
 *   Phase 4: Gemma E2B filter (batch 30, threshold ≥ 6) → ~120 emails
 *   Phase 5: Non-participant email search (Graph $search → embed → top 20)
 *   Phase 6: Per-participant summaries (Gemma 26B)
 *   Phase 7: Non-participant summary (Gemma 26B)
 *   Phase 8: Final briefing (Gemma 26B, streaming)
 */
export async function prepareMeeting(
  ds: MailDataSource,
  eventId: string,
  onProgress: ProgressCallback,
  onStream: StreamCallback
): Promise<MeetingBriefing> {
  // Phase 1: Extract context
  const { event, participants, query } = await extractContext(ds, eventId, onProgress);

  if (participants.length === 0) {
    onProgress({
      phase: "done",
      message: "Aucun participant trouvé dans cet événement.",
      percent: 100,
    });
    return {
      event,
      participants: [],
      participantBriefings: [],
      finalBriefing: "Aucun participant trouvé dans cet événement calendrier.",
    };
  }

  console.log(`[MeetingPrep] === Réunion: "${event.subject}" | ${participants.length} participants ===`);

  // Phase 2: Collect emails per participant
  const emailsByParticipant = await collectEmails(ds, participants, onProgress);
  let totalCollected = 0;
  for (const [email, emails] of emailsByParticipant) {
    console.log(`[MeetingPrep] Phase 2 — Collecte: ${email} → ${emails.length} emails`);
    totalCollected += emails.length;
  }
  console.log(`[MeetingPrep] Phase 2 — Total collecté: ${totalCollected} emails`);

  // Phase 3: Embed + rank → top 200
  const rankedEmails = await embedAndRank(query, emailsByParticipant, onProgress);
  console.log(`[MeetingPrep] Phase 3 — Embedding: ${totalCollected} emails → top ${rankedEmails.length} ` +
    `(score max: ${rankedEmails[0]?.score.toFixed(3) || "N/A"}, min: ${rankedEmails[rankedEmails.length - 1]?.score.toFixed(3) || "N/A"})`);

  // Phase 3b: Read full body of top emails
  await readFullEmails(ds, rankedEmails, onProgress);

  // Phase 4: Gemma E2B filter
  const filteredEmails = await filterWithGemmaE2B(rankedEmails, event, participants, onProgress);

  // Phase 5: Non-participant email search
  const existingEmailIds = new Set(rankedEmails.map((r) => r.email.id));
  const nonParticipantEmails = await searchNonParticipantEmails(
    ds, query, event, existingEmailIds, participants, onProgress
  );

  // Phase 6: Per-participant summaries (on filtered emails only)
  const filteredByParticipant = new Map<string, RankedEmail[]>();
  for (const r of filteredEmails) {
    if (!filteredByParticipant.has(r.participantEmail)) {
      filteredByParticipant.set(r.participantEmail, []);
    }
    filteredByParticipant.get(r.participantEmail)!.push(r);
  }
  for (const [email, emails] of filteredByParticipant) {
    const chars = emails.reduce((s, r) => s + (r.cleanBodyFull?.length || r.cleanBody?.length || 0), 0);
    console.log(`[MeetingPrep] Phase 6 — Résumé: ${email} → ${emails.length} emails (${chars.toLocaleString()} chars)`);
  }

  const participantBriefings = await summarizeAllParticipants(
    participants,
    filteredByParticipant,
    event.subject,
    onProgress
  );
  console.log(`[MeetingPrep] Phase 6 — ${participantBriefings.length} résumés générés`);

  // Phase 7: Non-participant summary
  let nonParticipantSummary = "";
  if (nonParticipantEmails.length > 0) {
    onProgress({
      phase: "summarizing_participants",
      message: "Résumé du contexte externe...",
      percent: 87,
    });
    nonParticipantSummary = await summarizeNonParticipantEmails(
      nonParticipantEmails,
      event.subject
    );
    console.log(`[MeetingPrep] Phase 7 — Résumé hors-participants: ${nonParticipantSummary.length} chars`);
  }

  // Phase 8: Final briefing (streamed)
  const finalBriefing = await generateFinalBriefing(
    event,
    participants,
    participantBriefings,
    nonParticipantSummary,
    onStream,
    onProgress
  );
  console.log(`[MeetingPrep] Phase 8 — Briefing final: ${finalBriefing.length.toLocaleString()} chars`);

  // Trace log (console only)
  const traceLog = buildTraceLog(event, participants, filteredEmails, nonParticipantEmails, totalCollected, rankedEmails.length);
  console.log(`[MeetingPrep] === TRACE LOG ===\n${traceLog}`);

  return {
    event,
    participants,
    participantBriefings,
    finalBriefing,
  };
}
