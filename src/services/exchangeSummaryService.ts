// ─── Exchange Summary (summarize_emails) ────────────────────────────────────
// Summarise the user's exchanges with one or several NAMED people. Same two
// modes as meeting prep:
//   soft → holistic summary (rank by angle → one LLM summary) + per-person
//          clickable sources (MeetingReport layout)
//   deep → reuses EXACTLY the topic/meeting map-reduce core
//          (analyzeRecordsToReport): detailed + condensed timeline + major
//          decisions + synthesis (DecisionReport layout)
//
// Difference vs meeting prep: the people and the angle are chosen by the USER
// (not derived from a calendar event), and there are no keywords — we take all
// the exchanges with each person over the chosen period.

import { chatCompletionStream, ChatMessage } from "./rcpApiService";
import {
  getAllInteractions,
  getServiceDeskEmailsForPerson,
  getMessageAttachments,
  DateRange,
} from "./graphMailService";
import type { EmailMessage } from "./mailTypes";
import { batchEmbed, rankBySimilarity } from "./embeddingService";
import { cleanEmailBodyFull } from "./cleanEmailBody";
import { getAccount } from "./authService";
import { analyzeRecordsToReport, type MailRecord } from "./topicDecisionService";
import {
  exportDecisionReport,
  exportMeetingReport,
  type DecisionReport,
  type MeetingReport,
  type DecisionSource,
  type MeetingParticipantBlock,
} from "./exportService";

const loadAttachmentService = () => import("./attachmentService");

const MAX_PER_DIRECTION = 200;
const PER_MAIL_BODY_CHARS = 16000;
const ATTACH_BUDGET = 6000;
const SOFT_TOP = 50;
const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;

export interface Person {
  name: string;
  email: string;
}

export interface SummarizeExchangesOptions {
  people: Person[];
  mode: "soft" | "deep";
  focus?: string; // angle d'attaque (optionnel)
  language?: string;
  startISO?: string;
  endISO?: string;
}

export interface SummarizeExchangesResult {
  mode: "soft" | "deep";
  peopleCount: number;
  emailsScanned: number;
  chatMarkdown: string;
  reportDownloaded: boolean;
}

interface Callbacks {
  log?: (msg: string) => void;
  onProgress?: (msg: string, percent?: number) => void;
  onStream?: (chunk: string) => void;
  signal?: AbortSignal;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso?.slice(0, 10) || "?" : d.toLocaleDateString("fr-CH");
}

function langLine(language?: string): string {
  return `\nLANGUE DE RÉDACTION : produis TOUTE ta sortie rédigée en ${language?.trim() || "français"}.`;
}

/** Collect + dedup + build records for ONE person over the period. */
async function collectPersonRecords(
  person: Person,
  range: DateRange,
  seenIds: Set<string>,
  startMarker: number,
  cb: Callbacks
): Promise<MailRecord[]> {
  const log = cb.log ?? (() => {});
  const [{ received, sent }, sd] = await Promise.all([
    getAllInteractions(person.email, MAX_PER_DIRECTION, range),
    getServiceDeskEmailsForPerson(person.name, MAX_PER_DIRECTION, range).catch(() => [] as EmailMessage[]),
  ]);
  log(`${person.name} : ${received.length} reçus, ${sent.length} envoyés, ${sd.length} ServiceDesk`);

  type Tagged = { e: EmailMessage; direction: "received" | "sent" | "sd" };
  const tagged: Tagged[] = [
    ...received.map((e) => ({ e, direction: "received" as const })),
    ...sent.map((e) => ({ e, direction: "sent" as const })),
    ...(sd as EmailMessage[]).map((e) => ({ e, direction: "sd" as const })),
  ];

  // Dedup by id (across all people too) then by conversation (keep latest).
  const byConv = new Map<string, Tagged>();
  const noConv: Tagged[] = [];
  for (const t of tagged) {
    if (seenIds.has(t.e.id)) continue;
    seenIds.add(t.e.id);
    const conv = (t.e as { conversationId?: string }).conversationId;
    if (!conv) {
      noConv.push(t);
      continue;
    }
    const cur = byConv.get(conv);
    const tDate = new Date(t.e.sentDateTime || t.e.receivedDateTime).getTime();
    if (!cur || tDate > new Date(cur.e.sentDateTime || cur.e.receivedDateTime).getTime()) byConv.set(conv, t);
  }
  const kept = [...byConv.values(), ...noConv];

  let marker = startMarker;
  const records: MailRecord[] = [];
  for (const { e, direction } of kept) {
    if (cb.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const iso = direction === "sent" ? e.sentDateTime || e.receivedDateTime : e.receivedDateTime;
    let body = cleanEmailBodyFull(e.body?.content || e.bodyPreview || "").slice(0, PER_MAIL_BODY_CHARS);
    if (e.hasAttachments) {
      try {
        const atts = await getMessageAttachments(e.id);
        const { extractTextFromAttachments } = await loadAttachmentService();
        const texts = await extractTextFromAttachments(atts as any, ATTACH_BUDGET, { onProgress: () => {} });
        if (texts.length > 0) body += "\n\nPIÈCES JOINTES :\n" + texts.map((t) => `# ${t.name}\n${t.text}`).join("\n\n");
      } catch {
        /* keep body alone */
      }
    }
    const participants =
      direction === "received" ? `${person.name} → Moi` : direction === "sent" ? `Moi → ${person.name}` : `[ServiceDesk] ${person.name}`;
    records.push({
      marker: `E${marker++}`,
      id: e.id,
      kind: "email",
      date: fmtDate(iso),
      sortKey: new Date(iso).getTime() || 0,
      participants,
      subject: direction === "sd" ? `[ServiceNow] ${e.subject || "(sans objet)"}` : e.subject || "(sans objet)",
      webLink: e.webLink,
      body,
    });
  }
  return records;
}

function toSource(r: MailRecord): DecisionSource {
  return { date: r.date, subject: r.subject, webLink: r.webLink };
}

/** Run async tasks with bounded concurrency, preserving order. */
async function pmap<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

export async function summarizeExchanges(opts: SummarizeExchangesOptions, cb: Callbacks = {}): Promise<SummarizeExchangesResult> {
  const log = cb.log ?? (() => {});
  const names = opts.people.map((p) => p.name).join(", ");
  const range: DateRange = {
    startDate: opts.startISO || new Date(Date.now() - SIX_MONTHS_MS).toISOString(),
    endDate: opts.endISO || new Date().toISOString(),
  };
  log(`Résumé des échanges avec ${names} — mode ${opts.mode}, ${fmtDate(range.startDate!)} → ${fmtDate(range.endDate!)}`);
  cb.onProgress?.("Collecte des emails par personne…", 5);

  // Collect per person (sequential to respect Graph throttling), keep grouping.
  const seenIds = new Set<string>();
  const perPerson: { person: Person; recs: MailRecord[] }[] = [];
  let markerBase = 0;
  for (const person of opts.people) {
    const recs = await collectPersonRecords(person, range, seenIds, markerBase, cb);
    markerBase += recs.length;
    perPerson.push({ person, recs });
  }
  const allRecords = perPerson.flatMap((p) => p.recs);
  if (allRecords.length === 0) {
    const md = `Aucun email trouvé avec ${names} sur la période.`;
    cb.onStream?.(md);
    return { mode: opts.mode, peopleCount: opts.people.length, emailsScanned: 0, chatMarkdown: md, reportDownloaded: false };
  }
  log(`${allRecords.length} emails à analyser au total`);

  if (opts.mode === "deep") {
    return await runDeep(opts, names, perPerson, allRecords, range, cb);
  }
  return await runSoft(opts, names, perPerson, allRecords, cb);
}

// ── DEEP: reuse the shared map-reduce core ──────────────────────────────────
async function runDeep(
  opts: SummarizeExchangesOptions,
  names: string,
  _perPerson: { person: Person; recs: MailRecord[] }[],
  allRecords: MailRecord[],
  _range: DateRange,
  cb: Callbacks
): Promise<SummarizeExchangesResult> {
  const topic = `les échanges avec ${names}`;
  const { detailed, curated, major, intro, conclusion } = await analyzeRecordsToReport(allRecords, {
    topic,
    focus: opts.focus,
    language: opts.language,
    ignoreMinor: false,
    withDetailParagraph: true,
    withCurated: true, // deep summarize keeps the condensed timeline
    relevanceHint: opts.focus?.trim() || undefined, // filter only if the user gave an angle
    onProgress: (p) => cb.onProgress?.(p.message, p.percent),
    log: cb.log,
    signal: cb.signal,
  });

  const decisionReport: DecisionReport = {
    topic,
    title: `Résumé approfondi — ${names}`,
    generatedOn: new Date().toLocaleDateString("fr-CH"),
    emailsScanned: allRecords.length,
    intro,
    detailed,
    curated,
    major,
    conclusion,
    language: opts.language,
    mode: "deep",
  };

  cb.onProgress?.("Génération du document Word…", 95);
  let reportDownloaded = false;
  try {
    await exportDecisionReport(decisionReport);
    reportDownloaded = true;
  } catch (e) {
    cb.log?.(`Échec rapport Word : ${e instanceof Error ? e.message : String(e)}`);
  }

  const lines = [
    `## Résumé approfondi — ${names}`,
    "",
    intro,
    "",
    `### Décisions / points majeurs (${major.length})`,
    ...major.map((m) => `- **${m.title}** — ${m.summary}`),
    "",
    `### Synthèse`,
    conclusion,
    "",
    `📄 **Rapport Word téléchargé** — chronologie détaillée + épurée + ${major.length} points majeurs + synthèse, avec liens cliquables, sur ${allRecords.length} emails.`,
  ];
  const chatMarkdown = lines.join("\n");
  cb.onStream?.(chatMarkdown);
  return { mode: "deep", peopleCount: opts.people.length, emailsScanned: allRecords.length, chatMarkdown, reportDownloaded };
}

// ── SOFT: holistic summary + per-person clickable sources ───────────────────
async function runSoft(
  opts: SummarizeExchangesOptions,
  names: string,
  perPerson: { person: Person; recs: MailRecord[] }[],
  allRecords: MailRecord[],
  cb: Callbacks
): Promise<SummarizeExchangesResult> {
  cb.onProgress?.("Classement par pertinence…", 40);
  const query = opts.focus?.trim() || `échanges avec ${names}`;
  const texts = allRecords.map((r) => `${r.subject}\n${r.body.slice(0, 8000)}`);
  const [qEmb, ...itemEmbs] = await batchEmbed([query, ...texts]);
  const ranked = rankBySimilarity(qEmb, itemEmbs);
  const top = ranked.slice(0, Math.min(SOFT_TOP, allRecords.length)).map((r) => allRecords[r.index]);
  top.sort((a, b) => b.sortKey - a.sortKey);

  const digest = top.map((r) => `[${r.date}] ${r.participants} | ${r.subject}\n${r.body}`).join("\n---\n");
  const account = getAccount() as { name?: string; username?: string } | null;
  const selfName = account?.name || account?.username || "l'utilisateur";

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `Tu résumes pour ${selfName} ses échanges email avec : ${names}. ` +
        "Écris pour cette personne (à la 2e personne, « vous »), de façon factuelle et structurée. " +
        (opts.focus?.trim()
          ? `ANGLE D'ATTAQUE prioritaire : « ${opts.focus.trim()} » — mets en avant ce qui s'y rapporte. `
          : "") +
        "Inclus : sujets abordés, décisions prises, points en suspens, prochaines étapes / to-dos. " +
        "Markdown (titres, puces, tableaux si pertinent), pas de bloc de code." +
        langLine(opts.language),
    },
    {
      role: "user",
      content: `Échanges avec ${names} (les plus pertinents) :\n\n${digest}\n\nRédige le résumé.`,
    },
  ];

  cb.onProgress?.("Rédaction du résumé…", 70);
  let summary = "";
  await chatCompletionStream(messages, (chunk) => {
    summary += chunk;
    cb.onStream?.(chunk);
  }, undefined, cb.signal);

  const report: MeetingReport = {
    subject: names,
    title: `Résumé des échanges — ${names}`,
    date: new Date().toLocaleDateString("fr-CH"),
    generatedOn: new Date().toLocaleDateString("fr-CH"),
    briefing: summary,
    participants: perPerson.map(
      (p): MeetingParticipantBlock => ({
        name: p.person.name,
        sources: p.recs.slice().sort((a, b) => b.sortKey - a.sortKey).map(toSource),
      })
    ),
    externalSources: [],
    meetingDocs: [],
    language: opts.language,
    mode: "soft",
  };

  cb.onProgress?.("Génération du document Word…", 95);
  let reportDownloaded = false;
  try {
    await exportMeetingReport(report);
    reportDownloaded = true;
  } catch (e) {
    cb.log?.(`Échec rapport Word : ${e instanceof Error ? e.message : String(e)}`);
  }

  cb.onStream?.(
    `\n\n📄 **Rapport Word téléchargé** — résumé + emails sources cliquables par personne (${allRecords.length} emails analysés).`
  );
  const chatMarkdown = summary;
  return { mode: "soft", peopleCount: opts.people.length, emailsScanned: allRecords.length, chatMarkdown, reportDownloaded };
}
