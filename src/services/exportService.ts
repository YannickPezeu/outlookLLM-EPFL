import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
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
