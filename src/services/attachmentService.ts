import * as pdfjsLib from "pdfjs-dist";

// Disable worker for simplicity in add-in context
pdfjsLib.GlobalWorkerOptions.workerSrc = "";

export interface AttachmentText {
  name: string;
  text: string;
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

const MAX_TEXT_LENGTH = 10000;

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function extractPdfText(arrayBuffer: ArrayBuffer): Promise<string> {
  try {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer } as any).promise;
    const textParts: string[] = [];

    for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item: any) => item.str)
        .join(" ");
      textParts.push(pageText);
    }

    return textParts.join("\n").trim();
  } catch {
    return "[Contenu PDF non extractible]";
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
  attachments: GraphAttachment[]
): Promise<AttachmentText[]> {
  const supported = filterSupportedAttachments(attachments);
  const results: AttachmentText[] = [];

  for (const attachment of supported) {
    const arrayBuffer = base64ToArrayBuffer(attachment.contentBytes!);
    let text = "";

    const ct = attachment.contentType.toLowerCase();
    if (ct.startsWith("application/pdf")) {
      text = await extractPdfText(arrayBuffer);
    } else if (ct.includes("wordprocessingml.document")) {
      text = await extractDocxText(arrayBuffer);
    } else if (ct.startsWith("text/html")) {
      text = stripHtml(extractPlainText(arrayBuffer));
    } else {
      text = extractPlainText(arrayBuffer);
    }

    if (text && text.length > 0) {
      results.push({
        name: attachment.name,
        text: text.slice(0, MAX_TEXT_LENGTH),
      });
    }
  }

  return results;
}
