import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  ExternalHyperlink,
} from "docx";
import { marked } from "marked";

interface ExportMetadata {
  date?: string;
  attendees?: string[];
}

/** Build a standalone HTML document from markdown briefing content. */
function buildHtmlDocument(
  markdown: string,
  title: string,
  metadata?: ExportMetadata
): string {
  // Strip ```markdown wrapper if present
  let content = markdown;
  const codeBlockMatch = content.match(
    /^```(?:markdown)?\s*\n([\s\S]*?)(?:\n```\s*)?$/
  );
  if (codeBlockMatch) {
    content = codeBlockMatch[1];
  }

  const bodyHtml = marked.parse(content) as string;

  let metaHtml = "";
  if (metadata?.date) {
    metaHtml += `<p class="meta">${metadata.date}</p>`;
  }
  if (metadata?.attendees && metadata.attendees.length > 0) {
    metaHtml += `<p class="meta">Participants : ${metadata.attendees.join(", ")}</p>`;
  }

  return `<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="utf-8"/>
<title>${title} — EPFL Mail AI</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    font-size: 14px; line-height: 1.7; color: #24292f;
    max-width: 820px; margin: 0 auto; padding: 32px 24px;
    background: #fff;
  }
  .header { text-align: center; margin-bottom: 24px; }
  .header h1 { font-size: 22px; font-weight: 600; color: #24292f; margin: 0 0 8px; }
  .meta { color: #656d76; font-size: 13px; font-style: italic; margin: 2px 0; }
  .divider { border: none; border-top: 2px solid #d0d7de; margin: 20px 0; }
  h2 { font-size: 17px; font-weight: 600; margin: 24px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #d8dee4; color: #24292f; }
  h3 { font-size: 15px; font-weight: 600; margin: 18px 0 8px; color: #24292f; }
  h4 { font-size: 14px; font-weight: 600; margin: 14px 0 6px; }
  p { margin: 6px 0; }
  ul, ol { padding-left: 24px; margin: 6px 0; }
  li { margin-bottom: 4px; }
  strong { font-weight: 600; }
  em { font-style: italic; }
  hr { border: none; border-top: 1px solid #d8dee4; margin: 16px 0; }
  code { background: #f6f8fa; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  blockquote { border-left: 3px solid #d0d7de; margin: 8px 0; padding: 4px 16px; color: #656d76; }
  .footer { text-align: center; color: #8b949e; font-size: 11px; margin-top: 32px; border-top: 1px solid #d8dee4; padding-top: 12px; }
  @media print { body { padding: 16px; } .footer { display: none; } }
</style>
</head><body>
<div class="header">
  <h1>${title}</h1>
  ${metaHtml}
</div>
<hr class="divider"/>
${bodyHtml}
<div class="footer">Généré par EPFL Mail AI</div>
</body></html>`;
}

/**
 * Export briefing as PDF via the browser's print dialog.
 */
/**
 * Export briefing as a standalone HTML file.
 */
export function exportToHtml(
  markdown: string,
  title: string,
  metadata?: ExportMetadata
): void {
  const htmlDoc = buildHtmlDocument(markdown, title, metadata);
  const blob = new Blob([htmlDoc], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
}

/**
 * Export markdown content to a Word (.docx) document.
 */
export async function exportToWord(
  markdown: string,
  title: string,
  metadata?: { date?: string; attendees?: string[] }
): Promise<void> {
  // Strip ```markdown wrapper if present
  let content = markdown;
  const codeBlockMatch = content.match(
    /^```(?:markdown)?\s*\n([\s\S]*?)(?:\n```\s*)?$/
  );
  if (codeBlockMatch) {
    content = codeBlockMatch[1];
  }

  const children: Paragraph[] = [];

  // Title
  children.push(
    new Paragraph({
      children: [new TextRun({ text: title, bold: true, size: 32 })],
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
    })
  );

  // Metadata
  if (metadata?.date) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: metadata.date, italics: true, color: "666666" }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: { after: 100 },
      })
    );
  }
  if (metadata?.attendees && metadata.attendees.length > 0) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Participants : ${metadata.attendees.join(", ")}`,
            italics: true,
            color: "666666",
          }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: { after: 300 },
      })
    );
  }

  // Parse markdown lines into docx paragraphs
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Skip empty lines
    if (trimmed === "") {
      children.push(new Paragraph({ spacing: { after: 100 } }));
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(trimmed)) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: "─".repeat(50), color: "CCCCCC" })],
          spacing: { before: 200, after: 200 },
        })
      );
      continue;
    }

    // Headings
    const h1Match = trimmed.match(/^# (.+)/);
    if (h1Match) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: h1Match[1], bold: true, size: 28 })],
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 300, after: 100 },
        })
      );
      continue;
    }

    const h2Match = trimmed.match(/^## (.+)/);
    if (h2Match) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: h2Match[1], bold: true, size: 24 })],
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 250, after: 80 },
        })
      );
      continue;
    }

    const h3Match = trimmed.match(/^### (.+)/);
    if (h3Match) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: h3Match[1], bold: true, size: 22 })],
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 200, after: 60 },
        })
      );
      continue;
    }

    // Bullet list items
    const bulletMatch = trimmed.match(/^[-*] (.+)/);
    if (bulletMatch) {
      children.push(
        new Paragraph({
          children: parseInlineFormatting(bulletMatch[1]),
          bullet: { level: 0 },
          spacing: { after: 40 },
        })
      );
      continue;
    }

    // Numbered list items
    const numberedMatch = trimmed.match(/^\d+\. (.+)/);
    if (numberedMatch) {
      children.push(
        new Paragraph({
          children: parseInlineFormatting(numberedMatch[1]),
          bullet: { level: 0 },
          spacing: { after: 40 },
        })
      );
      continue;
    }

    // Regular paragraph
    children.push(
      new Paragraph({
        children: parseInlineFormatting(trimmed),
        spacing: { after: 80 },
      })
    );
  }

  const doc = new Document({
    sections: [{ children }],
  });

  const blob = await Packer.toBlob(doc);
  downloadBlob(blob, `${title}.docx`);
}

/**
 * Parse inline markdown formatting (**bold**, *italic*) into TextRun elements.
 */
function parseInlineFormatting(text: string): TextRun[] {
  const runs: TextRun[] = [];
  // Match **bold**, *italic*, and plain text segments
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|([^*]+))/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match[2]) {
      // **bold**
      runs.push(new TextRun({ text: match[2], bold: true }));
    } else if (match[3]) {
      // *italic*
      runs.push(new TextRun({ text: match[3], italics: true }));
    } else if (match[4]) {
      // plain text
      runs.push(new TextRun({ text: match[4] }));
    }
  }

  if (runs.length === 0) {
    runs.push(new TextRun({ text }));
  }

  return runs;
}

// ─── Decision report (extract_topic_decisions) ─────────────────────────

/** One extracted decision, with its source email for citation. */
export interface DecisionEntry {
  date: string; // display string, e.g. "04/03/2026"
  sortKey: number; // epoch ms for chronological ordering
  participants: string;
  subject: string;
  decision: string;
  citation?: string;
  webLink?: string; // OWA deep link to the source email
  marker?: string; // internal: source record marker (to trace back to full text)
  attachmentsTruncated?: boolean; // source mail had a partially-analysed attachment
}

/** A source email backing a major decision (one of several that mention it). */
export interface DecisionSource {
  date: string;
  subject: string;
  webLink?: string;
}

/** A major decision in 3 readable tiers + every email/meeting that mentions it. */
export interface MajorDecision {
  title: string; // readable in 2 seconds
  summary: string; // one short paragraph
  detail: string; // fully detailed paragraph (dedicated LLM pass over the sources)
  sources: DecisionSource[];
}

export interface DecisionReport {
  topic: string;
  generatedOn: string; // display date
  emailsScanned: number;
  intro: string; // plain text / light markdown
  detailed: DecisionEntry[]; // §1 — exhaustive, mail by mail
  curated: DecisionEntry[]; // §2 — chronologie épurée (décisions clés, 1 lien chacune)
  major: MajorDecision[]; // §3 — décisions majeures (regroupées, multi-sources)
  conclusion: string; // §4 — structured self-contained synthesis (markdown, no links)
  language?: string; // report language (localises the static labels below)
  mode?: "deep" | "soft"; // "soft" omits the §1 detailed mail-by-mail timeline
}

/** One participant block of a meeting-prep report: name + profile + clickable sources. */
export interface MeetingParticipantBlock {
  name: string;
  profile?: string; // "jobTitle, department"
  sources: DecisionSource[];
}

export interface MeetingReport {
  subject: string;
  date: string; // display date of the meeting
  generatedOn: string;
  briefing: string; // synthesised briefing (markdown, language + angle aware)
  participants: MeetingParticipantBlock[];
  externalSources: DecisionSource[]; // non-participant emails used as context
  meetingDocs: string[]; // attachment names joined to the event
  language?: string;
  mode?: "deep" | "soft";
}

// ─── Static-label localisation ─────────────────────────────────────────
// The LLM-generated content follows the run's `language`; these structural
// labels do too, via a small map. Unknown languages fall back to English,
// empty/French to French.
type Locale = "fr" | "en" | "de" | "it" | "es";

interface ReportLabels {
  fileWord: string;
  titlePrefix: string;
  meta: (date: string, emails: number, decisions: number) => string;
  secIntro: string;
  secDetailed: string;
  secCurated: string;
  secMajor: string;
  secSynthesis: string;
  lblGeneral: string;
  lblDetail: string;
  lblMentioned: string;
  lblSource: string;
  openEmail: (subject: string) => string;
  openGeneric: string;
  linkUnavailable: string;
  none: string;
  dash: string;
  meetingTag: string;
  attachmentTruncated: string;
  // Meeting-prep report
  mtgFileWord: string;
  mtgTitlePrefix: string;
  mtgMeta: (date: string, participants: number) => string;
  secBriefing: string;
  secParticipants: string;
  secExternalContext: string;
  secMeetingDocs: string;
  lblSourceEmails: string;
}

const LABELS: Record<Locale, ReportLabels> = {
  fr: {
    fileWord: "Décisions",
    titlePrefix: "Décisions — ",
    meta: (d, e, dec) => `Généré le ${d} · ${e} emails analysés · ${dec} décisions relevées`,
    secIntro: "Introduction",
    secDetailed: "Chronologie détaillée",
    secCurated: "Chronologie épurée — décisions clés",
    secMajor: "Décisions majeures",
    secSynthesis: "Synthèse",
    lblGeneral: "Description générale — ",
    lblDetail: "Description détaillée",
    lblMentioned: "Mentionnée dans :",
    lblSource: "Source — ",
    openEmail: (s) => `Ouvrir l'email : ${s}`,
    openGeneric: "Ouvrir l'email source",
    linkUnavailable: "(lien indisponible)",
    none: "Aucune décision relevée.",
    dash: "—",
    meetingTag: "[Réunion]",
    attachmentTruncated: "⚠ Pièce jointe partiellement analysée (tronquée) — voir l'email source pour le contenu complet.",
    mtgFileWord: "Préparation",
    mtgTitlePrefix: "Préparation de réunion — ",
    mtgMeta: (d, n) => `Réunion du ${d} · ${n} participant(s)`,
    secBriefing: "Briefing",
    secParticipants: "Par participant",
    secExternalContext: "Contexte externe (hors participants)",
    secMeetingDocs: "Documents joints à la réunion",
    lblSourceEmails: "Emails sources :",
  },
  en: {
    fileWord: "Decisions",
    titlePrefix: "Decisions — ",
    meta: (d, e, dec) => `Generated on ${d} · ${e} emails analysed · ${dec} decisions found`,
    secIntro: "Introduction",
    secDetailed: "Detailed timeline",
    secCurated: "Condensed timeline — key decisions",
    secMajor: "Major decisions",
    secSynthesis: "Summary",
    lblGeneral: "Overview — ",
    lblDetail: "Detailed description",
    lblMentioned: "Mentioned in:",
    lblSource: "Source — ",
    openEmail: (s) => `Open the email: ${s}`,
    openGeneric: "Open the source email",
    linkUnavailable: "(link unavailable)",
    none: "No decision found.",
    dash: "—",
    meetingTag: "[Meeting]",
    attachmentTruncated: "⚠ Attachment partially analysed (truncated) — see the source email for the full content.",
    mtgFileWord: "Meeting-prep",
    mtgTitlePrefix: "Meeting preparation — ",
    mtgMeta: (d, n) => `Meeting on ${d} · ${n} participant(s)`,
    secBriefing: "Briefing",
    secParticipants: "By participant",
    secExternalContext: "External context (non-participants)",
    secMeetingDocs: "Meeting attachments",
    lblSourceEmails: "Source emails:",
  },
  de: {
    fileWord: "Entscheidungen",
    titlePrefix: "Entscheidungen — ",
    meta: (d, e, dec) => `Erstellt am ${d} · ${e} E-Mails analysiert · ${dec} Entscheidungen erfasst`,
    secIntro: "Einleitung",
    secDetailed: "Detaillierte Chronologie",
    secCurated: "Verdichtete Chronologie — Schlüsselentscheidungen",
    secMajor: "Wesentliche Entscheidungen",
    secSynthesis: "Zusammenfassung",
    lblGeneral: "Überblick — ",
    lblDetail: "Detaillierte Beschreibung",
    lblMentioned: "Erwähnt in:",
    lblSource: "Quelle — ",
    openEmail: (s) => `E-Mail öffnen: ${s}`,
    openGeneric: "Quell-E-Mail öffnen",
    linkUnavailable: "(Link nicht verfügbar)",
    none: "Keine Entscheidung gefunden.",
    dash: "—",
    meetingTag: "[Besprechung]",
    attachmentTruncated: "⚠ Anhang teilweise analysiert (gekürzt) — vollständiger Inhalt in der Quell-E-Mail.",
    mtgFileWord: "Besprechungsvorbereitung",
    mtgTitlePrefix: "Besprechungsvorbereitung — ",
    mtgMeta: (d, n) => `Besprechung am ${d} · ${n} Teilnehmer`,
    secBriefing: "Briefing",
    secParticipants: "Nach Teilnehmer",
    secExternalContext: "Externer Kontext (Nicht-Teilnehmer)",
    secMeetingDocs: "Besprechungsanhänge",
    lblSourceEmails: "Quell-E-Mails:",
  },
  it: {
    fileWord: "Decisioni",
    titlePrefix: "Decisioni — ",
    meta: (d, e, dec) => `Generato il ${d} · ${e} email analizzate · ${dec} decisioni rilevate`,
    secIntro: "Introduzione",
    secDetailed: "Cronologia dettagliata",
    secCurated: "Cronologia sintetica — decisioni chiave",
    secMajor: "Decisioni principali",
    secSynthesis: "Sintesi",
    lblGeneral: "Descrizione generale — ",
    lblDetail: "Descrizione dettagliata",
    lblMentioned: "Menzionata in:",
    lblSource: "Fonte — ",
    openEmail: (s) => `Apri l'email: ${s}`,
    openGeneric: "Apri l'email di origine",
    linkUnavailable: "(link non disponibile)",
    none: "Nessuna decisione rilevata.",
    dash: "—",
    meetingTag: "[Riunione]",
    attachmentTruncated: "⚠ Allegato analizzato solo in parte (troncato) — vedere l'email di origine per il contenuto completo.",
    mtgFileWord: "Preparazione-riunione",
    mtgTitlePrefix: "Preparazione riunione — ",
    mtgMeta: (d, n) => `Riunione del ${d} · ${n} partecipante/i`,
    secBriefing: "Briefing",
    secParticipants: "Per partecipante",
    secExternalContext: "Contesto esterno (non partecipanti)",
    secMeetingDocs: "Allegati della riunione",
    lblSourceEmails: "Email di origine:",
  },
  es: {
    fileWord: "Decisiones",
    titlePrefix: "Decisiones — ",
    meta: (d, e, dec) => `Generado el ${d} · ${e} correos analizados · ${dec} decisiones detectadas`,
    secIntro: "Introducción",
    secDetailed: "Cronología detallada",
    secCurated: "Cronología resumida — decisiones clave",
    secMajor: "Decisiones principales",
    secSynthesis: "Síntesis",
    lblGeneral: "Descripción general — ",
    lblDetail: "Descripción detallada",
    lblMentioned: "Mencionada en:",
    lblSource: "Fuente — ",
    openEmail: (s) => `Abrir el correo: ${s}`,
    openGeneric: "Abrir el correo de origen",
    linkUnavailable: "(enlace no disponible)",
    none: "Ninguna decisión detectada.",
    dash: "—",
    meetingTag: "[Reunión]",
    attachmentTruncated: "⚠ Adjunto analizado parcialmente (truncado) — consulte el correo de origen para el contenido completo.",
    mtgFileWord: "Preparacion-reunion",
    mtgTitlePrefix: "Preparación de reunión — ",
    mtgMeta: (d, n) => `Reunión del ${d} · ${n} participante(s)`,
    secBriefing: "Briefing",
    secParticipants: "Por participante",
    secExternalContext: "Contexto externo (no participantes)",
    secMeetingDocs: "Adjuntos de la reunión",
    lblSourceEmails: "Correos de origen:",
  },
};

function resolveLocale(language?: string): Locale {
  const l = (language || "").toLowerCase();
  if (!l || /fran|french/.test(l) || /^fr\b/.test(l)) return "fr";
  if (/deutsch|german|allemand/.test(l) || /^de\b/.test(l)) return "de";
  if (/ital/.test(l) || /^it\b/.test(l)) return "it";
  if (/espa|spanish|castell/.test(l) || /^es\b/.test(l)) return "es";
  if (/angl|english/.test(l) || /^en\b/.test(l)) return "en";
  return "en"; // unknown non-French → English labels
}

/** Localised static labels for a given report language. */
export function reportLabels(language?: string): ReportLabels {
  return LABELS[resolveLocale(language)];
}

// Clean sans-serif available everywhere on Windows/Office (same as the add-in UI).
// Avoids Word's Times New Roman default. Söhne/Tiempos (Claude's UI fonts) are
// proprietary and not installed locally, so Word would substitute them anyway.
const REPORT_FONT = "Segoe UI";

/** A light dashed rule used to separate consecutive decision entries. */
function separatorParagraph(): Paragraph {
  return new Paragraph({
    spacing: { before: 60, after: 60 },
    children: [new TextRun({ text: "-".repeat(70), color: "BBBBBB" })],
  });
}

/** A clickable "open email" hyperlink run, or a plain note if no link. */
function sourceParagraph(entry: DecisionEntry, L: ReportLabels): Paragraph {
  const label = entry.subject ? L.openEmail(entry.subject) : L.openGeneric;
  if (entry.webLink) {
    return new Paragraph({
      spacing: { after: 120 },
      children: [
        new TextRun({ text: L.lblSource, size: 18, color: "666666", font: REPORT_FONT }),
        new ExternalHyperlink({
          link: entry.webLink,
          children: [
            new TextRun({ text: label, size: 18, color: "0563C1", underline: {}, font: REPORT_FONT }),
          ],
        }),
      ],
    });
  }
  return new Paragraph({
    spacing: { after: 120 },
    children: [
      new TextRun({ text: `${L.lblSource}${entry.subject || ""} ${L.linkUnavailable}`, size: 18, italics: true, color: "999999", font: REPORT_FONT }),
    ],
  });
}

/** Render a decision entry as a small block of paragraphs (header / decision / quote / source). */
function decisionBlock(entry: DecisionEntry, L: ReportLabels): Paragraph[] {
  const blocks: Paragraph[] = [];
  blocks.push(
    new Paragraph({
      spacing: { before: 120, after: 20 },
      children: [
        new TextRun({ text: `${entry.date}`, bold: true, font: REPORT_FONT }),
        new TextRun({ text: `  ·  ${entry.participants}`, color: "666666", font: REPORT_FONT }),
      ],
    })
  );
  blocks.push(
    new Paragraph({
      spacing: { after: 20 },
      children: [new TextRun({ text: entry.decision, font: REPORT_FONT })],
    })
  );
  if (entry.citation && entry.citation.trim()) {
    blocks.push(
      new Paragraph({
        spacing: { after: 20 },
        indent: { left: 360 },
        children: [new TextRun({ text: `« ${entry.citation.trim()} »`, italics: true, color: "555555", font: REPORT_FONT })],
      })
    );
  }
  blocks.push(sourceParagraph(entry, L));
  if (entry.attachmentsTruncated) {
    blocks.push(
      new Paragraph({
        spacing: { after: 120 },
        children: [new TextRun({ text: L.attachmentTruncated, size: 18, italics: true, color: "B25E00", font: REPORT_FONT })],
      })
    );
  }
  return blocks;
}

/** A single source email as a clickable bullet line ("date — subject"). */
function sourceLink(s: DecisionSource, L: ReportLabels): Paragraph {
  const label = `${s.date} — ${s.subject || ""}`.trim();
  if (s.webLink) {
    return new Paragraph({
      bullet: { level: 0 },
      spacing: { after: 20 },
      children: [
        new ExternalHyperlink({
          link: s.webLink,
          children: [new TextRun({ text: label, size: 18, color: "0563C1", underline: {}, font: REPORT_FONT })],
        }),
      ],
    });
  }
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 20 },
    children: [new TextRun({ text: `${label} ${L.linkUnavailable}`, size: 18, italics: true, color: "999999", font: REPORT_FONT })],
  });
}

/**
 * Render one major decision in 3 readable tiers (no heavy bold):
 *   1. a colored title — scannable in 2 seconds
 *   2. a short summary paragraph
 *   3. a fully detailed paragraph
 * then the emails/meetings that mention it.
 */
function majorDecisionBlock(m: MajorDecision, index: number, L: ReportLabels): Paragraph[] {
  const out: Paragraph[] = [];
  // Tier 1 — title: distinct via size + colour, NOT bold.
  out.push(
    new Paragraph({
      spacing: { before: 200, after: 60 },
      children: [new TextRun({ text: `${index}. ${m.title}`, size: 26, color: "1F4E79", font: REPORT_FONT })],
    })
  );
  // Tier 2 — short summary, labelled.
  if (m.summary?.trim()) {
    out.push(
      new Paragraph({
        spacing: { after: 60 },
        children: [
          new TextRun({ text: L.lblGeneral, bold: true, font: REPORT_FONT }),
          ...parseInlineFormatting(m.summary.trim()),
        ],
      })
    );
  }
  // Tier 3 — detailed paragraph(s), labelled and allowed light structure (bullets).
  if (m.detail?.trim()) {
    out.push(
      new Paragraph({
        spacing: { before: 40, after: 40 },
        children: [new TextRun({ text: L.lblDetail, bold: true, font: REPORT_FONT })],
      })
    );
    out.push(...richTextBlock(m.detail));
  }
  if (m.sources.length > 0) {
    out.push(
      new Paragraph({
        spacing: { after: 20 },
        children: [new TextRun({ text: L.lblMentioned, italics: true, size: 18, color: "666666", font: REPORT_FONT })],
      })
    );
    for (const s of m.sources) out.push(sourceLink(s, L));
  }
  return out;
}

/** Render the major-decisions list with a separator between entries. */
function majorList(items: MajorDecision[], L: ReportLabels): Paragraph[] {
  const out: Paragraph[] = [];
  items.forEach((m, i) => {
    if (i > 0) out.push(separatorParagraph());
    out.push(...majorDecisionBlock(m, i + 1, L));
  });
  return out;
}

/**
 * Render light markdown (## headings, - bullets, **bold**) into paragraphs.
 * Used for the structured, self-contained conclusion.
 */
function richTextBlock(md: string): Paragraph[] {
  let content = md.replace(/^```(?:markdown)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  const out: Paragraph[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const h = line.match(/^#{1,6}\s+(.*)/);
    if (h) {
      out.push(
        new Paragraph({
          spacing: { before: 180, after: 60 },
          children: [new TextRun({ text: h[1], bold: true, size: 22, font: REPORT_FONT })],
        })
      );
      continue;
    }
    const b = line.match(/^[-*]\s+(.*)/);
    if (b) {
      out.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: parseInlineFormatting(b[1]) }));
      continue;
    }
    out.push(new Paragraph({ spacing: { after: 100 }, children: parseInlineFormatting(line) }));
  }
  if (out.length === 0) out.push(new Paragraph({ children: [new TextRun({ text: "—" })] }));
  return out;
}

/** Push a free-text block (split on blank lines → paragraphs). */
function textBlock(text: string): Paragraph[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .map(
      (p) =>
        new Paragraph({
          spacing: { after: 120 },
          children: parseInlineFormatting(p),
        })
    );
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 26, font: REPORT_FONT })],
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 140 },
  });
}

/** Render the §1/§2 decision list with a dashed separator between entries. */
function decisionList(entries: DecisionEntry[], L: ReportLabels): Paragraph[] {
  const out: Paragraph[] = [];
  entries.forEach((e, i) => {
    if (i > 0) out.push(separatorParagraph());
    out.push(...decisionBlock(e, L));
  });
  return out;
}

/**
 * Build and download the structured decision report as a .docx with clickable
 * email source links. Sections: Introduction, detailed timeline, condensed
 * timeline, major decisions, summary. Static labels follow report.language.
 */
export async function exportDecisionReport(report: DecisionReport): Promise<void> {
  const L = reportLabels(report.language);
  const children: Paragraph[] = [];

  children.push(
    new Paragraph({
      children: [new TextRun({ text: `${L.titlePrefix}${report.topic}`, bold: true, size: 34, font: REPORT_FONT })],
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
    })
  );
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: L.meta(report.generatedOn, report.emailsScanned, report.detailed.length),
          italics: true,
          color: "666666",
          size: 18,
          font: REPORT_FONT,
        }),
      ],
    })
  );

  // §0 Introduction
  children.push(sectionHeading(L.secIntro));
  children.push(...textBlock(report.intro || L.dash));

  // §1 Detailed timeline (mail by mail) — DEEP only.
  if (report.mode !== "soft") {
    children.push(sectionHeading(L.secDetailed));
    if (report.detailed.length === 0) {
      children.push(new Paragraph({ children: [new TextRun({ text: L.none, font: REPORT_FONT })] }));
    } else {
      children.push(...decisionList(report.detailed, L));
    }
  }

  // §2 Condensed timeline (key decisions)
  children.push(sectionHeading(L.secCurated));
  if (report.curated.length === 0) {
    children.push(new Paragraph({ children: [new TextRun({ text: L.dash, font: REPORT_FONT })] }));
  } else {
    children.push(...decisionList(report.curated, L));
  }

  // §3 Major decisions (grouped, multi-source)
  children.push(sectionHeading(L.secMajor));
  if (report.major.length === 0) {
    children.push(new Paragraph({ children: [new TextRun({ text: L.dash, font: REPORT_FONT })] }));
  } else {
    children.push(...majorList(report.major, L));
  }

  // §4 Summary (self-contained, structured, no links)
  children.push(sectionHeading(L.secSynthesis));
  children.push(...richTextBlock(report.conclusion || L.dash));

  const doc = new Document({
    // Document-wide default font so body text isn't Word's Times New Roman.
    styles: { default: { document: { run: { font: REPORT_FONT } } } },
    sections: [{ children }],
  });
  const blob = await Packer.toBlob(doc);
  const safeTopic = report.topic.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60) || "topic";
  downloadBlob(blob, `${L.fileWord}_${safeTopic}.docx`);
}

/**
 * Build and download a structured meeting-prep report (.docx): synthesised
 * briefing + per-participant clickable source emails + external context +
 * meeting documents. Static labels follow report.language.
 */
export async function exportMeetingReport(report: MeetingReport): Promise<void> {
  const L = reportLabels(report.language);
  const children: Paragraph[] = [];

  children.push(
    new Paragraph({
      children: [new TextRun({ text: `${L.mtgTitlePrefix}${report.subject}`, bold: true, size: 34, font: REPORT_FONT })],
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
    })
  );
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: `${L.mtgMeta(report.date, report.participants.length)} · ${report.generatedOn}`,
          italics: true,
          color: "666666",
          size: 18,
          font: REPORT_FONT,
        }),
      ],
    })
  );

  // §1 Briefing (synthesis)
  children.push(sectionHeading(L.secBriefing));
  children.push(...richTextBlock(report.briefing || L.dash));

  // §2 By participant — summary handled in the briefing; here, clickable sources.
  children.push(sectionHeading(L.secParticipants));
  if (report.participants.length === 0) {
    children.push(new Paragraph({ children: [new TextRun({ text: L.dash, font: REPORT_FONT })] }));
  } else {
    report.participants.forEach((p, i) => {
      if (i > 0) children.push(separatorParagraph());
      children.push(
        new Paragraph({
          spacing: { before: 160, after: 40 },
          children: [
            new TextRun({ text: p.name, size: 26, color: "1F4E79", font: REPORT_FONT }),
            ...(p.profile ? [new TextRun({ text: `  —  ${p.profile}`, size: 20, color: "666666", font: REPORT_FONT })] : []),
          ],
        })
      );
      if (p.sources.length > 0) {
        children.push(
          new Paragraph({
            spacing: { after: 20 },
            children: [new TextRun({ text: L.lblSourceEmails, italics: true, size: 18, color: "666666", font: REPORT_FONT })],
          })
        );
        for (const s of p.sources) children.push(sourceLink(s, L));
      } else {
        children.push(new Paragraph({ children: [new TextRun({ text: L.dash, font: REPORT_FONT })] }));
      }
    });
  }

  // §3 External context
  if (report.externalSources.length > 0) {
    children.push(sectionHeading(L.secExternalContext));
    children.push(
      new Paragraph({
        spacing: { after: 20 },
        children: [new TextRun({ text: L.lblSourceEmails, italics: true, size: 18, color: "666666", font: REPORT_FONT })],
      })
    );
    for (const s of report.externalSources) children.push(sourceLink(s, L));
  }

  // §4 Meeting documents
  if (report.meetingDocs.length > 0) {
    children.push(sectionHeading(L.secMeetingDocs));
    for (const name of report.meetingDocs) {
      children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 20 }, children: [new TextRun({ text: name, font: REPORT_FONT })] }));
    }
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: REPORT_FONT } } } },
    sections: [{ children }],
  });
  const blob = await Packer.toBlob(doc);
  const safe = report.subject.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60) || "reunion";
  downloadBlob(blob, `${L.mtgFileWord}_${safe}.docx`);
}

/** Trigger a file download from a Blob. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
