/**
 * Extraction texte des pièces jointes — port Node de src/services/attachmentService.ts.
 *
 * Formats : PDF (pdfjs-dist, texte natif), DOCX (mammoth), XLSX/XLS (SheetJS),
 * PPTX (jszip + parsing OOXML), TXT, CSV, HTML.
 *
 * Différence avec la version navigateur : PAS d'OCR pour les PDF scannés
 * (le rendu de page nécessite un canvas ; à porter plus tard via node-canvas
 * ou un appel PaddleOCR-VL avec rendu serveur si le besoin se confirme).
 */
import type { GraphAttachment } from "./graphClient.js";

export interface AttachmentText {
  name: string;
  text: string;
}

const MAX_PDF_PAGES = 100;
const MAX_TEXT_LENGTH = 10000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

type AttachmentKind = "pdf" | "docx" | "xlsx" | "pptx" | "txt" | "csv" | "html";

const EXT_KINDS: Record<string, AttachmentKind> = {
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  xls: "xlsx",
  pptx: "pptx",
  txt: "txt",
  csv: "csv",
  html: "html",
  htm: "html",
};

function attachmentKind(contentType: string, name: string): AttachmentKind | null {
  const ct = (contentType || "").toLowerCase();
  if (ct.startsWith("application/pdf")) return "pdf";
  if (ct.includes("wordprocessingml.document")) return "docx";
  if (ct.includes("spreadsheetml.sheet") || ct.includes("ms-excel")) return "xlsx";
  if (ct.includes("presentationml.presentation")) return "pptx";
  if (ct.startsWith("text/csv")) return "csv";
  if (ct.startsWith("text/html")) return "html";
  if (ct.startsWith("text/plain")) return "txt";
  const ext = name?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return ext ? EXT_KINDS[ext] ?? null : null;
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    // Build legacy = compatible Node (pas de DOM). Le fake worker suffit ici.
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdf = await pdfjsLib.getDocument({
      data: new Uint8Array(buffer),
      disableFontFace: true,
      useSystemFonts: true,
    } as any).promise;
    const numPages = Math.min(pdf.numPages, MAX_PDF_PAGES);
    const parts: string[] = [];
    for (let i = 1; i <= numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      parts.push(content.items.map((item: any) => item.str).join(" ").trim());
    }
    return parts.join("\n").trim();
  } catch (err) {
    console.error("[attachments] PDF extraction failed:", (err as Error).message);
    return "";
  }
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value.trim();
  } catch (err) {
    console.error("[attachments] DOCX extraction failed:", (err as Error).message);
    return "";
  }
}

async function extractXlsxText(buffer: Buffer): Promise<string> {
  try {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buffer, { type: "buffer" });
    const parts: string[] = [];
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      if (!sheet) continue;
      const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim();
      if (csv) parts.push(`### Feuille : ${name}\n${csv}`);
    }
    return parts.join("\n\n").trim();
  } catch (err) {
    console.error("[attachments] XLSX extraction failed:", (err as Error).message);
    return "";
  }
}

function slideNumber(path: string): number {
  return parseInt(path.match(/slide(\d+)\.xml$/)?.[1] ?? "0", 10);
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function pptxSlideXmlToText(xml: string): string {
  const paragraphs = xml.split(/<a:p\b/).slice(1);
  const lines: string[] = [];
  for (const para of paragraphs) {
    const runs = [...para.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]));
    const line = runs.join("").trim();
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

async function extractPptxText(buffer: Buffer): Promise<string> {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(buffer);
    const slidePaths = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => slideNumber(a) - slideNumber(b));
    const parts: string[] = [];
    for (const path of slidePaths) {
      const xml = await zip.files[path].async("string");
      const text = pptxSlideXmlToText(xml);
      if (text) parts.push(`### Diapositive ${slideNumber(path)}\n${text}`);
    }
    return parts.join("\n\n").trim();
  } catch (err) {
    console.error("[attachments] PPTX extraction failed:", (err as Error).message);
    return "";
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extrait le texte des pièces jointes supportées. Chaque skip est expliqué
 * (pas de drop silencieux), chaque texte est tronqué à maxLength.
 */
export async function extractTextFromAttachments(
  attachments: GraphAttachment[],
  maxLength = MAX_TEXT_LENGTH,
  onProgress?: (message: string) => void
): Promise<{ texts: AttachmentText[]; skipped: Array<{ name: string; reason: string }> }> {
  const texts: AttachmentText[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const a of attachments) {
    const kind = attachmentKind(a.contentType, a.name);
    let skipReason: string | null = null;
    if (a.isInline) skipReason = "image/contenu inline";
    else if (a["@odata.type"] !== "#microsoft.graph.fileAttachment")
      skipReason = "pièce jointe non-fichier (lien cloud ou email attaché)";
    else if (!a.contentBytes) skipReason = "contenu absent (lien cloud OneDrive/SharePoint ?)";
    else if (a.size >= MAX_ATTACHMENT_BYTES)
      skipReason = `trop volumineux (${Math.round(a.size / 1024 / 1024)} Mo > 20 Mo)`;
    else if (kind === null) skipReason = `format non supporté (${a.contentType || "type inconnu"})`;

    if (skipReason) {
      skipped.push({ name: a.name, reason: skipReason });
      onProgress?.(`✗ ${a.name} ignoré — ${skipReason}`);
      continue;
    }

    const buffer = Buffer.from(a.contentBytes!, "base64");
    let text = "";
    if (kind === "pdf") text = await extractPdfText(buffer);
    else if (kind === "docx") text = await extractDocxText(buffer);
    else if (kind === "xlsx") text = await extractXlsxText(buffer);
    else if (kind === "pptx") text = await extractPptxText(buffer);
    else if (kind === "html") text = stripHtml(buffer.toString("utf8"));
    else text = buffer.toString("utf8").trim();

    if (text && text.trim().length > 0) {
      texts.push({ name: a.name, text: text.slice(0, maxLength) });
      onProgress?.(`✓ ${a.name} extrait (${kind}, ${text.length} car.)`);
    } else {
      skipped.push({ name: a.name, reason: "aucun texte extractible (PDF scanné ? OCR non disponible côté serveur)" });
      onProgress?.(`✗ ${a.name} — aucun texte extractible`);
    }
  }

  return { texts, skipped };
}
