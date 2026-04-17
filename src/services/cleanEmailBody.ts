/**
 * Extracts only the "fresh" part of an email body, stripping reply/forward chains.
 *
 * Handles two formats:
 * 1. Plain text: Outlook-style separator (________________________________) + "De :" / "From :" header
 * 2. HTML: various Outlook/Gmail/Apple Mail reply markers
 *
 * Returns clean plain text (HTML tags stripped if input is HTML).
 */

// ─── HTML reply markers ────────────────────────────────────────────
// These patterns mark the start of quoted/forwarded content in HTML emails.
const HTML_REPLY_MARKERS = [
  // Outlook Web / Desktop
  /<div\s+id\s*=\s*["']?divRplyFwdMsg["']?/i,
  /<div\s+id\s*=\s*["']?appendonsend["']?/i,
  /<div\s+style\s*=\s*["'][^"']*border-top\s*:\s*solid\s+#[A-Fa-f0-9]+/i,
  // Outlook horizontal rule before quoted content
  /<hr\s+style\s*=\s*["']display\s*:\s*inline-block/i,
  // Gmail
  /<div\s+class\s*=\s*["']?gmail_quote["']?/i,
  // Apple Mail
  /<div\s+class\s*=\s*["']?AppleOriginalContents["']?/i,
  // Generic blockquote used by many clients
  /<blockquote\s+[^>]*type\s*=\s*["']?cite["']?/i,
];

// ─── Plain text reply markers ──────────────────────────────────────
// These patterns mark the start of quoted content in plain text emails.
const TEXT_REPLY_PATTERNS = [
  // Outlook FR: ________________________________ followed by De : ... Envoyé :
  /\n_{10,}\s*\nDe\s*:/,
  // Outlook EN: ________________________________ followed by From : ... Sent :
  /\n_{10,}\s*\nFrom\s*:/,
  // Outlook classic separator
  /\n-{5,}\s*Original Message\s*-{5,}/i,
  /\n-{5,}\s*Message d'origine\s*-{5,}/i,
  /\n-{5,}\s*Message transféré\s*-{5,}/i,
  /\n-{5,}\s*Forwarded Message\s*-{5,}/i,
  // "On <date>, <name> wrote:" (Gmail plain text)
  /\nOn .{10,80} wrote:\s*\n/,
  // "Le <date>, <name> a écrit :" (Gmail FR plain text)
  /\nLe .{10,80} a écrit\s*:\s*\n/,
];

/**
 * Strip HTML tags and decode common entities. Preserves paragraph structure.
 */
function stripHtml(html: string): string {
  return html
    // Remove style/script blocks entirely
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    // Convert <br>, </p>, </div>, </tr> to newlines for paragraph structure
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, "\n")
    // Remove all remaining tags
    .replace(/<[^>]+>/g, " ")
    // Decode common entities
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Collapse whitespace (but preserve newlines)
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Detect if the input looks like HTML.
 */
function isHtml(text: string): boolean {
  return /<(?:html|head|body|div|p|br|span|table)\b/i.test(text);
}

/**
 * Clean an email body: extract only the fresh content, strip reply chains.
 *
 * @param body - Raw email body (HTML or plain text)
 * @returns Clean plain text with only the new content
 */
export function cleanEmailBody(body: string): string {
  if (!body) return "";

  let freshContent: string;

  if (isHtml(body)) {
    freshContent = cleanHtmlBody(body);
  } else {
    freshContent = cleanTextBody(body);
  }

  // Final cleanup
  return freshContent
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Clean an HTML email body.
 */
function cleanHtmlBody(html: string): string {
  // Find the earliest reply marker in the HTML
  let cutIndex = html.length;

  for (const marker of HTML_REPLY_MARKERS) {
    const match = html.match(marker);
    if (match && match.index !== undefined && match.index < cutIndex) {
      cutIndex = match.index;
    }
  }

  // Cut the HTML at the reply marker
  const freshHtml = html.slice(0, cutIndex);

  // Convert to plain text
  let text = stripHtml(freshHtml);

  // Also apply text-level patterns in case the HTML contains plain-text-style markers
  text = applyTextPatterns(text);

  return text;
}

/**
 * Clean a plain text email body.
 */
function cleanTextBody(text: string): string {
  return applyTextPatterns(text);
}

/**
 * Apply plain text reply patterns to cut at the earliest match.
 */
function applyTextPatterns(text: string): string {
  let cutIndex = text.length;

  for (const pattern of TEXT_REPLY_PATTERNS) {
    const match = text.match(pattern);
    if (match && match.index !== undefined && match.index < cutIndex) {
      cutIndex = match.index;
    }
  }

  return text.slice(0, cutIndex);
}

// ─── cleanEmailBodyFull ────────────────────────────────────────────

/**
 * Clean an email body for LLM consumption: strip HTML but KEEP reply chains.
 *
 * Unlike cleanEmailBody() which cuts at the first reply marker,
 * this function preserves the full conversation thread as readable plain text.
 * Used for the Gemma E2B filter and synthesis phases where the LLM needs
 * the full conversational context.
 *
 * @param body - Raw email body (HTML or plain text)
 * @returns Clean plain text with full conversation preserved
 */
export function cleanEmailBodyFull(body: string): string {
  if (!body) return "";

  let text: string;

  if (isHtml(body)) {
    // Just strip HTML to text — do NOT cut at reply markers
    text = stripHtml(body);
  } else {
    // Plain text: return as-is (reply separators are already readable)
    text = body;
  }

  // Final cleanup
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
