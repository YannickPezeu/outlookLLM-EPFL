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

// Cap on pages we render+OCR per PDF. Native text extraction already caps at 20
// pages below; OCR is far slower so we keep the same ceiling to bound latency.
const MAX_PDF_PAGES = 20;
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

const SUPPORTED_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/csv",
  "text/html",
];

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
    const numPages = Math.min(pdf.numPages, MAX_PDF_PAGES);

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
    const weak = ocrEnabled
      ? pages
          .map((p, idx) => ({ idx, len: p.text.length }))
          .filter((p) => p.len < OCR_THRESHOLD_CHARS_PER_PAGE)
      : [];

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

export function filterSupportedAttachments(attachments: GraphAttachment[]): GraphAttachment[] {
  return attachments.filter(
    (a) =>
      !a.isInline &&
      a["@odata.type"] === "#microsoft.graph.fileAttachment" &&
      a.contentBytes &&
      a.size < 5 * 1024 * 1024 &&
      SUPPORTED_TYPES.some((t) => a.contentType.toLowerCase().startsWith(t))
  );
}

export async function extractTextFromAttachments(
  attachments: GraphAttachment[],
  maxLength: number = MAX_TEXT_LENGTH,
  opts?: ExtractOptions
): Promise<AttachmentText[]> {
  const supported = filterSupportedAttachments(attachments);
  const results: AttachmentText[] = [];

  for (const attachment of supported) {
    const arrayBuffer = base64ToArrayBuffer(attachment.contentBytes!);
    let text = "";

    const ct = attachment.contentType.toLowerCase();
    if (ct.startsWith("application/pdf")) {
      text = await extractPdfText(arrayBuffer, opts);
    } else if (ct.includes("wordprocessingml.document")) {
      text = await extractDocxText(arrayBuffer);
    } else if (ct.startsWith("text/html")) {
      text = stripHtml(extractPlainText(arrayBuffer));
    } else {
      text = extractPlainText(arrayBuffer);
    }

    if (text && text.trim().length > 0) {
      results.push({
        name: attachment.name,
        text: text.slice(0, maxLength),
      });
    }
  }

  return results;
}
