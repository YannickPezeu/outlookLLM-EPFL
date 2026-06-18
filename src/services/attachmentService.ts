import * as pdfjsLib from "pdfjs-dist";

// pdfjs-dist v5 requires a real worker — setting workerSrc to "" makes
// getDocument() fail. Let webpack 5 emit the worker asset and resolve its URL
// (handles publicPath automatically for dev "/", k8s "/outlook/", ghpages).
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

export interface AttachmentText {
  name: string;
  text: string;
}

export interface ExtractOptions {
  /** Run vision-LLM OCR on image-only (scanned) PDF pages. Defaults to the
   *  user's "ocr_enabled" setting (on unless explicitly disabled). */
  ocr?: boolean;
  /** Progress callback for OCR (slow: 1–12s per scanned page). */
  onProgress?: (message: string) => void;
}

// Native text extraction is cheap, so we read a generous number of pages (the
// output is truncated to the model's context budget downstream anyway). OCR is
// the expensive path (1–12 s/page over the network), so it gets a far tighter
// ceiling — this is the real cost control, not the file-size cap.
const MAX_PDF_PAGES_NATIVE = 100;
const MAX_OCR_PAGES = 20;
// A page whose native text layer is below this many chars is treated as a scan
// (image-only) and routed to OCR. Per-page (not doc-average) so a mixed PDF gets
// only its scanned pages OCR'd. Matches DPO-Agent's OCR_THRESHOLD_CHARS_PER_PAGE.
const OCR_THRESHOLD_CHARS_PER_PAGE = 100;
// pdfjs viewport scale for OCR rendering. scale 2 ≈ 144 DPI — enough for OCR
// quality while keeping the base64 PNG payload modest (higher scales double the
// bytes for no measurable gain on PaddleOCR-VL).
const OCR_RENDER_SCALE = 2;

/** OCR is on unless the user turned it off in Settings (localStorage). */
function isOcrEnabled(): boolean {
  return localStorage.getItem("ocr_enabled") !== "false";
}

/**
 * Detect the VL-model repetition-loop failure mode (ported from DPO-Agent's
 * paddle_ocr.is_degenerate). VL OCR models occasionally drop into emitting the
 * same short line until max_tokens; such output is worse than the empty native
 * layer, so callers discard it. The 20-line floor avoids false positives on
 * legitimately short pages (title/signature pages).
 */
function isDegenerateOcr(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 20) return false;

  // 1. mostly-tiny-lines: healthy OCR has paragraphs, not a wall of ≤3-char lines.
  const tiny = lines.filter((l) => l.length <= 3).length;
  if (tiny / lines.length > 0.5) return true;

  // 2. dominant-line repetition: one line accounts for >30% of all lines.
  const counts = new Map<string, number>();
  let maxCount = 0;
  for (const l of lines) {
    const c = (counts.get(l) ?? 0) + 1;
    counts.set(l, c);
    if (c > maxCount) maxCount = c;
  }
  if (maxCount / lines.length > 0.3) return true;

  return false;
}

/** Render a PDF page to a PNG data URL via an offscreen canvas (for OCR). */
async function renderPdfPageToPng(page: pdfjsLib.PDFPageProxy): Promise<string> {
  const viewport = page.getViewport({ scale: OCR_RENDER_SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable for OCR rendering");
  await page.render({ canvasContext: ctx, viewport, canvas } as any).promise;
  return canvas.toDataURL("image/png");
}

interface GraphAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
  contentBytes?: string;
  "@odata.type"?: string;
}

type AttachmentKind = "pdf" | "docx" | "xlsx" | "pptx" | "txt" | "csv" | "html";

// Filename-extension → extractable kind. Used as a fallback when the MIME type
// is generic: some mail clients attach files as application/octet-stream, so a
// real PDF/DOCX would otherwise be silently dropped by a contentType-only check.
const EXT_KINDS: Record<string, AttachmentKind> = {
  pdf: "pdf",
  docx: "docx",
  xlsx: "xlsx",
  xls: "xlsx", // legacy binary Excel — SheetJS reads it too
  pptx: "pptx", // legacy binary .ppt is NOT supported (JSZip can't read it)
  txt: "txt",
  csv: "csv",
  html: "html",
  htm: "html",
};

/**
 * Decide how (if at all) an attachment can be extracted. Trust the MIME type
 * first, then fall back to the filename extension when the type is generic
 * (octet-stream) or missing. Returns null if neither indicates a supported
 * format. Used by both the filter and the extractor so routing stays consistent.
 */
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

// Default per-attachment extraction cap. Callers that summarize a single open
// email pass a much larger budget (Kimi K2.6 has a 256k-token context), while
// read_email_attachments / meeting prep keep this moderate default so reading
// several attachments at once doesn't blow the context window.
const MAX_TEXT_LENGTH = 30000;

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function extractPdfText(
  arrayBuffer: ArrayBuffer,
  opts?: ExtractOptions
): Promise<string> {
  try {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer } as any).promise;
    const numPages = Math.min(pdf.numPages, MAX_PDF_PAGES_NATIVE);

    // First pass: native text layer per page. We keep the page proxies around so
    // weak (image-only) pages can be re-rendered for OCR without reopening the doc.
    const pages: Array<{ page: pdfjsLib.PDFPageProxy; text: string }> = [];
    for (let i = 1; i <= numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((item: any) => item.str).join(" ").trim();
      pages.push({ page, text: pageText });
    }

    // Second pass: OCR the pages whose native layer is too thin to be real text
    // (scans). Skipped entirely when OCR is disabled or there are no weak pages,
    // so text-native PDFs pay zero OCR cost.
    const ocrEnabled = opts?.ocr ?? isOcrEnabled();
    const weakAll = ocrEnabled
      ? pages
          .map((p, idx) => ({ idx, len: p.text.length }))
          .filter((p) => p.len < OCR_THRESHOLD_CHARS_PER_PAGE)
      : [];
    // Native reading is generous (MAX_PDF_PAGES_NATIVE), but OCR is the costly
    // step — cap the number of scanned pages we actually OCR.
    const weak = weakAll.slice(0, MAX_OCR_PAGES);
    if (weakAll.length > weak.length) {
      opts?.onProgress?.(
        `  OCR limité aux ${MAX_OCR_PAGES} premières pages scannées ` +
          `(${weakAll.length} détectées)`
      );
    }

    if (weak.length > 0) {
      const { ocrImageViaRcp } = await import("./rcpApiService");
      for (let w = 0; w < weak.length; w++) {
        const { idx } = weak[w];
        const pageNo = idx + 1;
        opts?.onProgress?.(`OCR page ${pageNo} (${w + 1}/${weak.length})…`);
        try {
          const png = await renderPdfPageToPng(pages[idx].page);
          const ocrText = await ocrImageViaRcp(png);
          if (ocrText && !isDegenerateOcr(ocrText)) {
            pages[idx].text = ocrText;
          } else if (ocrText) {
            // Degenerate (repetition-loop) output is worse than nothing — keep
            // the (empty) native text rather than poisoning the result.
            console.warn(
              `[attachmentService] OCR page ${pageNo}: degenerate output discarded`
            );
          }
        } catch (err) {
          // Network/HTTP/render failure for one page shouldn't sink the others.
          console.warn(`[attachmentService] OCR failed on page ${pageNo}:`, err);
        }
      }
    }

    return pages.map((p) => p.text).join("\n").trim();
  } catch (err) {
    // Surface the real cause in dev (worker setup, corrupt file…) instead of
    // silently passing a fake placeholder to the LLM.
    console.error("[attachmentService] PDF extraction failed:", err);
    return "";
  }
}

async function extractDocxText(arrayBuffer: ArrayBuffer): Promise<string> {
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value.trim();
  } catch {
    return "[Contenu DOCX non extractible]";
  }
}

/**
 * Extract a spreadsheet (.xlsx / .xls) as text: each sheet is rendered to CSV,
 * prefixed by its name, so the LLM sees tabular structure. SheetJS is loaded
 * lazily (code-split) — it only ships to the client when a spreadsheet is
 * actually opened. We use the CDN-distributed (patched) build, not the npm one.
 */
async function extractXlsxText(arrayBuffer: ArrayBuffer): Promise<string> {
  try {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(arrayBuffer, { type: "array" });
    const parts: string[] = [];
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      if (!sheet) continue;
      const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim();
      if (csv) parts.push(`### Feuille : ${name}\n${csv}`);
    }
    return parts.join("\n\n").trim();
  } catch (err) {
    console.error("[attachmentService] XLSX extraction failed:", err);
    return "";
  }
}

/** Slide number from a "ppt/slides/slideN.xml" path (0 if unparseable). */
function slideNumber(path: string): number {
  return parseInt(path.match(/slide(\d+)\.xml$/)?.[1] ?? "0", 10);
}

/** Decode the five predefined XML entities found in OOXML text runs. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&"); // last — so "&amp;lt;" → "&lt;" not "<"
}

/**
 * Turn one slide's XML into plain text. In OOXML DrawingML, `<a:p>` is a
 * paragraph (a bullet/line) and `<a:t>` holds the actual text runs inside it.
 * We split on paragraphs to keep line breaks, then concatenate the runs of each.
 */
function pptxSlideXmlToText(xml: string): string {
  const paragraphs = xml.split(/<a:p\b/).slice(1); // first chunk is pre-<a:p> preamble
  const lines: string[] = [];
  for (const para of paragraphs) {
    const runs = [...para.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((m) =>
      decodeXmlEntities(m[1])
    );
    const line = runs.join("").trim();
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Extract text from a PowerPoint (.pptx) presentation. A .pptx is a ZIP of XML
 * parts; slide text lives in ppt/slides/slideN.xml. JSZip is loaded lazily
 * (code-split) so it only ships when a presentation is actually opened. Slides
 * are emitted in presentation order (numeric sort — slide10 must follow slide9,
 * not slide1). Legacy binary .ppt is not a ZIP and is not supported.
 */
async function extractPptxText(arrayBuffer: ArrayBuffer): Promise<string> {
  try {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(arrayBuffer);
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
    console.error("[attachmentService] PPTX extraction failed:", err);
    return "";
  }
}

function extractPlainText(arrayBuffer: ArrayBuffer): string {
  const decoder = new TextDecoder("utf-8");
  return decoder.decode(arrayBuffer).trim();
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

// File-size ceiling. With OCR now bounded by page count (MAX_OCR_PAGES) and
// native extraction being cheap, this is purely a browser-memory guard for the
// base64 decode + pdf.js parse — not a cost control — so it can be generous.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface AttachmentDecision {
  attachment: GraphAttachment;
  kind: AttachmentKind | null;
  /** null = kept; otherwise a human-readable reason it was skipped. */
  skipReason: string | null;
}

/**
 * Classify each attachment as keep/skip with a reason. Centralizes the rules so
 * the filter, the extractor, and the UI logging all agree on why something was
 * (or wasn't) processed — no more silent drops.
 */
export function classifyAttachments(attachments: GraphAttachment[]): AttachmentDecision[] {
  return attachments.map((a) => {
    const kind = attachmentKind(a.contentType, a.name);
    let skipReason: string | null = null;
    if (a.isInline) {
      skipReason = "image/contenu inline";
    } else if (a["@odata.type"] !== "#microsoft.graph.fileAttachment") {
      skipReason = `pièce jointe non-fichier (${a["@odata.type"]}) — lien cloud ou email attaché`;
    } else if (!a.contentBytes) {
      skipReason = "contenu absent (lien cloud OneDrive/SharePoint ?)";
    } else if (a.size >= MAX_ATTACHMENT_BYTES) {
      skipReason = `trop volumineux (${Math.round(a.size / 1024 / 1024)} Mo > ${MAX_ATTACHMENT_BYTES / 1024 / 1024} Mo)`;
    } else if (kind === null) {
      skipReason = `format non supporté (${a.contentType || "type inconnu"})`;
    }
    return { attachment: a, kind, skipReason };
  });
}

export function filterSupportedAttachments(attachments: GraphAttachment[]): GraphAttachment[] {
  return classifyAttachments(attachments)
    .filter((d) => d.skipReason === null)
    .map((d) => d.attachment);
}

export async function extractTextFromAttachments(
  attachments: GraphAttachment[],
  maxLength: number = MAX_TEXT_LENGTH,
  opts?: ExtractOptions
): Promise<AttachmentText[]> {
  const decisions = classifyAttachments(attachments);
  const results: AttachmentText[] = [];

  // Surface every skipped attachment with its reason — no silent drops.
  for (const d of decisions) {
    if (d.skipReason) {
      opts?.onProgress?.(`  ✗ ${d.attachment.name} ignoré — ${d.skipReason}`);
    }
  }

  for (const { attachment, kind } of decisions.filter((d) => !d.skipReason)) {
    const arrayBuffer = base64ToArrayBuffer(attachment.contentBytes!);
    let text = "";

    if (kind === "pdf") {
      text = await extractPdfText(arrayBuffer, opts);
    } else if (kind === "docx") {
      text = await extractDocxText(arrayBuffer);
    } else if (kind === "xlsx") {
      text = await extractXlsxText(arrayBuffer);
    } else if (kind === "pptx") {
      text = await extractPptxText(arrayBuffer);
    } else if (kind === "html") {
      text = stripHtml(extractPlainText(arrayBuffer));
    } else {
      // "txt" / "csv" — and the defensive default for anything that slipped through.
      text = extractPlainText(arrayBuffer);
    }

    if (text && text.trim().length > 0) {
      results.push({
        name: attachment.name,
        text: text.slice(0, maxLength),
      });
      opts?.onProgress?.(`  ✓ ${attachment.name} extrait (${kind}, ${text.length} car.)`);
    } else {
      // Extracted to nothing — e.g. a scanned PDF with OCR disabled, or an empty
      // file. Report it so it doesn't look like the attachment was processed.
      opts?.onProgress?.(`  ✗ ${attachment.name} — aucun texte extractible (scan sans OCR ?)`);
    }
  }

  return results;
}
