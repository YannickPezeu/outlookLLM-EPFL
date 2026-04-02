import { config } from "../config";
import {
  CalendarEvent,
  LightEmail,
  EmailMessage,
  getCalendarEvent,
  collectEmailsWithParticipant,
  getEmailsBatch,
  getMessageAttachments,
} from "./graphMailService";
import { batchEmbed, rankBySimilarity } from "./embeddingService";
import { chatCompletionStream, ChatMessage } from "./rcpApiService";
import { extractTextFromAttachments } from "./attachmentService";

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
  eventId: string,
  onProgress: ProgressCallback
): Promise<{ event: CalendarEvent; participants: Participant[]; query: string }> {
  onProgress({
    phase: "extracting_context",
    message: "Extraction du contexte de la réunion...",
    percent: 5,
  });

  const event = await getCalendarEvent(eventId);

  const participants: Participant[] = (event.attendees || [])
    .filter((a) => a.type !== "resource")
    .map((a) => ({
      name: a.emailAddress.name || a.emailAddress.address,
      email: a.emailAddress.address.toLowerCase(),
    }));

  // Build the semantic query from subject + body
  const query = [event.subject, event.bodyPreview].filter(Boolean).join(" ");

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
      percent: 15 + (i / participants.length) * 15,
    });
    const emails = await collectEmailsWithParticipant(p.email);
    emailsByParticipant.set(p.email, emails);
    totalEmails += emails.length;
  }

  onProgress({
    phase: "collecting_emails",
    message: `${totalEmails} emails collectés (dédupliqués par conversation)`,
    percent: 30,
  });

  return emailsByParticipant;
}

// ─── Phase 3: Embed + Rank ──────────────────────────────────────────

interface RankedEmail {
  email: LightEmail;
  score: number;
  participantEmail: string;
}

async function embedAndRank(
  query: string,
  emailsByParticipant: Map<string, LightEmail[]>,
  onProgress: ProgressCallback
): Promise<RankedEmail[]> {
  // Flatten all emails
  const allEmails: Array<{ email: LightEmail; participantEmail: string }> = [];
  for (const [participantEmail, emails] of emailsByParticipant) {
    for (const email of emails) {
      allEmails.push({ email, participantEmail });
    }
  }

  if (allEmails.length === 0) {
    onProgress({
      phase: "embedding_ranking",
      message: "Aucun email trouvé avec les participants.",
      percent: 50,
    });
    return [];
  }

  onProgress({
    phase: "embedding_ranking",
    message: `Embedding de ${allEmails.length} emails...`,
    percent: 35,
  });

  // Prepare texts for embedding: query + all emails
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
    percent: 45,
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
    percent: 50,
  });

  return topRanked;
}

// ─── Phase 3b: LLM Reranking ───────────────────────────────────────

async function rerankWithLLM(
  query: string,
  rankedEmails: RankedEmail[],
  onProgress: ProgressCallback
): Promise<RankedEmail[]> {
  if (rankedEmails.length <= config.defaults.rerankTopK) {
    return rankedEmails;
  }

  onProgress({
    phase: "embedding_ranking",
    message: `Reranking LLM des ${rankedEmails.length} meilleurs emails...`,
    percent: 55,
  });

  // Build the reranking prompt
  const emailList = rankedEmails
    .map(
      (r, i) =>
        `[${i}] (score: ${r.score.toFixed(3)}) De/À: ${r.participantEmail} | Sujet: ${r.email.subject} | Aperçu: ${r.email.bodyPreview.slice(0, 150)}`
    )
    .join("\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "Tu es un assistant qui aide à préparer des réunions. " +
        "On te donne une liste d'emails pré-classés par similarité sémantique avec le sujet d'une réunion. " +
        "Sélectionne les emails les plus pertinents pour préparer cette réunion. " +
        "Réponds UNIQUEMENT avec les numéros des emails sélectionnés, séparés par des virgules, du plus pertinent au moins pertinent. " +
        "Exemple de réponse: 0,3,7,1,15,8",
    },
    {
      role: "user",
      content:
        `Réunion : "${query}"\n\n` +
        `Sélectionne les ${config.defaults.rerankTopK} emails les plus pertinents parmi :\n\n${emailList}`,
    },
  ];

  let response = "";
  await chatCompletionStream(messages, (chunk) => {
    response += chunk;
  });

  // Parse selected indices
  const indices = response
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n >= 0 && n < rankedEmails.length);

  // Deduplicate while preserving order
  const seen = new Set<number>();
  const uniqueIndices: number[] = [];
  for (const idx of indices) {
    if (!seen.has(idx)) {
      seen.add(idx);
      uniqueIndices.push(idx);
    }
  }

  const reranked = uniqueIndices
    .slice(0, config.defaults.rerankTopK)
    .map((idx) => rankedEmails[idx]);

  onProgress({
    phase: "embedding_ranking",
    message: `${reranked.length} emails retenus après reranking LLM`,
    percent: 60,
  });

  return reranked;
}

// ─── Phase 4: Read Full Emails ──────────────────────────────────────

async function readFullEmails(
  rankedEmails: RankedEmail[],
  onProgress: ProgressCallback
): Promise<Map<string, EmailMessage[]>> {
  onProgress({
    phase: "reading_emails",
    message: `Lecture complète de ${rankedEmails.length} emails...`,
    percent: 65,
  });

  const messageIds = rankedEmails.map((r) => r.email.id);
  const fullEmails = await getEmailsBatch(messageIds);

  // Extract attachments from emails that have them
  const emailsWithAttachments = fullEmails.filter((e) => e.hasAttachments);
  if (emailsWithAttachments.length > 0) {
    onProgress({
      phase: "reading_emails",
      message: `Extraction des pièces jointes (${emailsWithAttachments.length} emails)...`,
      percent: 67,
    });

    for (const email of emailsWithAttachments) {
      try {
        const attachments = await getMessageAttachments(email.id);
        if (attachments.length > 0) {
          email.attachmentTexts = await extractTextFromAttachments(attachments);
        }
      } catch (err) {
        console.warn(`[MeetingPrep] Failed to extract attachments for ${email.id}:`, err);
      }
    }
  }

  // Group by participant
  const byParticipant = new Map<string, EmailMessage[]>();
  for (let i = 0; i < rankedEmails.length; i++) {
    const pEmail = rankedEmails[i].participantEmail;
    if (!byParticipant.has(pEmail)) {
      byParticipant.set(pEmail, []);
    }
    if (fullEmails[i]) {
      byParticipant.get(pEmail)!.push(fullEmails[i]);
    }
  }

  const attachmentCount = fullEmails.reduce(
    (sum, e) => sum + (e.attachmentTexts?.length || 0),
    0
  );
  onProgress({
    phase: "reading_emails",
    message: `Emails chargés${attachmentCount > 0 ? ` (${attachmentCount} pièces jointes extraites)` : ""}`,
    percent: 70,
  });

  return byParticipant;
}

// ─── Phase 5A: Per-Participant Summaries ────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function summarizeParticipant(
  participant: Participant,
  emails: EmailMessage[],
  meetingSubject: string
): Promise<ParticipantBriefing> {
  if (emails.length === 0) {
    return {
      participant,
      summary: "Aucun échange préalable trouvé avec ce participant.",
      emailCount: 0,
      relevantEmailIds: [],
    };
  }

  // Format all emails into text blocks
  const emailTexts = emails.map((e) => {
    const from = e.from?.emailAddress?.address || "inconnu";
    const date = new Date(e.receivedDateTime).toLocaleDateString("fr-FR");
    const bodyText = e.body?.content
      ? stripHtml(e.body.content).slice(0, 800)
      : e.bodyPreview;
    let text = `[${date}] De: ${from} | Sujet: ${e.subject}\n${bodyText}`;

    if (e.attachmentTexts && e.attachmentTexts.length > 0) {
      const attachmentSection = e.attachmentTexts
        .map((a) => `  [PJ: ${a.name}]\n  ${a.text}`)
        .join("\n");
      text += `\n\nPièces jointes :\n${attachmentSection}`;
    }

    return text;
  });

  // Split into chunks that fit the context window (~100k tokens ≈ 400k chars)
  const MAX_CHUNK_CHARS = 350_000;
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
    // Everything fits in one call
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          `Réunion à préparer : "${meetingSubject}"\n` +
          `Participant : ${participant.name} (${participant.email})\n\n` +
          `Voici les ${emails.length} emails les plus pertinents échangés avec cette personne :\n\n${chunks[0].join("\n---\n")}`,
      },
    ];

    summary = "";
    await chatCompletionStream(messages, (chunk) => {
      summary += chunk;
    });
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
      });
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
    });
  }

  return {
    participant,
    summary,
    emailCount: emails.length,
    relevantEmailIds: emails.map((e) => e.id),
  };
}

async function summarizeAllParticipants(
  participants: Participant[],
  emailsByParticipant: Map<string, EmailMessage[]>,
  meetingSubject: string,
  onProgress: ProgressCallback
): Promise<ParticipantBriefing[]> {
  onProgress({
    phase: "summarizing_participants",
    message: "Résumé des échanges par participant...",
    percent: 75,
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
      percent: 75 + ((i + concurrency) / participants.length) * 15,
    });
  }

  return briefings;
}

// ─── Phase 5B: Final Briefing ───────────────────────────────────────

async function generateFinalBriefing(
  event: CalendarEvent,
  participants: Participant[],
  participantBriefings: ParticipantBriefing[],
  onStream: StreamCallback,
  onProgress: ProgressCallback
): Promise<string> {
  onProgress({
    phase: "generating_briefing",
    message: "Génération du briefing final...",
    percent: 92,
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
        `## Résumés par participant\n\n${participantSummaries}\n\n` +
        `Génère le briefing final pour préparer cette réunion.`,
    },
  ];

  const fullText = await chatCompletionStream(messages, onStream);

  onProgress({
    phase: "done",
    message: "Briefing terminé !",
    percent: 100,
  });

  return fullText;
}

// ─── Main Pipeline ──────────────────────────────────────────────────

/**
 * Run the full meeting preparation pipeline.
 *
 * @param eventId - The Outlook calendar event ID
 * @param onProgress - Called with pipeline progress updates
 * @param onStream - Called with streaming text chunks for the final briefing
 * @returns The complete meeting briefing
 */
export async function prepareMeeting(
  eventId: string,
  onProgress: ProgressCallback,
  onStream: StreamCallback
): Promise<MeetingBriefing> {
  // Phase 1: Extract context
  const { event, participants, query } = await extractContext(eventId, onProgress);

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

  // Phase 2: Collect emails per participant
  const emailsByParticipant = await collectEmails(participants, onProgress);

  // Phase 3: Embed + rank
  const rankedEmails = await embedAndRank(query, emailsByParticipant, onProgress);

  // Phase 3b: LLM reranking
  const rerankedEmails = await rerankWithLLM(query, rankedEmails, onProgress);

  // Phase 4: Read full body of selected emails
  const fullEmailsByParticipant = await readFullEmails(rerankedEmails, onProgress);

  // Phase 5A: Per-participant summaries
  const participantBriefings = await summarizeAllParticipants(
    participants,
    fullEmailsByParticipant,
    event.subject,
    onProgress
  );

  // Phase 5B: Final briefing (streamed)
  const finalBriefing = await generateFinalBriefing(
    event,
    participants,
    participantBriefings,
    onStream,
    onProgress
  );

  return {
    event,
    participants,
    participantBriefings,
    finalBriefing,
  };
}
