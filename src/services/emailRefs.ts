// ─── Email ID reference store ──────────────────────────────────────
// Tool results contain very long Graph API email IDs (100+ chars).
// We replace them with short refs (ref_0, ref_1...) so the LLM can
// reliably (a) include them in markdown links like [Subject](email:ref_0),
// and (b) feed them back to display_emails to render a filtered list
// without re-fetching anything.

export interface EmailRefMetadata {
  realId: string;
  subject: string;
  date: string;
  from: string;
  direction: "received" | "sent";
}

const STORAGE_KEY = "epfl-mail-ai-email-refs";

let emailRefCounter = 0;
const emailRefMap = new Map<string, EmailRefMetadata>();

// Outlook may unmount/remount the taskpane when switching emails, even with
// SupportsPinning. Persist refs to sessionStorage so clickable email links
// in restored conversations still resolve to real Graph IDs.
function loadRefs(): void {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (typeof data.counter === "number") emailRefCounter = data.counter;
    if (Array.isArray(data.entries)) {
      for (const [k, v] of data.entries) emailRefMap.set(k, v);
    }
  } catch {
    // Corrupt blob — start fresh.
  }
}

function persistRefs(): void {
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        counter: emailRefCounter,
        entries: Array.from(emailRefMap.entries()),
      })
    );
  } catch {
    // sessionStorage full or unavailable — refs stay in memory only.
  }
}

loadRefs();

function makeRef(item: Record<string, any>): string {
  const ref = `ref_${emailRefCounter++}`;
  emailRefMap.set(ref, {
    realId: item.id,
    subject: item.subject ?? "(Sans sujet)",
    date: item.date ?? item.displayDate ?? item.receivedDateTime ?? "",
    from: item.from ?? (item.direction === "sent" ? "Moi" : "?"),
    direction: item.direction === "sent" ? "sent" : "received",
  });
  persistRefs();
  return ref;
}

/** Drop all refs (called when user resets the conversation). */
export function clearEmailRefs(): void {
  emailRefCounter = 0;
  emailRefMap.clear();
  try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
}

/**
 * Walk a tool result JSON, replace any long Graph IDs found in arrays
 * named `results`, `emails`, or `email_list` with short refs.
 * Stores per-ref metadata so display_emails can render cards later.
 */
export function replaceEmailIdsWithRefs(jsonStr: string): string {
  try {
    const data = JSON.parse(jsonStr);
    const buckets = [data.results, data.emails, data.email_list, data.attachments_available].filter(Array.isArray);
    for (const items of buckets) {
      for (const item of items) {
        if (item.id && typeof item.id === "string" && item.id.length > 20) {
          item.id = makeRef(item);
        }
      }
    }
    return JSON.stringify(data);
  } catch {
    return jsonStr;
  }
}

/** Resolve a short ref (ref_0) to the real Graph API email ID. */
export function resolveEmailRef(ref: string): string | undefined {
  return emailRefMap.get(ref)?.realId;
}

/** Resolve a short ref to its full stored metadata, used by display_emails. */
export function resolveEmailRefMetadata(ref: string): EmailRefMetadata | undefined {
  return emailRefMap.get(ref);
}
