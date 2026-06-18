import { config } from "../config";
import type { CalendarEvent, LightEmail, EmailMessage, MailDataSource } from "./mailTypes";
import { batchEmbed, rankBySimilarity } from "./embeddingService";
import { chatCompletionStream, ChatMessage, getContextBudgetChars } from "./rcpApiService";
import { cleanEmailBody } from "./cleanEmailBody";
import { cleanEmailBodyFull } from "./cleanEmailBody";
import { getAccount } from "./authService";
import { getUserByEmail } from "./graphMailService";
// Dynamic import to avoid pulling pdfjs-dist in Node.js eval environment
const loadAttachmentService = () => import("./attachmentService");
import type { AttachmentText } from "./attachmentService";
import type { MeetingReport, MeetingParticipantBlock, DecisionSource, DecisionReport } from "./exportService";
import { analyzeRecordsToReport, type MailRecord } from "./topicDecisionService";

// ─── Report directives (angle + language), threaded into the briefing prompt ──
// Inlined (not imported from topicDecisionService) to keep this module free of the
// static attachmentService/pdfjs import that the Node eval environment avoids.
function focusLine(focus?: string): string {
  return focus && focus.trim()
    ? `\nANGLE PRIORITAIRE DEMANDÉ PAR L'UTILISATEUR : « ${focus.trim()} ». ` +
        "Oriente le briefing sous cet angle en priorité (sans ignorer les autres éléments importants)."
    : "";
}
function langLine(language?: string): string {
  const lang = language?.trim() || "français";
  return `\nLANGUE DE RÉDACTION : produis TOUTE ta sortie rédigée en ${lang}.`;
}
function buildDirectives(focus?: string, language?: string): string {
  return focusLine(focus) + langLine(language);
}

export type MeetingMode = "deep" | "soft";

export interface MeetingPrepOptions {
  language?: string;
  mode?: MeetingMode;
  // Period to look back over for participant exchanges (chosen by the user).
  // Filtered client-side ($search can't be combined with a date $filter).
  startISO?: string;
  endISO?: string;
}

// ─── Types ───────────────────────────────────────────────────────────

export interface Participant {
  name: string;
  email: string;
  // Optional directory-enriched fields (Phase 1). Populated via Graph /users
  // when User.ReadBasic.All is admin-consented; left undefined otherwise.
  jobTitle?: string;
  department?: string;
  officeLocation?: string;
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
  mode: MeetingMode;
  // SOFT: structured briefing report (rendered by exportMeetingReport).
  report?: MeetingReport;
  // DEEP: decisions-style report (major decisions + synthesis, rendered by
  // exportDecisionReport). Built from all participant exchanges over the period.
  decisionReport?: DecisionReport;
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

// Max chars of attachment text folded into the semantic query. The embedding
// signal degrades if the query is dominated by one long document, so we cap the
// contribution; the full text is still passed to the final briefing prompt.
const QUERY_ATTACHMENT_BUDGET = 6000;

async function extractContext(
  ds: MailDataSource,
  eventId: string,
  onProgress: ProgressCallback
): Promise<{
  event: CalendarEvent;
  participants: Participant[];
  query: string;
  eventAttachmentsText: AttachmentText[];
}> {
  onProgress({
    phase: "extracting_context",
    message: "Extraction du contexte de la réunion...",
    percent: 5,
  });

  const event = await ds.getCalendarEvent(eventId);

  // The meeting's own attachments often hold the real agenda/context (an agenda
  // PDF, a slide deck) rather than the event body. Extract their text so it feeds
  // both the semantic query and the final briefing.
  let eventAttachmentsText: AttachmentText[] = [];
  if (event.hasAttachments) {
    try {
      const attachments = await ds.getEventAttachments(eventId);
      if (attachments.length > 0) {
        onProgress({
          phase: "extracting_context",
          message: `Lecture des pièces jointes de la réunion (${attachments.length})...`,
          percent: 7,
        });
        const { extractTextFromAttachments } = await loadAttachmentService();
        eventAttachmentsText = await extractTextFromAttachments(attachments, undefined, {
          onProgress: (m) =>
            onProgress({ phase: "extracting_context", message: m, percent: 7 }),
        });
      }
    } catch (err) {
      console.warn("[MeetingPrep] Failed to read event attachments:", err);
    }
  }

  // Exclude the current signed-in user from the participant list. Their bucket
  // would contain mostly threads with non-meeting people (their wife, dentist,
  // other colleagues), and any thread they share with another participant is
  // already covered by that participant's bucket (which fetches both directions
  // via searchSentTo + searchFromSender). Net effect: less noise, fewer Graph
  // calls, no information loss.
  const selfEmail = getAccount()?.username?.toLowerCase();
  const allAttendees = (event.attendees || [])
    .filter((a) => a.type !== "resource")
    .map((a) => ({
      name: a.emailAddress.name || a.emailAddress.address,
      email: a.emailAddress.address.toLowerCase(),
    }));
  const baseParticipants: Participant[] = allAttendees.filter(
    (p) => !selfEmail || p.email !== selfEmail
  );
  const excludedSelf = allAttendees.length - baseParticipants.length > 0;

  // Enrich with directory profile (jobTitle, department, officeLocation) in parallel.
  // Falls through silently when User.ReadBasic.All isn't admin-consented or for
  // external addresses not in the EPFL tenant.
  onProgress({
    phase: "extracting_context",
    message: "Enrichissement profils participants (annuaire EPFL)...",
    percent: 8,
  });
  const profiles = await Promise.all(baseParticipants.map((p) => getUserByEmail(p.email)));
  const participants: Participant[] = baseParticipants.map((p, i) => {
    const prof = profiles[i];
    if (!prof) return p;
    return {
      ...p,
      // Prefer directory displayName when present (canonical) — fall back to attendee name
      name: prof.displayName || p.name,
      jobTitle: prof.jobTitle,
      department: prof.department,
      officeLocation: prof.officeLocation,
    };
  });
  const enrichedCount = participants.filter((p) => p.jobTitle || p.department).length;

  // Build the semantic query from subject + cleaned body + (capped) attachment text
  const eventBody = event.body?.content ? cleanEmailBody(event.body.content) : event.bodyPreview;
  const attachmentQueryText = eventAttachmentsText
    .map((a) => a.text)
    .join("\n")
    .slice(0, QUERY_ATTACHMENT_BUDGET);
  const query = [event.subject, eventBody, attachmentQueryText].filter(Boolean).join(" ");

  onProgress({
    phase: "extracting_context",
    message: `Réunion : ${event.subject}`,
    detail:
      `${participants.length} participant(s), ${enrichedCount} enrichi(s) via annuaire` +
      (eventAttachmentsText.length > 0
        ? `, ${eventAttachmentsText.length} pièce(s) jointe(s) de réunion lue(s)`
        : "") +
      (excludedSelf ? " (utilisateur courant exclu)" : ""),
    percent: 10,
  });

  return { event, participants, query, eventAttachmentsText };
}

/** Format a participant's directory info as a one-line tag for prompts. */
function formatParticipantProfile(p: Participant): string {
  const parts: string[] = [];
  if (p.jobTitle) parts.push(p.jobTitle);
  if (p.department) parts.push(p.department);
  if (p.officeLocation) parts.push(`bureau ${p.officeLocation}`);
  return parts.length ? ` — ${parts.join(", ")}` : "";
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
  let totalServiceDesk = 0;
  let totalRaw = 0; // raw fetched (received + sent) before per-participant conversation dedup
  for (let i = 0; i < participants.length; i++) {
    const p = participants[i];
    onProgress({
      phase: "collecting_emails",
      message: `Collecte des emails : ${p.name} (${i + 1}/${participants.length})...`,
      percent: 15 + (i / participants.length) * 10,
    });
    // Direct emails (from/to/cc) — capture raw vs deduped stats per participant
    let stats: { rawReceived: number; rawSent: number; deduped: number } | null = null;
    const direct = await ds.collectEmailsWithParticipant(p.email, (s) => { stats = s; });
    // ServiceDesk emails mentioning the person by name
    let serviceDesk: LightEmail[] = [];
    try {
      serviceDesk = await ds.searchServiceDeskEmailsForPerson(p.name, 50);
    } catch (err) {
      console.warn(`[MeetingPrep] ServiceDesk search failed for ${p.name}:`, err);
    }

    // Merge + dedup by id (ServiceDesk emails may already be in direct via from address)
    const seenIds = new Set(direct.map((e) => e.id));
    const merged = [...direct];
    for (const e of serviceDesk) {
      if (!seenIds.has(e.id)) {
        merged.push(e);
        seenIds.add(e.id);
      }
    }

    emailsByParticipant.set(p.email, merged);
    totalEmails += merged.length;
    totalServiceDesk += serviceDesk.length;
    const participantRaw = stats ? (stats as { rawReceived: number; rawSent: number; deduped: number }).rawReceived + (stats as { rawReceived: number; rawSent: number; deduped: number }).rawSent : direct.length;
    totalRaw += participantRaw;
    const rawTag = stats
      ? `${(stats as { rawReceived: number }).rawReceived} reçus + ${(stats as { rawSent: number }).rawSent} envoyés = ${participantRaw} bruts → ${direct.length} après dedup thread`
      : `${direct.length} direct`;
    console.log(`[MeetingPrep] Phase 2 — ${p.name}: ${rawTag}, +${serviceDesk.length} ServiceDesk = ${merged.length} emails`);
    onProgress({
      phase: "collecting_emails",
      message: `${p.name} : ${participantRaw} emails bruts → ${direct.length} après dedup thread (+${serviceDesk.length} ServiceDesk)`,
      percent: 15 + ((i + 1) / participants.length) * 10,
    });
  }

  onProgress({
    phase: "collecting_emails",
    message:
      `${totalEmails} emails collectés (compressés depuis ${totalRaw} bruts via dedup thread par participant)` +
      (totalServiceDesk > 0 ? `, dont ${totalServiceDesk} ServiceDesk` : ""),
    percent: 25,
  });

  return emailsByParticipant;
}

// ─── Phase 3: Dedup + Fetch + Embed + Rank ──────────────────────────

interface EnrichedEmail {
  email: LightEmail;
  participantEmail: string;
  fullEmail: EmailMessage;
  cleanBody: string;       // signatures + reply chain stripped — used for embedding
  cleanBodyFull: string;   // signatures stripped, reply chain kept — used for relevance filter & synthesis
}

interface RankedEmail {
  email: LightEmail;
  score: number;
  participantEmail: string;
  cleanBody?: string;
  cleanBodyFull?: string;
  fullEmail?: EmailMessage;
}

// Step 1 — flatten participant buckets, dedup by email id, then dedup by
// conversationId keeping the latest message of each thread. Operates on
// LightEmail metadata only — no body fetch, free.
function flattenAndDedup(
  emailsByParticipant: Map<string, LightEmail[]>
): Array<{ email: LightEmail; participantEmail: string }> {
  const flattened: Array<{ email: LightEmail; participantEmail: string }> = [];
  const seenIds = new Set<string>();
  for (const [participantEmail, emails] of emailsByParticipant) {
    for (const email of emails) {
      if (seenIds.has(email.id)) continue;
      seenIds.add(email.id);
      flattened.push({ email, participantEmail });
    }
  }

  const latestPerConv = new Map<string, { email: LightEmail; participantEmail: string }>();
  const noConvId: typeof flattened = [];
  for (const item of flattened) {
    const convId = item.email.conversationId;
    if (!convId) {
      noConvId.push(item);
      continue;
    }
    const existing = latestPerConv.get(convId);
    if (
      !existing ||
      new Date(item.email.receivedDateTime).getTime() >
        new Date(existing.email.receivedDateTime).getTime()
    ) {
      latestPerConv.set(convId, item);
    }
  }
  const result = [...latestPerConv.values(), ...noConvId];
  console.log(
    `[MeetingPrep] Phase 3 — Dedup: ${flattened.length} uniques par id, ` +
      `${flattened.length - result.length} collapsés via conversationId ` +
      `(${latestPerConv.size} threads, ${noConvId.length} sans convId) → ${result.length} restants`
  );
  return result;
}

// Step 2 — fetch full body for every deduped email (per-id, concurrency=4 to
// respect Graph's MailboxConcurrency limit), extract
// attachment text, and compute cleanBody / cleanBodyFull. Runs BEFORE embedding
// so the embedding sees the actual content of the email, not a 255-char preview.
async function fetchAndCleanBodies(
  ds: MailDataSource,
  items: Array<{ email: LightEmail; participantEmail: string }>,
  onProgress: ProgressCallback,
  readAttachments = true
): Promise<EnrichedEmail[]> {
  if (items.length === 0) return [];

  onProgress({
    phase: "reading_emails",
    message: `Lecture complète de ${items.length} emails...`,
    percent: 28,
  });

  const messageIds = items.map((it) => it.email.id);
  const fullEmails = await ds.getEmailsBatch(messageIds);

  const emailsWithAttachments = readAttachments ? fullEmails.filter((e) => e.hasAttachments) : [];
  if (emailsWithAttachments.length > 0) {
    onProgress({
      phase: "reading_emails",
      message: `Extraction des pièces jointes (${emailsWithAttachments.length} emails)...`,
      percent: 32,
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

  const fullById = new Map(fullEmails.map((f) => [f.id, f]));
  const enriched: EnrichedEmail[] = [];
  let totalOrigChars = 0;
  let totalCleanChars = 0;
  let droppedNoBody = 0;
  for (const item of items) {
    const full = fullById.get(item.email.id);
    if (!full) {
      droppedNoBody++;
      continue;
    }
    const origBody = full.body?.content || full.bodyPreview;
    const cleanBody = cleanEmailBody(origBody);
    const cleanBodyFull = cleanEmailBodyFull(origBody);
    enriched.push({
      email: item.email,
      participantEmail: item.participantEmail,
      fullEmail: full,
      cleanBody,
      cleanBodyFull,
    });
    totalOrigChars += origBody.length;
    totalCleanChars += cleanBody.length;
  }

  const attachmentCount = fullEmails.reduce(
    (sum, e) => sum + (e.attachmentTexts?.length || 0),
    0
  );
  console.log(
    `[MeetingPrep] Phase 3 — Fetch + clean: ${enriched.length}/${items.length} bodies récupérés, ` +
      `${totalOrigChars.toLocaleString()} → ${totalCleanChars.toLocaleString()} chars cleanBody ` +
      `(${((1 - totalCleanChars / Math.max(totalOrigChars, 1)) * 100).toFixed(0)}% réduction)` +
      (attachmentCount > 0 ? `, ${attachmentCount} pièces jointes extraites` : "") +
      (droppedNoBody > 0 ? `, ${droppedNoBody} sans body (drop)` : "")
  );

  // Surface the drop loudly: silent loss of bodies (e.g. residual throttling
  // beyond retry budget) would degrade briefing quality without anyone noticing.
  if (droppedNoBody > 0) {
    onProgress({
      phase: "reading_emails",
      message: `⚠ ${droppedNoBody}/${items.length} emails perdus pendant la lecture (échec après retries). Vérifier la console pour le détail.`,
      percent: 36,
    });
  }

  onProgress({
    phase: "reading_emails",
    message: `${enriched.length} emails chargés` +
      (attachmentCount > 0 ? ` (${attachmentCount} pièces jointes extraites)` : "") +
      (droppedNoBody > 0 ? ` — ${droppedNoBody} perdus` : ""),
    percent: 36,
  });

  return enriched;
}

// Step 3 — embed on subject + cleanBody[:EMBED_MAX_CHARS], rank by cosine
// similarity to the query, then select top-K with per-participant min quota
// + global fill so no participant is starved by a more-active correspondent.
const EMBED_MAX_CHARS = 10000;

async function embedAndRank(
  query: string,
  enriched: EnrichedEmail[],
  onProgress: ProgressCallback
): Promise<RankedEmail[]> {
  if (enriched.length === 0) {
    onProgress({
      phase: "embedding_ranking",
      message: "Aucun email trouvé avec les participants.",
      percent: 44,
    });
    return [];
  }

  onProgress({
    phase: "embedding_ranking",
    message: `Embedding de ${enriched.length} emails (jusqu'à ${EMBED_MAX_CHARS} chars chacun)...`,
    percent: 38,
  });

  // Embed on subject + cleaned body (no reply chain — avoids polluting the
  // signal with topics from earlier messages of the now-collapsed thread).
  const emailTexts = enriched.map(
    (e) => `${e.email.subject}\n\n${e.cleanBody.slice(0, EMBED_MAX_CHARS)}`
  );
  const embeddings = await batchEmbed([query, ...emailTexts]);
  const queryEmbedding = embeddings[0];
  const emailEmbeddings = embeddings.slice(1);

  onProgress({
    phase: "embedding_ranking",
    message: "Classement par pertinence...",
    percent: 42,
  });

  const ranked = rankBySimilarity(queryEmbedding, emailEmbeddings);

  // Per-participant min quota + global fill.
  const topK = Math.min(config.defaults.embeddingTopK, ranked.length);
  const participantSet = new Set(enriched.map((e) => e.participantEmail));
  const participantCount = participantSet.size;
  const minPerParticipant = Math.min(
    config.defaults.embeddingMinPerParticipant,
    Math.max(1, Math.floor(topK / Math.max(1, participantCount)))
  );

  const byParticipant = new Map<string, number[]>();
  for (let i = 0; i < ranked.length; i++) {
    const p = enriched[ranked[i].index].participantEmail;
    if (!byParticipant.has(p)) byParticipant.set(p, []);
    byParticipant.get(p)!.push(i);
  }

  const selectedRankIdx = new Set<number>();
  for (const positions of byParticipant.values()) {
    for (const rankIdx of positions.slice(0, minPerParticipant)) {
      selectedRankIdx.add(rankIdx);
      if (selectedRankIdx.size >= topK) break;
    }
    if (selectedRankIdx.size >= topK) break;
  }
  const quotaCount = selectedRankIdx.size;

  for (let i = 0; i < ranked.length && selectedRankIdx.size < topK; i++) {
    selectedRankIdx.add(i);
  }

  const sortedSelected = [...selectedRankIdx].sort(
    (a, b) => ranked[b].score - ranked[a].score
  );
  const topRanked: RankedEmail[] = sortedSelected.map((rankIdx) => {
    const { index, score } = ranked[rankIdx];
    const e = enriched[index];
    return {
      email: e.email,
      score,
      participantEmail: e.participantEmail,
      fullEmail: e.fullEmail,
      cleanBody: e.cleanBody,
      cleanBodyFull: e.cleanBodyFull,
    };
  });

  // Count available pool per participant (so we can spot when one participant's
  // quota was capped by what's actually available — e.g. only 5 emails total).
  const availablePerParticipant = new Map<string, number>();
  for (const e of enriched) {
    availablePerParticipant.set(e.participantEmail, (availablePerParticipant.get(e.participantEmail) || 0) + 1);
  }

  const finalDistribution = new Map<string, number>();
  for (const r of topRanked) {
    finalDistribution.set(r.participantEmail, (finalDistribution.get(r.participantEmail) || 0) + 1);
  }
  // Build "name=N/M" where M is the available pool — exposes when cross-participant
  // dedup re-attributed emails away from a less-active participant.
  const distEntries = [...finalDistribution.entries()].sort((a, b) => b[1] - a[1]);
  const distStr = distEntries
    .map(([p, n]) => {
      const avail = availablePerParticipant.get(p) || 0;
      return `${p.split("@")[0]}=${n}/${avail}`;
    })
    .join(", ");

  // Surface in the UI log panel so the user can verify the per-participant quota
  // actually fired. Format: name=selected/available
  onProgress({
    phase: "embedding_ranking",
    message: `Distribution top ${topK} (sélectionné/disponible) — quota=${minPerParticipant}/p : ${distStr}`,
    percent: 45,
  });

  console.log(
    `[MeetingPrep] Phase 3 — Quota: ${quotaCount} via min/participant ` +
      `(${minPerParticipant}/${participantCount}p), ${topK - quotaCount} via global fill. ` +
      `Distribution: ${distStr}`
  );

  onProgress({
    phase: "embedding_ranking",
    message: `Top ${topRanked.length} emails sélectionnés par pertinence sémantique`,
    percent: 46,
  });

  return topRanked;
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

  // Read full body for these emails — match by id, not index, since fetches may drop failures
  const messageIds = topRanked.map((r) => r.email.id);
  const fullEmails = await ds.getEmailsBatch(messageIds);
  const fullById = new Map(fullEmails.map((f) => [f.id, f]));
  for (const r of topRanked) {
    const full = fullById.get(r.email.id);
    if (full) {
      r.fullEmail = full;
      const origBody = full.body?.content || full.bodyPreview;
      r.cleanBody = cleanEmailBody(origBody);
      r.cleanBodyFull = cleanEmailBodyFull(origBody);
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

// Meeting prep ALWAYS loads emails directly into the synthesis prompt (no Mistral
// relevance filter, no per-participant summaries) and truncates by embedding rank
// to fit the ACTIVE model's context budget (getContextBudgetChars — per-model,
// e.g. ~600k chars for Kimi 256k, ~300k for 128k models).

/**
 * Format one email as a text block for synthesis prompts: header line + full
 * cleaned body (reply chain kept) + extracted attachment texts. Shared by the
 * per-participant summarizer and the direct-load briefing path so both produce
 * identical email rendering.
 */
function formatEmailBlock(r: RankedEmail): string {
  const e = r.fullEmail || r.email;
  const from = e.from?.emailAddress?.address || "inconnu";
  const date = new Date(e.receivedDateTime).toLocaleDateString("fr-FR");
  const bodyText = r.cleanBodyFull || r.cleanBody || e.bodyPreview;
  let text = `[${date}] De: ${from} | Sujet: ${e.subject}\n${bodyText}`;

  const full = r.fullEmail;
  if (full?.attachmentTexts && full.attachmentTexts.length > 0) {
    const attachmentSection = full.attachmentTexts
      .map((a) => `  [PJ: ${a.name}]\n  ${a.text}`)
      .join("\n");
    text += `\n\nPièces jointes :\n${attachmentSection}`;
  }
  return text;
}

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

  // Format all emails into text blocks (cleanBodyFull + attachments)
  const emailTexts = rankedEmails.map(formatEmailBlock);

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
          `Participant : ${participant.name} (${participant.email})${formatParticipantProfile(participant)}\n\n` +
          `Voici les ${rankedEmails.length} emails les plus pertinents échangés avec cette personne :\n\n${chunks[0].join("\n---\n")}`,
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
            `Participant : ${participant.name} (${participant.email})${formatParticipantProfile(participant)}\n` +
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
          `Participant : ${participant.name} (${participant.email})${formatParticipantProfile(participant)}\n\n` +
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
  });

  return summary;
}

// ─── Phase 8: Final Briefing ────────────────────────────────────────

/**
 * Phase 8 — final briefing (streamed). Pure assembler over pre-built per-participant
 * blocks. `contentKind` switches between the compression path (blocks are LLM
 * summaries) and the direct-load path (blocks are raw emails) — only the wording of
 * the source sentence + the section header change; the briefing structure is identical.
 */
async function generateFinalBriefing(
  event: CalendarEvent,
  participants: Participant[],
  participantBlocks: string,
  nonParticipantSection: string,
  meetingDocsSection: string,
  contentKind: "résumés" | "emails",
  directives: string,
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

  const sourceSentence = contentKind === "emails"
    ? "À partir des emails échangés avec chaque participant (et du contexte externe éventuel), génère un briefing final structuré."
    : "À partir des résumés d'échanges par participant, génère un briefing final structuré.";
  const sectionHeader = contentKind === "emails" ? "Emails par participant" : "Résumés par participant";

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "Tu es un assistant expert en préparation de réunions. " +
        `Nous sommes le ${new Date().toLocaleDateString("fr-FR", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}. ` +
        sourceSentence + " " +
        "Le briefing doit inclure :\n" +
        "1. **Contexte** : pourquoi cette réunion a lieu\n" +
        "2. **Points clés par participant** : résumé bref de chaque relation\n" +
        "3. **Sujets probables à aborder** : déduits des emails\n" +
        "4. **Actions en attente** : engagements non tenus, questions ouvertes\n" +
        "5. **Emails clés à relire** : les plus importants avec date et sujet\n\n" +
        "Utilise le format Markdown (titres, listes à puces, gras). Sois concis, actionnable, et utile. " +
        "IMPORTANT : écris directement en Markdown, ne mets PAS le contenu dans un bloc de code (pas de ```markdown). " +
        "N'utilise PAS de TABLEAUX markdown (le rendu Word ne les gère pas) : utilise des listes à puces à la place." +
        directives,
    },
    {
      role: "user",
      content:
        `# Réunion : ${event.subject}\n` +
        `**Date :** ${startDate}\n` +
        `**Participants :**\n` +
        participants.map((p) => `- ${p.name}${formatParticipantProfile(p)}`).join("\n") + "\n" +
        `**Description :** ${event.bodyPreview || "(aucune)"}\n` +
        meetingDocsSection +
        `\n## ${sectionHeader}\n\n${participantBlocks}${nonParticipantSection}\n\n` +
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
  lines.push(`Pipeline : ${totalCollected} collectés → ${totalEmbedded} embedded → ${filteredEmails.length} filtrés (pertinence)`);
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
    lines.push(`\n--- Emails de ${p.name} (${emails.length}) ---`);
    for (const r of emails) {
      const date = new Date(r.email.receivedDateTime).toLocaleDateString("fr-FR");
      lines.push(`  ${date} | ${r.email.subject}`);
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
 *   Phase 2: Collect emails per participant (6 months)
 *   Phase 3: (3a) Dedup by id + conversationId on light metadata
 *           (3b) Fetch full bodies (per-id, concurrency=4) → clean
 *           (3c) Embed on cleanBody[:10000] → rank → per-participant quota
 *                + global fill → top 400
 *   (The former Mistral relevance filter is gone — the top embedding-ranked
 *    emails that fit the model's context budget are loaded directly, see below.)
 *   Phase 5: Non-participant email search (Graph $search → embed → top 20)
 *   Phase 6: Per-participant summaries (modèle principal)
 *   Phase 7: Non-participant summary (modèle principal)
 *   Phase 8: Final briefing (modèle principal, streaming)
 */
export async function prepareMeeting(
  ds: MailDataSource,
  eventId: string,
  onProgress: ProgressCallback,
  onStream: StreamCallback,
  opts: MeetingPrepOptions = {}
): Promise<MeetingBriefing> {
  const mode: MeetingMode = opts.mode === "soft" ? "soft" : "deep";
  // Soft-mode briefing language (the meeting's own subject/description already
  // sets the angle, so no separate focus is needed).
  const directives = buildDirectives(undefined, opts.language);
  // Phase 1: Extract context
  const { event, participants, query, eventAttachmentsText } = await extractContext(
    ds, eventId, onProgress
  );

  if (participants.length === 0) {
    const onlySelf = (event.attendees || []).some((a) => a.type !== "resource");
    const reason = onlySelf
      ? "Vous êtes le seul participant — rien à préparer."
      : "Aucun participant trouvé dans cet événement calendrier.";
    onProgress({
      phase: "done",
      message: reason,
      percent: 100,
    });
    return {
      event,
      participants: [],
      participantBriefings: [],
      finalBriefing: reason,
      mode,
      report: {
        subject: event.subject,
        date: new Date(event.start.dateTime).toLocaleDateString("fr-CH"),
        generatedOn: new Date().toLocaleDateString("fr-CH"),
        briefing: reason,
        participants: [],
        externalSources: [],
        meetingDocs: [],
        language: opts.language,
        mode,
      },
    };
  }

  console.log(`[MeetingPrep] === Réunion: "${event.subject}" | ${participants.length} participants ===`);

  // Phase 2: Collect emails per participant
  const emailsByParticipant = await collectEmails(ds, participants, onProgress);

  // Period filter (chosen by the user) — applied client-side since $search can't
  // be combined with a date $filter. Bounds how far back we look for exchanges.
  if (opts.startISO || opts.endISO) {
    const start = opts.startISO ? new Date(opts.startISO).getTime() : -Infinity;
    const end = opts.endISO ? new Date(opts.endISO).getTime() : Infinity;
    let kept = 0;
    let before = 0;
    for (const [pe, emails] of emailsByParticipant) {
      before += emails.length;
      const filtered = emails.filter((e) => {
        const t = new Date(e.receivedDateTime).getTime();
        return t >= start && t <= end;
      });
      emailsByParticipant.set(pe, filtered);
      kept += filtered.length;
    }
    onProgress({ phase: "collecting_emails", message: `Filtre période : ${before} → ${kept} emails dans la fenêtre choisie`, percent: 25 });
  }

  let totalCollected = 0;
  for (const [email, emails] of emailsByParticipant) {
    console.log(`[MeetingPrep] Phase 2 — Collecte: ${email} → ${emails.length} emails`);
    totalCollected += emails.length;
  }
  console.log(`[MeetingPrep] Phase 2 — Total collecté: ${totalCollected} emails`);

  // Phase 3 — three sub-steps:
  //   3a. Dedup by id + conversationId on light metadata (free)
  //   3b. Fetch full bodies (per-id, concurrency=4) + clean (so embedding sees real content)
  //   3c. Embed on cleanBody[:10000], rank, select top-K with per-participant quota
  const dedupedLight = flattenAndDedup(emailsByParticipant);
  onProgress({
    phase: "embedding_ranking",
    message: `Dédup : ${totalCollected} emails → ${dedupedLight.length} après suppression des threads dupliqués`,
    percent: 26,
  });

  // Cross-participant dedup keeps the "latest" version of each thread, attributing
  // it to whoever's bucket the latest came from. So a participant whose threads
  // all had a more-recent reply in another bucket can lose attribution. Surface
  // the shift so it's not silent.
  const beforePerP = new Map<string, number>();
  for (const [pe, emails] of emailsByParticipant) beforePerP.set(pe, emails.length);
  const afterPerP = new Map<string, number>();
  for (const item of dedupedLight) {
    afterPerP.set(item.participantEmail, (afterPerP.get(item.participantEmail) || 0) + 1);
  }
  const shiftStr = participants
    .map((p) => `${p.name.split(" ")[0]}: ${beforePerP.get(p.email) || 0}→${afterPerP.get(p.email) || 0}`)
    .join(", ");
  onProgress({
    phase: "embedding_ranking",
    message: `Attribution post-dédup (entrants→survivants) : ${shiftStr}`,
    percent: 27,
  });

  const enriched = await fetchAndCleanBodies(ds, dedupedLight, onProgress);

  // ─── DEEP mode: 20-by-20 map-reduce over ALL participant exchanges ──────────
  // No embedding pre-rank: process everything, let the extraction's relevance
  // filter keep only what concerns this meeting, then build a decisions-style
  // report (major decisions + synthesis + clickable sources), like the topic one.
  if (mode === "deep") {
    return await prepareMeetingDeep(event, participants, enriched, dedupedLight, eventAttachmentsText, opts, onProgress, onStream);
  }

  // ─── SOFT mode = the original holistic pipeline (embedding rank → 1 briefing) ──
  let rankedEmails = await embedAndRank(query, enriched, onProgress);
  console.log(
    `[MeetingPrep] Phase 3 — Pipeline: ${totalCollected} collectés → ${dedupedLight.length} après dedup → ` +
      `${enriched.length} avec bodies → top ${rankedEmails.length} ` +
      `(score max: ${rankedEmails[0]?.score.toFixed(3) || "N/A"}, min: ${rankedEmails[rankedEmails.length - 1]?.score.toFixed(3) || "N/A"})`
  );

  // Phase 5: Non-participant email search (part of the original soft pipeline).
  const existingEmailIds = new Set(rankedEmails.map((r) => r.email.id));
  const nonParticipantEmails = await searchNonParticipantEmails(
    ds, query, event, existingEmailIds, participants, onProgress
  );

  // ─── Always load directly into context (Kimi K2.6 = 262k tokens) ────────
  // The old Mistral relevance filter (Phase 4) and per-participant summaries
  // (Phase 6/7) existed only to compress content into a smaller window — and the
  // filter was slow. We skip them entirely: keep the top emails by EMBEDDING rank
  // (already relevance-ordered, instant) that fit the budget, and load them raw
  // into the final-briefing prompt.
  const directLoadMaxChars = getContextBudgetChars(); // per active model
  const totalRanked = rankedEmails.length;
  const nonPartChars = nonParticipantEmails.reduce((s, r) => s + formatEmailBlock(r).length, 0);
  const emailBudget = Math.max(0, directLoadMaxChars - nonPartChars);
  let accChars = 0;
  const fitted: RankedEmail[] = [];
  for (const r of rankedEmails) {
    const len = formatEmailBlock(r).length;
    if (accChars + len > emailBudget && fitted.length > 0) break;
    fitted.push(r);
    accChars += len;
  }
  rankedEmails = fitted;
  const truncated = fitted.length < totalRanked;
  console.log(
    `[MeetingPrep] Chargement direct: ${fitted.length}/${totalRanked} emails (${accChars.toLocaleString()} chars) ` +
    `+ ${nonParticipantEmails.length} hors-participants — budget ${directLoadMaxChars.toLocaleString()} chars`
  );

  onProgress({
    phase: "filtering_emails",
    message: truncated
      ? `Chargement direct des ${fitted.length} emails les plus pertinents (sur ${totalRanked}) en contexte`
      : `Chargement direct des ${fitted.length} emails en contexte`,
    percent: 62,
  });

  // Group the loaded emails by participant — no filter, no per-participant summary.
  const byParticipant = new Map<string, RankedEmail[]>();
  for (const r of rankedEmails) {
    if (!byParticipant.has(r.participantEmail)) byParticipant.set(r.participantEmail, []);
    byParticipant.get(r.participantEmail)!.push(r);
  }

  const participantBlocks = participants
    .map((p) => {
      const emails = byParticipant.get(p.email) || [];
      const blocks = emails.map(formatEmailBlock).join("\n---\n");
      return `### ${p.name} (${p.email})\n${emails.length} email(s)\n\n${blocks || "Aucun échange préalable trouvé."}`;
    })
    .join("\n\n");

  const nonParticipantSection = nonParticipantEmails.length > 0
    ? `\n\n## Contexte externe (hors participants)\n\n${nonParticipantEmails.map(formatEmailBlock).join("\n---\n")}`
    : "";

  // Meeting's own attached documents (agenda PDF, slide deck, …) — full text,
  // placed up front so the LLM treats it as primary context for the meeting.
  const meetingDocsSection = eventAttachmentsText.length > 0
    ? `\n## Documents joints à la réunion\n\n` +
      eventAttachmentsText.map((a) => `### ${a.name}\n${a.text}`).join("\n\n") + "\n"
    : "";

  const finalBriefing = await generateFinalBriefing(
    event, participants, participantBlocks, nonParticipantSection, meetingDocsSection,
    "emails", directives, onStream, onProgress
  );

  // Per-participant counts for the result/UI stats; no intermediate summary here.
  const participantBriefings: ParticipantBriefing[] = participants.map((p) => {
    const emails = byParticipant.get(p.email) || [];
    return {
      participant: p,
      summary: "(emails chargés directement en contexte — pas de résumé intermédiaire)",
      emailCount: emails.length,
      relevantEmailIds: emails.map((r) => r.email.id),
    };
  });
  const emailsForTrace = rankedEmails;

  console.log(`[MeetingPrep] Phase 8 — Briefing final: ${finalBriefing.length.toLocaleString()} chars`);

  // Trace log (console only)
  const traceLog = buildTraceLog(event, participants, emailsForTrace, nonParticipantEmails, totalCollected, rankedEmails.length);
  console.log(`[MeetingPrep] === TRACE LOG ===\n${traceLog}`);

  // ─── Structured, source-linked report data (rendered to .docx by the caller) ──
  const toSource = (r: RankedEmail): DecisionSource => {
    const e = r.fullEmail || r.email;
    return {
      date: new Date(e.receivedDateTime).toLocaleDateString("fr-CH"),
      subject: e.subject || "(sans objet)",
      webLink: r.fullEmail?.webLink,
    };
  };
  const reportParticipants: MeetingParticipantBlock[] = participants.map((p) => ({
    name: p.name,
    profile: [p.jobTitle, p.department].filter(Boolean).join(", ") || undefined,
    sources: (byParticipant.get(p.email) || [])
      .slice()
      .sort((a, b) => new Date((b.fullEmail || b.email).receivedDateTime).getTime() - new Date((a.fullEmail || a.email).receivedDateTime).getTime())
      .map(toSource),
  }));
  const report: MeetingReport = {
    subject: event.subject,
    date: new Date(event.start.dateTime).toLocaleDateString("fr-CH"),
    generatedOn: new Date().toLocaleDateString("fr-CH"),
    briefing: finalBriefing,
    participants: reportParticipants,
    externalSources: nonParticipantEmails.map(toSource),
    meetingDocs: eventAttachmentsText.map((a) => a.name),
    language: opts.language,
    mode,
  };

  return {
    event,
    participants,
    participantBriefings,
    finalBriefing,
    mode,
    report,
  };
}

// ─── DEEP meeting pipeline (20-by-20 map-reduce, decisions-style report) ─────

async function prepareMeetingDeep(
  event: CalendarEvent,
  participants: Participant[],
  enriched: EnrichedEmail[],
  dedupedLight: Array<{ email: LightEmail; participantEmail: string }>,
  eventAttachmentsText: AttachmentText[],
  opts: MeetingPrepOptions,
  onProgress: ProgressCallback,
  onStream: StreamCallback
): Promise<MeetingBriefing> {
  const PER_MAIL = 16000;
  const eventBody = (event.body?.content ? cleanEmailBody(event.body.content) : event.bodyPreview || "").slice(0, 600);

  // Build records (one per deduped participant email) for the map-reduce.
  const records: MailRecord[] = enriched.map((e, i) => {
    const f = e.fullEmail;
    const iso = f.sentDateTime || f.receivedDateTime;
    const to = (f.toRecipients || []).map((r) => r.emailAddress?.name || r.emailAddress?.address || "").filter(Boolean);
    const from = f.from?.emailAddress?.name || f.from?.emailAddress?.address;
    let body = (e.cleanBodyFull || e.cleanBody || f.bodyPreview || "").slice(0, PER_MAIL);
    if (f.attachmentTexts && f.attachmentTexts.length > 0) {
      body += "\n\nPIÈCES JOINTES :\n" + f.attachmentTexts.map((a) => `# ${a.name}\n${a.text}`).join("\n\n");
    }
    return {
      marker: `E${i}`,
      id: f.id,
      kind: "email" as const,
      date: new Date(iso).toLocaleDateString("fr-CH"),
      sortKey: new Date(iso).getTime() || 0,
      participants: `${from || "?"}${to.length ? ` → ${to.slice(0, 4).join(", ")}` : ""}`,
      subject: f.subject || "(sans objet)",
      webLink: f.webLink,
      body,
    };
  });

  const meetingDesc = `la réunion « ${event.subject} »${eventBody ? ` (${eventBody})` : ""}`;
  onProgress({ phase: "summarizing_participants", message: `Analyse 20-par-20 de ${records.length} emails (filtrés sur le sujet de la réunion)…`, percent: 40 });

  const { major, intro, conclusion } = await analyzeRecordsToReport(records, {
    topic: event.subject,
    focus: `Préparer la réunion « ${event.subject} ». ${eventBody}`,
    language: opts.language,
    ignoreMinor: false,
    withDetailParagraph: true,
    withCurated: false, // deep meeting report = major decisions + synthesis only
    relevanceHint: meetingDesc,
    onProgress: (p) => onProgress({ phase: "generating_briefing", message: p.message, percent: Math.min(95, 40 + Math.round(p.percent * 0.5)) }),
    log: (m) => console.log(`[MeetingPrep:deep] ${m}`),
  });

  const decisionReport: DecisionReport = {
    topic: event.subject,
    generatedOn: new Date().toLocaleDateString("fr-CH"),
    emailsScanned: records.length,
    intro,
    detailed: [], // dropped on purpose — most participant mails are off-topic
    curated: [],
    major,
    conclusion,
    language: opts.language,
    mode: "deep",
  };

  // Stream a chat-facing summary (intro + major decisions + synthesis).
  const lines: string[] = [];
  lines.push(`## Préparation — ${event.subject}`);
  lines.push("");
  lines.push(intro);
  lines.push("");
  lines.push(`### Points / décisions majeurs (${major.length})`);
  for (const m of major) lines.push(`- **${m.title}** — ${m.summary}`);
  lines.push("");
  lines.push(`### Synthèse`);
  lines.push(conclusion);
  lines.push("");
  lines.push(`📄 **Rapport Word téléchargé** (préparation approfondie) — ${major.length} points majeurs + synthèse, avec liens cliquables vers les emails sources, sur ${records.length} emails analysés.`);
  const chatMd = lines.join("\n");
  onStream(chatMd);

  // Per-participant counts for stats.
  const countByP = new Map<string, number>();
  for (const item of dedupedLight) countByP.set(item.participantEmail, (countByP.get(item.participantEmail) || 0) + 1);
  const participantBriefings: ParticipantBriefing[] = participants.map((p) => ({
    participant: p,
    summary: "(mode approfondi — voir le rapport Word)",
    emailCount: countByP.get(p.email) || 0,
    relevantEmailIds: [],
  }));

  onProgress({ phase: "done", message: "Préparation approfondie terminée !", percent: 100 });

  return {
    event,
    participants,
    participantBriefings,
    finalBriefing: chatMd,
    mode: "deep",
    decisionReport,
  };
}
