// ─── Topic Decision Extraction Pipeline ────────────────────────────────
// Deterministic pipeline (à la meetingPrepService) that builds a verifiable
// Word report of every DECISION taken on a topic, each linked to its source
// email. Flow:
//   1. Retrieve candidate emails = (keyword matches over the period)
//                                  ∪ (top-50 semantic matches over the period)
//   2. Fetch full bodies + webLink, sort chronologically
//   3. MAP: extract decisions in budget-capped batches (structured JSON)
//   4. REDUCE #1: group into major decisions (multi-source)
//   5. REDUCE #2: write intro + conclusion
//   6. Build & download the .docx (clickable email sources)
//
// All LLM calls use the user-chosen model (passing undefined → cfg.model), never
// a hardcoded one. Context-safety: bodies are capped per email AND each batch is
// bounded by a character budget so a few huge emails never blow up the prompt.
// Attachments (emails AND meetings) ARE read, but each is capped to ATTACH_BUDGET
// chars and the number of emails whose attachments we read is bounded — so big
// attachments never explode the context.

import { chatCompletion, ChatMessage, ChatCompletionResponse } from "./rcpApiService";
import {
  searchEmailsByKeyword,
  getEmailsBatch,
  getReceivedInRange,
  getSentInRange,
  getCalendarView,
  getCalendarEvent,
  getEventAttachments,
  getMessageAttachments,
} from "./graphMailService";
import { batchEmbed, rankBySimilarity } from "./embeddingService";
import { cleanEmailBodyFull } from "./cleanEmailBody";
import { extractTextFromAttachments } from "./attachmentService";
import { exportDecisionReport, reportLabels, DecisionEntry, DecisionReport, MajorDecision, DecisionSource } from "./exportService";
import { LightEmail, CalendarEvent } from "./mailTypes";

// ── Tunables ───────────────────────────────────────────────────────────
const KW_FETCH_CAP = 1000; // max keyword hits fetched per keyword (before date filter)
const SEM_FETCH_PER_DIR = 800; // received/sent fetched for the semantic pool
const SEM_TOP = 50; // semantic matches added on top of keyword matches
const MAX_POOL = 600; // hard cap on the merged candidate set
const EVENT_FETCH_CAP = 250; // past calendar events fetched over the period
const EVENT_SEM_TOP = 20; // semantic meetings added on top of keyword matches
const MAX_MEETINGS = 40; // hard cap on meetings analysed (bodies + attachments)
const ATTACH_BUDGET_DEEP = 6000; // chars of attachment text kept per item (deep)
const ATTACH_BUDGET_SOFT = 2000; // smaller portion kept per item (soft / quick refresh)
const MAX_MAJOR_SOURCES_FOR_DETAIL = 12; // source items fed to the detail LLM call
const PER_MAIL_BODY_CHARS = 16000; // cap per cleaned body (most emails fit in full)
const BATCH_MAX_MAILS = 20; // "20 par 20"
// Per-batch char ceiling. Kimi K2.6 has a 256k-token window (~900k chars), so
// 450k chars (~130k tokens) leaves ample room for the system prompt + output.
// With the 20-mail cap and 16k/mail above, a worst-case batch ≈ 320k chars, so
// this mostly acts as a safety net against a few very long threads.
const BATCH_CHAR_BUDGET = 450000;
const MAP_CONCURRENCY = 3; // parallel extraction LLM calls

/** Report depth: "deep" = exhaustive + per-mail trace; "soft" = quick refresh. */
export type ReportMode = "deep" | "soft";

export interface DateRange {
  startISO: string;
  endISO: string;
}

export interface TopicDecisionProgress {
  phase: string;
  message: string;
  percent: number;
}

interface PipelineOpts {
  log?: (msg: string) => void;
  onProgress?: (p: TopicDecisionProgress) => void;
  signal?: AbortSignal;
}

// Internal per-email record (authoritative metadata from Graph).
interface MailRecord {
  marker: string; // stable "E0", "E1"… used to map decisions back to the email
  id: string;
  kind: "email" | "meeting";
  date: string; // display "dd/mm/yyyy"
  sortKey: number; // epoch ms
  participants: string;
  subject: string;
  webLink?: string;
  body: string; // cleaned + truncated
  attachmentsTruncated?: boolean; // a PJ was cut to fit the budget (partial analysis)
}

export interface TopicDecisionResult {
  topic: string;
  emailsScanned: number;
  decisionsExtracted: number;
  majorCount: number;
  intro: string;
  conclusion: string;
  chatMarkdown: string; // ready-to-display summary for the chat
}

export interface TopicCountResult {
  count: number;
  capped: boolean;
  sampleSubjects: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Resolve a date range, defaulting to the last 12 months. */
export function resolveRange(startISO?: string, endISO?: string): DateRange {
  const end = endISO || new Date().toISOString();
  const start = startISO || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  return { startISO: start, endISO: end };
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso?.slice(0, 10) || "?";
  return d.toLocaleDateString("fr-CH");
}

function participantsOf(from: string | undefined, to: string[]): string {
  const recip = to.slice(0, 4).join(", ") + (to.length > 4 ? `, +${to.length - 4}` : "");
  return `${from || "?"}${recip ? ` → ${recip}` : ""}`;
}

/** Pull the text out of a completion, tolerating Kimi's reasoning_content. */
function llmText(resp: ChatCompletionResponse): string {
  const m = resp.choices?.[0]?.message;
  return m?.content || m?.reasoning_content || "";
}

/**
 * The user's "angle" (e.g. DPO → conformité / données personnelles), injected
 * into every LLM pass so extraction, curation, grouping and synthesis all keep
 * that perspective. Empty when no focus was given.
 */
function focusLine(focus?: string): string {
  return focus && focus.trim()
    ? `\nANGLE PRIORITAIRE DEMANDÉ PAR L'UTILISATEUR : « ${focus.trim()} ». ` +
        "Garde cet angle à l'esprit en permanence : relève, mets en avant et formule EN PRIORITÉ " +
        "ce qui s'y rapporte (sans pour autant ignorer les autres éléments clairement importants)."
    : "";
}

/** Output language, decided once by the agent and propagated to every pass. */
function langLine(language?: string): string {
  const lang = language?.trim() || "français";
  return `\nLANGUE DE RÉDACTION : produis TOUTE ta sortie rédigée en ${lang}.`;
}

/**
 * Combined per-run directives (angle + language) computed once and threaded into
 * every LLM pass, so the report keeps a single perspective and a single language.
 */
function buildDirectives(focus?: string, language?: string): string {
  return focusLine(focus) + langLine(language);
}

/** Tolerant JSON extraction from an LLM reply (strips ``` fences, finds the object). */
function parseJsonLoose<T>(raw: string): T | null {
  if (!raw) return null;
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) s = s.slice(first, last + 1);
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** Group records into batches bounded by both a max count and a char budget. */
function batchByBudget(records: MailRecord[]): MailRecord[][] {
  const batches: MailRecord[][] = [];
  let cur: MailRecord[] = [];
  let curChars = 0;
  for (const r of records) {
    const cost = r.body.length + 200;
    if (cur.length > 0 && (cur.length >= BATCH_MAX_MAILS || curChars + cost > BATCH_CHAR_BUDGET)) {
      batches.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(r);
    curChars += cost;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** Run async tasks with bounded concurrency, preserving input order. */
async function pmap<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

// ── Retrieval ──────────────────────────────────────────────────────────

/**
 * Keyword candidates = union of emails matching AT LEAST ONE keyword, filtered
 * client-side to the date range (Graph forbids $search + $filter together).
 * Returns a deduped LightEmail[] and whether any keyword hit the fetch cap.
 */
async function keywordCandidates(
  keywords: string[],
  range: DateRange,
  log: (m: string) => void,
  signal?: AbortSignal
): Promise<{ emails: LightEmail[]; capped: boolean }> {
  const start = new Date(range.startISO).getTime();
  const end = new Date(range.endISO).getTime();
  const byId = new Map<string, LightEmail>();
  let capped = false;

  for (const kw of keywords) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const hits = await searchEmailsByKeyword(kw, KW_FETCH_CAP);
    if (hits.length >= KW_FETCH_CAP) capped = true;
    let kept = 0;
    for (const h of hits) {
      const t = new Date(h.receivedDateTime).getTime();
      if (t >= start && t <= end) {
        byId.set(h.id, h);
        kept++;
      }
    }
    log(`Mot-clé « ${kw} » : ${hits.length} trouvés, ${kept} dans la période`);
  }
  return { emails: [...byId.values()], capped };
}

/** Count keyword-matching emails over the period (cheap — for the validation step). */
export async function countTopicEmails(
  keywords: string[],
  startISO: string | undefined,
  endISO: string | undefined,
  opts: PipelineOpts = {}
): Promise<TopicCountResult> {
  const range = resolveRange(startISO, endISO);
  const { emails, capped } = await keywordCandidates(keywords, range, opts.log ?? (() => {}), opts.signal);
  const sample = emails
    .sort((a, b) => new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime())
    .slice(0, 8)
    .map((e) => `${fmtDate(e.receivedDateTime)} — ${e.subject || "(sans objet)"}`);
  return { count: emails.length, capped, sampleSubjects: sample };
}

async function retrieveRecords(
  keywords: string[],
  question: string,
  range: DateRange,
  language: string | undefined,
  mode: ReportMode,
  opts: PipelineOpts
): Promise<MailRecord[]> {
  const log = opts.log ?? (() => {});
  const attachBudget = mode === "soft" ? ATTACH_BUDGET_SOFT : ATTACH_BUDGET_DEEP;

  // 1. Keyword matches (at least one keyword), within the period.
  const { emails: kwEmails } = await keywordCandidates(keywords, range, log, opts.signal);
  const idSet = new Set<string>(kwEmails.map((e) => e.id));
  log(`${idSet.size} emails par mot-clé sur la période`);

  // 2. Semantic recall (DEEP only): rank the period's emails against the
  //    natural-language question, add the top SEM_TOP that aren't keyword matches.
  //    Skipped in SOFT for speed (keyword-only).
  if (mode === "deep") {
    opts.onProgress?.({ phase: "semantic", message: "Recherche sémantique complémentaire…", percent: 12 });
    const [received, sent] = await Promise.all([
      getReceivedInRange(range.startISO, range.endISO, SEM_FETCH_PER_DIR),
      getSentInRange(range.startISO, range.endISO, SEM_FETCH_PER_DIR),
    ]);
    const semPoolMap = new Map<string, LightEmail>();
    for (const e of [...received, ...sent]) semPoolMap.set(e.id, e);
    const semPool = [...semPoolMap.values()];
    if (semPool.length > 0 && question.trim()) {
      if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      log(`Classement sémantique de ${semPool.length} emails sur : « ${question} »`);
      const texts = semPool.map((e) => `${e.subject} ${e.bodyPreview}`);
      const [qEmb, ...itemEmbs] = await batchEmbed([question, ...texts]);
      const ranked = rankBySimilarity(qEmb, itemEmbs);
      let added = 0;
      for (const r of ranked) {
        if (added >= SEM_TOP) break;
        const id = semPool[r.index].id;
        if (!idSet.has(id)) {
          idSet.add(id);
          added++;
        }
      }
      log(`+${added} emails ajoutés par similarité sémantique`);
    }
  }

  const ids = [...idSet].slice(0, MAX_POOL);
  log(`${ids.length} emails candidats au total (mot-clé ∪ sémantique)`);

  // 3. Full email bodies + webLink.
  let emailRecords: MailRecord[] = [];
  if (ids.length > 0) {
    opts.onProgress?.({ phase: "fetch", message: `Lecture du contenu de ${ids.length} emails…`, percent: 18 });
    const full = await getEmailsBatch(ids);
    const recById = new Map<string, MailRecord>();
    emailRecords = full.map((e) => {
      const to = (e.toRecipients || [])
        .map((r) => r.emailAddress?.name || r.emailAddress?.address || "")
        .filter(Boolean);
      const from = e.from?.emailAddress?.name || e.from?.emailAddress?.address;
      const iso = e.sentDateTime || e.receivedDateTime;
      const body = cleanEmailBodyFull(e.body?.content || e.bodyPreview || "").slice(0, PER_MAIL_BODY_CHARS);
      const rec: MailRecord = {
        marker: "",
        id: e.id,
        kind: "email" as const,
        date: fmtDate(iso),
        sortKey: new Date(iso).getTime() || 0,
        participants: participantsOf(from, to),
        subject: e.subject || "(sans objet)",
        webLink: e.webLink,
        body,
      };
      recById.set(e.id, rec);
      return rec;
    });

    // 3b. Read attachments of EVERY email that has them and append the extracted
    //     text to the record body. No count cap — each attachment is individually
    //     capped (ATTACH_BUDGET) and emails are processed batch by batch, so they
    //     are never all loaded into a single context at once.
    const toRead = full.filter((e) => e.hasAttachments);
    if (toRead.length > 0) {
      log(`Lecture des pièces jointes de ${toRead.length} emails…`);
      opts.onProgress?.({ phase: "attachments", message: `Lecture des pièces jointes de ${toRead.length} emails…`, percent: 20 });
      await pmap(toRead, 4, async (e) => {
        if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        try {
          const atts = await getMessageAttachments(e.id);
          const texts = await extractTextFromAttachments(atts as any, attachBudget, { onProgress: () => {} });
          const rec = recById.get(e.id);
          if (rec && texts.length > 0) {
            rec.body += "\n\nPIÈCES JOINTES :\n" + texts.map((t) => `# ${t.name}\n${t.text}`).join("\n\n");
            // A kept text exactly at the budget means it was cut → partial analysis.
            if (texts.some((t) => t.text.length >= attachBudget)) rec.attachmentsTruncated = true;
          }
        } catch {
          // attachment read failed — keep the body alone
        }
      });
    }
  }

  // 4. Past meetings (calendar events) with their description + attachments.
  opts.onProgress?.({ phase: "meetings", message: "Recherche des réunions passées…", percent: 22 });
  const meetingRecords = await collectMeetings(keywords, question, range, language, mode, opts);

  const records = [...emailRecords, ...meetingRecords];
  if (records.length === 0) return [];
  records.sort((a, b) => a.sortKey - b.sortKey);
  records.forEach((r, i) => (r.marker = `E${i}`));
  log(`${records.length} éléments à analyser (${emailRecords.length} emails + ${meetingRecords.length} réunions)`);
  return records;
}

/**
 * Collect past meetings over the period whose subject/body matches a keyword OR
 * is semantically close to the question, then read their full description AND
 * attachments (capped). Returns MailRecord[] tagged kind:"meeting" (markers set
 * later by the caller). Meeting count and attachment volume are bounded so this
 * never blows up the context.
 */
async function collectMeetings(
  keywords: string[],
  question: string,
  range: DateRange,
  language: string | undefined,
  mode: ReportMode,
  opts: PipelineOpts
): Promise<MailRecord[]> {
  const log = opts.log ?? (() => {});
  const meetingTag = reportLabels(language).meetingTag;
  const attachBudget = mode === "soft" ? ATTACH_BUDGET_SOFT : ATTACH_BUDGET_DEEP;
  const events = await getCalendarView(range.startISO, range.endISO, EVENT_FETCH_CAP);
  if (events.length === 0) return [];

  // Keyword match on subject + bodyPreview.
  const kwLower = keywords.map((k) => k.toLowerCase());
  const matched = new Map<string, CalendarEvent>();
  for (const e of events) {
    const hay = `${e.subject || ""} ${e.bodyPreview || ""}`.toLowerCase();
    if (kwLower.some((k) => k && hay.includes(k))) matched.set(e.id, e);
  }

  // Semantic top-up on the question (DEEP only).
  if (mode === "deep" && question.trim()) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const texts = events.map((e) => `${e.subject || ""} ${e.bodyPreview || ""}`);
    const [qEmb, ...embs] = await batchEmbed([question, ...texts]);
    const ranked = rankBySimilarity(qEmb, embs);
    let added = 0;
    for (const r of ranked) {
      if (added >= EVENT_SEM_TOP) break;
      const ev = events[r.index];
      if (!matched.has(ev.id)) {
        matched.set(ev.id, ev);
        added++;
      }
    }
  }

  const list = [...matched.values()].slice(0, MAX_MEETINGS);
  if (list.length === 0) return [];
  log(`${list.length} réunions candidates, lecture du contenu + pièces jointes…`);

  // Read full body + attachments per meeting (bounded concurrency).
  return pmap(list, 3, async (ev) => {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const full = await getCalendarEvent(ev.id).catch(() => null);
    const base = full || ev;
    let body = cleanEmailBodyFull(base.body?.content || base.bodyPreview || "").slice(0, PER_MAIL_BODY_CHARS);
    let attachmentsTruncated = false;

    if (base.hasAttachments) {
      try {
        const atts = await getEventAttachments(ev.id);
        const texts = await extractTextFromAttachments(atts as any, attachBudget, { onProgress: () => {} });
        if (texts.length > 0) {
          body += "\n\nPIÈCES JOINTES DE LA RÉUNION :\n" + texts.map((t) => `# ${t.name}\n${t.text}`).join("\n\n");
          if (texts.some((t) => t.text.length >= attachBudget)) attachmentsTruncated = true;
        }
      } catch {
        // attachment read failed — keep the body alone
      }
    }

    const iso = base.start?.dateTime || "";
    const attendees = (base.attendees || [])
      .map((a) => a.emailAddress?.name || a.emailAddress?.address || "")
      .filter(Boolean);
    const organizer = base.organizer?.emailAddress?.name || base.organizer?.emailAddress?.address;
    return {
      marker: "",
      id: ev.id,
      kind: "meeting" as const,
      date: fmtDate(iso),
      sortKey: new Date(iso).getTime() || 0,
      participants: participantsOf(organizer, attendees),
      subject: `${meetingTag} ${base.subject || "(sans objet)"}`,
      webLink: base.webLink,
      body,
      attachmentsTruncated,
    };
  });
}

// ── MAP: extract decisions ───────────────────────────────────────────────

interface RawDecision {
  mail: string;
  decision: string;
  citation?: string;
}

async function mapExtract(records: MailRecord[], topic: string, directives: string, ignoreMinor: boolean, opts: PipelineOpts): Promise<DecisionEntry[]> {
  const log = opts.log ?? (() => {});
  const batches = batchByBudget(records);
  log(`Extraction en ${batches.length} lots (max ${BATCH_MAX_MAILS} mails / ${BATCH_CHAR_BUDGET} car. par lot)`);

  const byMarker = new Map(records.map((r) => [r.marker, r]));
  let done = 0;

  const perBatch = await pmap(batches, MAP_CONCURRENCY, async (batch) => {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const emailsText = batch
      .map((r) => `=== ${r.marker} | ${r.date} | ${r.participants} | Objet : ${r.subject} ===\n${r.body}`)
      .join("\n\n");

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          `Tu es un analyste qui extrait les DÉCISIONS prises dans des emails ET des réunions ` +
          `(les éléments préfixés « [Réunion] » sont des événements d'agenda, avec leur description et leurs pièces jointes) ` +
          `au sujet de : "${topic}".\n` +
          "Une décision = un choix acté, une validation, un arbitrage, un engagement, une échéance fixée, " +
          "un go/no-go, une attribution de responsabilité.\n" +
          "RÈGLES STRICTES :\n" +
          "- Beaucoup d'emails ne contiennent AUCUNE décision : dans ce cas ne renvoie rien pour eux.\n" +
          "- N'invente JAMAIS. Chaque décision doit s'appuyer sur une citation VERBATIM courte (≤ 200 car.) tirée du mail.\n" +
          "- Une demande, une question ou une simple information n'est PAS une décision.\n" +
          "- Reformule la décision en une phrase claire et factuelle.\n" +
          (ignoreMinor
            ? "- Ne retiens QUE les décisions IMPORTANTES / structurantes ; IGNORE les décisions mineures, de routine ou de détail.\n"
            : "") +
          'Réponds UNIQUEMENT en JSON valide : {"decisions":[{"mail":"E12","decision":"…","citation":"…"}]}. ' +
          "Aucun texte hors du JSON." +
          directives,
      },
      {
        role: "user",
        content: `Éléments à analyser (emails et réunions) :\n\n${emailsText}\n\nExtrais les décisions au format JSON.`,
      },
    ];

    const resp = await chatCompletion(messages, undefined, 8192);
    const parsed = parseJsonLoose<{ decisions: RawDecision[] }>(llmText(resp));
    done += batch.length;
    opts.onProgress?.({
      phase: "extract",
      message: `Extraction des décisions… ${done}/${records.length} emails`,
      percent: 20 + Math.round((done / records.length) * 45),
    });

    const entries: DecisionEntry[] = [];
    for (const d of parsed?.decisions || []) {
      const rec = byMarker.get(d.mail);
      if (!rec || !d.decision?.trim()) continue;
      entries.push({
        date: rec.date,
        sortKey: rec.sortKey,
        participants: rec.participants,
        subject: rec.subject,
        decision: d.decision.trim(),
        citation: d.citation?.trim(),
        webLink: rec.webLink,
        marker: rec.marker,
        attachmentsTruncated: rec.attachmentsTruncated,
      });
    }
    return entries;
  });

  const all = perBatch.flat();
  all.sort((a, b) => a.sortKey - b.sortKey);
  log(`${all.length} décisions extraites au total`);
  return all;
}

// ── REDUCE #1a: curate the key decisions (chronologie épurée) ──────────────

interface CuratedRaw {
  refs: string[];
  decision: string;
}

async function curate(detailed: DecisionEntry[], topic: string, directives: string, opts: PipelineOpts): Promise<DecisionEntry[]> {
  if (detailed.length === 0) return [];
  const list = detailed.map((d, i) => `[D${i} | ${d.date}] ${d.decision}`).join("\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `Tu reçois la liste chronologique des décisions extraites au sujet de : "${topic}".\n` +
        "Produis une CHRONOLOGIE ÉPURÉE : ne garde que les décisions VRAIMENT structurantes, " +
        "fusionne les doublons (mêmes décisions répétées dans un fil), reformule clairement, " +
        "et conserve l'ordre chronologique.\n" +
        "Pour chaque décision retenue, indique les D# sources qui la justifient.\n" +
        'Réponds UNIQUEMENT en JSON : {"curated":[{"refs":["D2","D5"],"decision":"…"}]}.' +
        directives,
    },
    { role: "user", content: `Décisions :\n${list}\n\nProduis la chronologie épurée en JSON.` },
  ];

  const resp = await chatCompletion(messages, undefined, 4096);
  const parsed = parseJsonLoose<{ curated: CuratedRaw[] }>(llmText(resp));
  if (!parsed?.curated) {
    opts.log?.("Passe épurée : JSON illisible, repli sur les décisions détaillées");
    return detailed;
  }

  const curated: DecisionEntry[] = [];
  for (const c of parsed.curated) {
    if (!c.decision?.trim()) continue;
    const idx = (c.refs || [])
      .map((r) => parseInt(String(r).replace(/[^0-9]/g, ""), 10))
      .find((n) => Number.isInteger(n) && n >= 0 && n < detailed.length);
    const src = idx != null ? detailed[idx] : detailed[0];
    curated.push({
      date: src.date,
      sortKey: src.sortKey,
      participants: src.participants,
      subject: src.subject,
      decision: c.decision.trim(),
      citation: src.citation,
      webLink: src.webLink,
    });
  }
  curated.sort((a, b) => a.sortKey - b.sortKey);
  opts.log?.(`${curated.length} décisions clés retenues (chronologie épurée)`);
  return curated;
}

// ── REDUCE #1b: group into MAJOR decisions (title + summary + detail) ───────

interface MajorRaw {
  refs: string[];
  title: string;
  summary: string;
}

interface MajorIntermediate {
  title: string;
  summary: string;
  sources: DecisionSource[];
  markers: string[]; // source record markers (deduped) → full text for the detail pass
  sortKey: number;
}

/** Build the deduped sources + source markers for a group of detailed-entry indices. */
function buildIntermediate(title: string, summary: string, idxs: number[], detailed: DecisionEntry[]): MajorIntermediate {
  const seenSrc = new Set<string>();
  const seenMarker = new Set<string>();
  const sources: DecisionSource[] = [];
  const markers: string[] = [];
  let minSort = Infinity;
  for (const i of idxs) {
    const d = detailed[i];
    if (!d) continue;
    const key = d.webLink || `${d.subject}|${d.date}`;
    if (!seenSrc.has(key)) {
      seenSrc.add(key);
      sources.push({ date: d.date, subject: d.subject, webLink: d.webLink });
    }
    if (d.marker && !seenMarker.has(d.marker)) {
      seenMarker.add(d.marker);
      markers.push(d.marker);
    }
    minSort = Math.min(minSort, d.sortKey);
  }
  return { title, summary, sources, markers, sortKey: minSort === Infinity ? 0 : minSort };
}

/**
 * Dedicated detail pass: rewrite the fully-detailed paragraph of ONE major
 * decision straight from its source emails/meetings (the source of truth),
 * reusing the already-produced title + summary.
 */
async function writeMajorDetail(
  title: string,
  summary: string,
  directives: string,
  sourceRecords: MailRecord[]
): Promise<string> {
  if (sourceRecords.length === 0) return "";
  const src = sourceRecords
    .slice(0, MAX_MAJOR_SOURCES_FOR_DETAIL)
    .map((r) => `=== ${r.subject} | ${r.date} | ${r.participants} ===\n${r.body}`)
    .join("\n\n");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "Tu rédiges la DESCRIPTION DÉTAILLÉE d'une décision majeure, pour un rapport destiné au personnel " +
        "dirigeant EPFL. On te fournit un TITRE et une COURTE DESCRIPTION déjà rédigés, ainsi que les emails/" +
        "réunions SOURCES (source de vérité). Développe de façon précise et factuelle UNIQUEMENT à partir des " +
        "sources : contexte, contenu exact de la décision, qui a décidé / qui est impliqué, dates, conditions, " +
        "implications concrètes. N'invente RIEN, n'ajoute aucune information absente des sources.\n" +
        "STRUCTURE (évite le gros pavé) : 1 à 2 phrases d'introduction, PUIS quelques puces markdown « - » " +
        "pour les points clés (qui/quoi, dates, conditions, implications). N'utilise PAS de titres (« ## »), " +
        "pas de citation de liens. " +
        "Sois DÉTAILLÉ et complet (c'est la description détaillée, pas un résumé) : ne sacrifie aucun élément " +
        "important présent dans les sources." +
        directives,
    },
    {
      role: "user",
      content: `Titre : ${title}\nDescription : ${summary}\n\nSources :\n${src}\n\nRédige le paragraphe détaillé.`,
    },
  ];
  const resp = await chatCompletion(messages, undefined, 2048);
  return llmText(resp).trim() || summary;
}

async function selectMajorDecisions(
  detailed: DecisionEntry[],
  records: MailRecord[],
  topic: string,
  directives: string,
  withDetail: boolean,
  opts: PipelineOpts
): Promise<MajorDecision[]> {
  if (detailed.length === 0) return [];
  const list = detailed.map((d, i) => `[D${i} | ${d.date}] ${d.decision}`).join("\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `Tu reçois la liste chronologique des décisions extraites au sujet de : "${topic}".\n` +
        "Regroupe-les en DÉCISIONS MAJEURES (les arbitrages réellement structurants).\n" +
        "Pour CHAQUE décision majeure, fournis :\n" +
        "- `title` : un TITRE court et lisible en 2 secondes (≤ ~10 mots, sans point final) ;\n" +
        "- `summary` : une DESCRIPTION en 1 à 2 phrases ;\n" +
        "- `refs` : TOUS les D# qui la prennent, la confirment ou la rappellent (une même décision est " +
        "souvent répétée dans plusieurs mails d'un fil).\n" +
        "Fusionne les doublons et ne garde QUE ce qui est vraiment important.\n" +
        'Réponds UNIQUEMENT en JSON : {"major":[{"title":"…","summary":"…","refs":["D2","D5","D9"]}]}.' +
        directives,
    },
    { role: "user", content: `Décisions :\n${list}\n\nRegroupe en décisions majeures au format JSON.` },
  ];

  const resp = await chatCompletion(messages, undefined, 4096);
  const groups = parseJsonLoose<{ major: MajorRaw[] }>(llmText(resp))?.major;

  let intermediates: MajorIntermediate[];
  if (!groups || groups.length === 0) {
    opts.log?.("Passe décisions majeures : JSON illisible, repli (1 décision = 1 majeure)");
    intermediates = detailed
      .slice(0, 25)
      .map((d, i) => buildIntermediate(d.decision.slice(0, 90), d.decision, [i], detailed));
  } else {
    intermediates = [];
    for (const g of groups) {
      const title = g.title?.trim();
      if (!title) continue;
      const idxs = (g.refs || [])
        .map((r) => parseInt(String(r).replace(/[^0-9]/g, ""), 10))
        .filter((n) => Number.isInteger(n) && n >= 0 && n < detailed.length);
      intermediates.push(buildIntermediate(title, g.summary?.trim() || "", idxs, detailed));
    }
  }

  intermediates.sort((a, b) => a.sortKey - b.sortKey);

  // SOFT: no detailed paragraph — return title + summary + sources only.
  if (!withDetail) {
    opts.log?.(`${intermediates.length} décisions majeures retenues (sans description détaillée)`);
    return intermediates.map((it) => ({ title: it.title, summary: it.summary, detail: "", sources: it.sources }));
  }

  opts.log?.(`${intermediates.length} décisions majeures retenues — rédaction des paragraphes détaillés…`);

  // DEEP: dedicated detail pass per major decision, from its source records.
  const recByMarker = new Map(records.map((r) => [r.marker, r]));
  const majors = await pmap(intermediates, 3, async (it) => {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const sourceRecords = it.markers
      .map((m) => recByMarker.get(m))
      .filter((r): r is MailRecord => !!r);
    const detail = await writeMajorDetail(it.title, it.summary, directives, sourceRecords);
    return { title: it.title, summary: it.summary, detail, sources: it.sources };
  });

  return majors;
}

// ── REDUCE #2: intro + conclusion ──────────────────────────────────────────

async function writeIntroConclusion(
  major: MajorDecision[],
  topic: string,
  directives: string,
  emailsScanned: number,
  detailedCount: number
): Promise<{ intro: string; conclusion: string }> {
  const list = major.map((m) => `- ${m.title} : ${m.summary}`).join("\n") || "(aucune décision majeure)";
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "Tu rédiges pour un membre du personnel dirigeant EPFL. À partir des décisions majeures fournies, " +
        "produis deux textes factuels :\n" +
        "1) INTRODUCTION (2-4 phrases) : le contexte du dossier et la période couverte.\n" +
        "2) SYNTHÈSE : un résumé AUTOPORTANT — quelqu'un doit pouvoir ne lire QUE ça pour savoir où en est le " +
        "dossier et se rafraîchir les idées. Structure-la en markdown avec quelques sous-titres courts " +
        "(format `## Titre`) et des puces concises (par ex. : ## Où en est-on, ## Décisions structurantes, " +
        "## En cours / à venir, ## Points ouverts). PAS de liens, AUCUNE référence aux emails, pas de citations. " +
        "Uniquement du contenu utile et synthétique.\n" +
        'Réponds UNIQUEMENT en JSON : {"intro":"…","conclusion":"…"} où "conclusion" contient le markdown de la synthèse.' +
        directives,
    },
    {
      role: "user",
      content: `Sujet : "${topic}"\n${emailsScanned} emails analysés, ${detailedCount} décisions relevées.\n\nDécisions majeures :\n${list}\n\nRédige l'introduction et la synthèse.`,
    },
  ];
  const resp = await chatCompletion(messages, undefined, 3072);
  const parsed = parseJsonLoose<{ intro: string; conclusion: string }>(llmText(resp));
  return {
    intro:
      parsed?.intro?.trim() ||
      `Ce rapport recense les décisions prises au sujet de « ${topic} », sur la base de ${emailsScanned} emails analysés.`,
    conclusion: parsed?.conclusion?.trim() || "Synthèse non disponible.",
  };
}

function buildChatMarkdown(report: DecisionReport): string {
  const lines: string[] = [];
  lines.push(`## Décisions — ${report.topic}`);
  lines.push("");
  lines.push(report.intro);
  lines.push("");
  lines.push(`### Décisions majeures (${report.major.length})`);
  if (report.major.length === 0) {
    lines.push("_Aucune décision majeure identifiée._");
  } else {
    for (const m of report.major) {
      const n = m.sources.length;
      lines.push(`- **${m.title}** — ${m.summary} _(${n} source${n > 1 ? "s" : ""})_`);
    }
  }
  lines.push("");
  lines.push(`### Synthèse`);
  lines.push(report.conclusion);
  lines.push("");
  const detailNote =
    report.mode === "soft"
      ? `${report.major.length} décisions majeures + chronologie épurée`
      : `${report.detailed.length} décisions détaillées (mail par mail) + ${report.major.length} décisions majeures`;
  lines.push(
    `📄 **Rapport Word téléchargé** (${report.mode === "soft" ? "résumé global" : "résumé approfondi"}) — ${detailNote}, avec liens cliquables vers les sources, sur ${report.emailsScanned} emails analysés.`
  );
  return lines.join("\n");
}

// ── Orchestrator ──────────────────────────────────────────────────────────

export async function extractTopicDecisions(
  topic: string,
  keywords: string[],
  question: string,
  focus: string | undefined,
  language: string | undefined,
  mode: ReportMode,
  startISO: string | undefined,
  endISO: string | undefined,
  opts: PipelineOpts = {}
): Promise<TopicDecisionResult> {
  const log = opts.log ?? (() => {});
  const range = resolveRange(startISO, endISO);
  // Angle + language are decided once and threaded into every LLM pass.
  const directives = buildDirectives(focus, language);
  log(`Mode : ${mode} · période : ${fmtDate(range.startISO)} → ${fmtDate(range.endISO)} · langue : ${language?.trim() || "français"}`);
  opts.onProgress?.({ phase: "search", message: "Recherche des emails par mot-clé…", percent: 5 });

  const records = await retrieveRecords(keywords, question, range, language, mode, opts);
  if (records.length === 0) {
    return {
      topic,
      emailsScanned: 0,
      decisionsExtracted: 0,
      majorCount: 0,
      intro: "",
      conclusion: "",
      chatMarkdown: `Aucun email ni réunion trouvé pour les mots-clés : ${keywords.join(", ")} sur la période.`,
    };
  }

  const detailed = await mapExtract(records, topic, directives, mode === "soft", opts);

  opts.onProgress?.({ phase: "curate", message: "Chronologie épurée — décisions clés…", percent: 68 });
  const curated = await curate(detailed, topic, directives, opts);

  opts.onProgress?.({ phase: "major", message: "Regroupement des décisions majeures…", percent: 76 });
  const major = await selectMajorDecisions(detailed, records, topic, directives, mode === "deep", opts);

  opts.onProgress?.({ phase: "synthesize", message: "Rédaction de l'intro et de la synthèse…", percent: 85 });
  const { intro, conclusion } = await writeIntroConclusion(major, topic, directives, records.length, detailed.length);

  const report: DecisionReport = {
    topic,
    generatedOn: new Date().toLocaleDateString("fr-CH"),
    emailsScanned: records.length,
    intro,
    detailed,
    curated,
    major,
    conclusion,
    language,
    mode,
  };

  opts.onProgress?.({ phase: "export", message: "Génération du document Word…", percent: 95 });
  await exportDecisionReport(report);
  log("Rapport Word généré et téléchargé.");

  return {
    topic,
    emailsScanned: records.length,
    decisionsExtracted: detailed.length,
    majorCount: major.length,
    intro,
    conclusion,
    chatMarkdown: buildChatMarkdown(report),
  };
}
