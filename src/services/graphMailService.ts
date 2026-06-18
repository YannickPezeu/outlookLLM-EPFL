import { getGraphToken, markAuthFailed } from "./authService";
import { config } from "../config";
import { distance as levenshtein } from "fastest-levenshtein";
import type { ParticipantCollectStats } from "./mailTypes";

const GRAPH = config.graph.baseUrl;

const USER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

// ─── Types ───────────────────────────────────────────────────────────

export interface EmailMessage {
  id: string;
  subject: string;
  bodyPreview: string;
  body?: { contentType: string; content: string };
  from?: { emailAddress: { name: string; address: string } };
  toRecipients?: Array<{ emailAddress: { name: string; address: string } }>;
  receivedDateTime: string;
  sentDateTime?: string;
  parentFolderId: string;
  isRead: boolean;
  hasAttachments?: boolean;
  attachmentTexts?: Array<{ name: string; text: string }>;
}

export interface GraphAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
  contentBytes?: string;
  "@odata.type"?: string;
}

export interface LightEmail {
  id: string;
  subject: string;
  bodyPreview: string;
  body?: { contentType: string; content: string };
  from?: { emailAddress: { name: string; address: string } };
  toRecipients?: Array<{ emailAddress: { name: string; address: string } }>;
  receivedDateTime: string;
  conversationId: string;
  hasAttachments?: boolean;
}

export interface CalendarEvent {
  id: string;
  subject: string;
  body?: { contentType: string; content: string };
  bodyPreview: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location?: { displayName: string };
  attendees: Array<{
    emailAddress: { name: string; address: string };
    type: string;
    status?: { response: string };
  }>;
  isOrganizer: boolean;
  organizer?: { emailAddress: { name: string; address: string } };
  seriesMasterId?: string;
}

export interface DateRange {
  startDate?: string; // ISO 8601, e.g. "2023-05-01"
  endDate?: string;   // ISO 8601, e.g. "2023-06-01"
}

interface GraphPagedResponse<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

/**
 * Build OData $filter clause for date range.
 * E.g. → "receivedDateTime ge 2023-10-01T00:00:00Z and receivedDateTime lt 2024-01-01T00:00:00Z"
 */
function buildDateFilter(dateRange?: DateRange, field = "receivedDateTime"): string {
  if (!dateRange) return "";
  const parts: string[] = [];
  if (dateRange.startDate) parts.push(`${field} ge ${dateRange.startDate.slice(0, 10)}T00:00:00Z`);
  if (dateRange.endDate) parts.push(`${field} lt ${dateRange.endDate.slice(0, 10)}T00:00:00Z`);
  return parts.join(" and ");
}

/**
 * KQL date-range clause appended to a $search query so the search is bounded by
 * date SERVER-SIDE (e.g. " AND received:2025-01-01..2025-12-31"). Without it,
 * $search returns the ~1000 most-recent matches across all time, so older date
 * ranges get truncated. Graph's mail $search supports the `received`/`sent`
 * searchable properties with the `..` range operator.
 */
function kqlDateClause(dateRange: DateRange | undefined, prop: "received" | "sent"): string {
  if (dateRange?.startDate && dateRange?.endDate) {
    return ` AND ${prop}:${dateRange.startDate.slice(0, 10)}..${dateRange.endDate.slice(0, 10)}`;
  }
  return "";
}

/**
 * Client-side date-range filter. Used when the Graph query narrows by something
 * else (e.g. $search by sender) and we restrict the date ourselves.
 */
function filterByDate<T>(items: T[], dateField: keyof T, dateRange: DateRange): T[] {
  const start = dateRange.startDate ? new Date(dateRange.startDate).getTime() : -Infinity;
  const end = dateRange.endDate ? new Date(dateRange.endDate).getTime() : Infinity;
  return items.filter((item) => {
    const v = item[dateField];
    if (typeof v !== "string") return false;
    const t = new Date(v).getTime();
    return t >= start && t < end;
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────

// Global token recovery: all parallel 401s wait on the same recovery promise
let tokenRecoveryPromise: Promise<string> | null = null;

async function recoverToken(): Promise<string> {
  if (tokenRecoveryPromise) {
    return tokenRecoveryPromise;
  }
  tokenRecoveryPromise = (async () => {
    try {
      console.warn(`[Graph] Token recovery — trying forceRefresh...`);
      const freshToken = await getGraphToken(true);
      return freshToken;
    } finally {
      tokenRecoveryPromise = null;
    }
  })();
  return tokenRecoveryPromise;
}

async function graphFetch<T>(
  url: string,
  options?: RequestInit,
  throttleRetriesLeft = 3
): Promise<T> {
  console.log(`[Graph] ${options?.method || "GET"} ${url}`);
  const token = await getGraphToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  // 429 Too Many Requests — honor Retry-After header (in seconds), else exp backoff.
  // Microsoft Graph throttles per-mailbox concurrency (default ~4 per app per user).
  if (response.status === 429 && throttleRetriesLeft > 0) {
    const retryAfter = response.headers.get("Retry-After");
    const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN;
    const delayMs = !Number.isNaN(parsed) && parsed > 0
      ? Math.min(parsed * 1000, 10000)
      : Math.min(500 * Math.pow(2, 3 - throttleRetriesLeft), 8000);
    console.warn(
      `[Graph] 429 throttled on ${url.split("?")[0]}, retry in ${delayMs}ms (${throttleRetriesLeft} left)`
    );
    await new Promise((r) => setTimeout(r, delayMs));
    return graphFetch<T>(url, options, throttleRetriesLeft - 1);
  }

  if (response.status === 401) {
    let freshToken: string;
    try {
      freshToken = await recoverToken();
    } catch (err) {
      // Token recovery itself failed (silent refresh + interactive both gave up):
      // the session is broken, not a transient blip. Flip the auth badge so the
      // user sees "Non connecté" and can hit "Reconnecter".
      markAuthFailed();
      throw err;
    }
    const retry = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${freshToken}`,
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
    if (!retry.ok) {
      const errorBody = await retry.text();
      console.error(`[Graph] Error ${retry.status} after token recovery:`, errorBody);
      // A 401 even with a freshly-refreshed token means the session is genuinely
      // broken (revoked/expired refresh token) — surface it in the UI.
      if (retry.status === 401) markAuthFailed();
      throw new Error(`Graph API error ${retry.status}: ${errorBody}`);
    }
    return retry.json();
  }

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[Graph] Error ${response.status}:`, errorBody);
    throw new Error(`Graph API error ${response.status}: ${errorBody}`);
  }

  return response.json();
}

/**
 * Fetch all pages up to maxItems, following @odata.nextLink.
 * Optional onPage callback fires after each page for progress reporting.
 */
async function fetchAllPages<T>(
  url: string,
  maxItems: number,
  options?: RequestInit,
  onPage?: (itemsSoFar: number) => void
): Promise<T[]> {
  const items: T[] = [];
  let nextUrl: string | undefined = url;

  while (nextUrl && items.length < maxItems) {
    const page: GraphPagedResponse<T> = await graphFetch<GraphPagedResponse<T>>(nextUrl, options);
    items.push(...page.value);
    onPage?.(items.length);
    nextUrl = page["@odata.nextLink"];
  }

  return items.slice(0, maxItems);
}

// ─── Email Search ────────────────────────────────────────────────────

/**
 * Search emails received FROM a specific sender.
 */
export async function searchEmailsFromSender(
  senderEmail: string,
  maxResults = config.defaults.maxEmailsToFetch,
  dateRange?: DateRange,
  onPage?: (itemsSoFar: number) => void
): Promise<EmailMessage[]> {
  const select = "id,subject,bodyPreview,body,from,receivedDateTime,parentFolderId,isRead,hasAttachments";

  // Narrow to this sender with $search (reliable for from/to via the search
  // index — unlike $filter on from/emailAddress/address, which under-returns).
  // The date range is pushed into the KQL query (received:start..end) so the
  // search is bounded server-side; otherwise $search returns only the ~1000
  // most-recent matches and older ranges get truncated. The client filterByDate
  // below is a safety net.
  const search = `from:${senderEmail}${kqlDateClause(dateRange, "received")}`;
  const url = `${GRAPH}/me/messages?$search="${encodeURIComponent(search)}"&$select=${select}&$top=50`;
  const fetchCap = dateRange ? Math.max(maxResults * 20, 600) : maxResults;
  const results = await fetchAllPages<EmailMessage>(url, fetchCap, undefined, onPage);

  const dated = dateRange ? filterByDate(results, "receivedDateTime", dateRange) : results;
  dated.sort((a, b) => new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime());
  return dated.slice(0, maxResults);
}

/**
 * Search emails SENT TO a specific recipient.
 */
export async function searchEmailsSentTo(
  recipientEmail: string,
  maxResults = config.defaults.maxEmailsToFetch,
  dateRange?: DateRange,
  onPage?: (itemsSoFar: number) => void
): Promise<EmailMessage[]> {
  const select = "id,subject,bodyPreview,body,toRecipients,sentDateTime,parentFolderId,hasAttachments";

  // Same reliable approach as searchEmailsFromSender: $search narrows to this
  // recipient (search index), date pushed into the KQL query (sent:start..end)
  // so the search is bounded server-side.
  const search = `to:${recipientEmail}${kqlDateClause(dateRange, "sent")}`;
  const url = `${GRAPH}/me/mailFolders/sentitems/messages?$search="${encodeURIComponent(search)}"&$select=${select}&$top=50`;
  const fetchCap = dateRange ? Math.max(maxResults * 20, 600) : maxResults;
  const results = await fetchAllPages<EmailMessage>(url, fetchCap, undefined, onPage);

  const dated = dateRange ? filterByDate(results, "sentDateTime", dateRange) : results;
  dated.sort((a, b) => new Date(b.sentDateTime || b.receivedDateTime).getTime() - new Date(a.sentDateTime || a.receivedDateTime).getTime());
  return dated.slice(0, maxResults);
}

/**
 * Get all interactions (sent + received) with a specific email address.
 */
export async function getAllInteractions(
  email: string,
  maxPerDirection = config.defaults.maxEmailsForSummary,
  dateRange?: DateRange,
  onPage?: (direction: "received" | "sent", itemsSoFar: number) => void
): Promise<{ received: EmailMessage[]; sent: EmailMessage[] }> {
  const [received, sent] = await Promise.all([
    searchEmailsFromSender(email, maxPerDirection, dateRange, onPage && ((n) => onPage("received", n))),
    searchEmailsSentTo(email, maxPerDirection, dateRange, onPage && ((n) => onPage("sent", n))),
  ]);

  return { received, sent };
}

/**
 * Get a single email by ID with full body.
 */
export async function getEmail(messageId: string): Promise<EmailMessage> {
  const url = `${GRAPH}/me/messages/${messageId}?$select=id,subject,body,bodyPreview,from,toRecipients,receivedDateTime,sentDateTime,parentFolderId,isRead,hasAttachments`;
  return graphFetch<EmailMessage>(url);
}

/**
 * Get attachments for a message (file attachments only, max 5MB).
 */
export async function getMessageAttachments(messageId: string): Promise<GraphAttachment[]> {
  const url = `${GRAPH}/me/messages/${messageId}/attachments`;
  const response = await graphFetch<{ value: GraphAttachment[] }>(url);
  return response.value;
}

// ─── Calendar ───────────────────────────────────────────────────────

/**
 * Get a single calendar event by ID.
 */
export async function getCalendarEvent(eventId: string): Promise<CalendarEvent> {
  const url = `${GRAPH}/me/events/${eventId}?$select=id,subject,body,bodyPreview,start,end,location,attendees,isOrganizer,organizer,seriesMasterId`;
  return graphFetch<CalendarEvent>(url, {
    headers: { Prefer: `outlook.timezone="${USER_TIMEZONE}"` },
  });
}

/**
 * Get calendar events in a time range.
 */
export async function getCalendarView(
  startDateTime: string,
  endDateTime: string,
  maxResults = 50
): Promise<CalendarEvent[]> {
  const url = `${GRAPH}/me/calendarView?startDateTime=${startDateTime}&endDateTime=${endDateTime}&$select=id,subject,bodyPreview,start,end,attendees,isOrganizer,organizer,seriesMasterId&$orderby=start/dateTime desc&$top=50`;
  return fetchAllPages<CalendarEvent>(url, maxResults, {
    headers: { Prefer: `outlook.timezone="${USER_TIMEZONE}"` },
  });
}

export interface ScheduleInformation {
  scheduleId: string;
  availabilityView?: string;
  scheduleItems?: Array<{
    status: string;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
  }>;
  error?: { message: string; responseCode: string };
}

/**
 * Query free/busy information for a list of users via /me/calendar/getSchedule.
 * Works with Calendars.Read delegated scope — free/busy is tenant-visible in Exchange.
 * availabilityView digits: 0=free, 1=tentative, 2=busy, 3=OOF, 4=working-elsewhere.
 */
export async function getSchedule(
  emails: string[],
  startTime: Date,
  endTime: Date,
  availabilityViewInterval = 30
): Promise<ScheduleInformation[]> {
  const url = `${GRAPH}/me/calendar/getSchedule`;
  const body = {
    schedules: emails,
    startTime: { dateTime: startTime.toISOString(), timeZone: "UTC" },
    endTime: { dateTime: endTime.toISOString(), timeZone: "UTC" },
    availabilityViewInterval,
  };
  const response = await graphFetch<{ value: ScheduleInformation[] }>(url, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return response.value;
}

// ─── Light Email Search (for embedding pipeline) ────────────────────

/**
 * Search emails FROM a sender — light fields only (no body, for embedding phase).
 * Uses conversationId for deduplication.
 */
export async function searchEmailsFromSenderLight(
  senderEmail: string,
  maxResults = config.defaults.maxEmailsPerParticipant
): Promise<LightEmail[]> {
  const select = "id,subject,bodyPreview,from,toRecipients,receivedDateTime,conversationId";
  const url = `${GRAPH}/me/messages?$search="from:${senderEmail}"&$select=${select}&$top=50`;

  return fetchAllPages<LightEmail>(url, maxResults);
}

/**
 * Search emails SENT TO a recipient — light fields only.
 */
export async function searchEmailsSentToLight(
  recipientEmail: string,
  maxResults = config.defaults.maxEmailsPerParticipant
): Promise<LightEmail[]> {
  const select = "id,subject,bodyPreview,toRecipients,receivedDateTime,conversationId";
  const url = `${GRAPH}/me/mailFolders/sentitems/messages?$search="to:${recipientEmail}"&$select=${select}&$top=50`;

  return fetchAllPages<LightEmail>(url, maxResults);
}

/**
 * Collect all light emails exchanged with a participant, deduplicated by conversationId.
 * Keeps only the most recent email per conversation thread.
 *
 * Optional onStats callback exposes the raw-vs-deduped numbers — useful so
 * callers can surface "we fetched 350 emails across all your threads with this
 * person and collapsed them into 80 thread-leaders" instead of just showing
 * the deduped count.
 */
export async function collectEmailsWithParticipant(
  email: string,
  maxPerDirection = config.defaults.maxEmailsPerParticipant,
  onStats?: (stats: ParticipantCollectStats) => void
): Promise<LightEmail[]> {
  const received = await searchEmailsFromSenderLight(email, maxPerDirection);
  const sent = await searchEmailsSentToLight(email, maxPerDirection);

  // Deduplicate by conversationId — keep most recent per thread
  const byConversation = new Map<string, LightEmail>();
  const allEmails = [...received, ...sent].sort(
    (a, b) => new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime()
  );

  for (const email of allEmails) {
    if (!byConversation.has(email.conversationId)) {
      byConversation.set(email.conversationId, email);
    }
  }

  const deduped = byConversation.size;
  console.log(
    `[Graph] collectEmails ${email}: ${received.length} reçus + ${sent.length} envoyés ` +
      `= ${received.length + sent.length} bruts → ${deduped} après dedup conversation`
  );
  onStats?.({ rawReceived: received.length, rawSent: sent.length, deduped });
  return Array.from(byConversation.values());
}

/**
 * Get multiple emails by ID with full body (for the final reading phase).
 *
 * Uses a per-id worker pool with concurrency capped at the Microsoft Graph
 * MailboxConcurrency limit (~4 per app per user). $batch was tried but
 * triggered massive 429s because sub-requests within a batch hit the mailbox
 * in parallel internally — a 20-sub-request batch alone busts the limit.
 *
 * Each individual GET goes through graphFetch which handles 429 with
 * Retry-After backoff, so transient throttling is recovered automatically.
 * Truly failed emails are logged and dropped (not present in the result).
 */
export async function getEmailsBatch(
  messageIds: string[],
  concurrency = 4
): Promise<EmailMessage[]> {
  if (messageIds.length === 0) return [];

  const results: Array<EmailMessage | undefined> = new Array(messageIds.length);
  let nextIdx = 0;
  let failed = 0;
  const failureSamples: string[] = [];

  async function worker(): Promise<void> {
    while (true) {
      const myIdx = nextIdx++;
      if (myIdx >= messageIds.length) return;
      try {
        results[myIdx] = await getEmail(messageIds[myIdx]);
      } catch (err) {
        failed++;
        if (failureSamples.length < 3) {
          const msg = err instanceof Error ? err.message : String(err);
          failureSamples.push(`#${myIdx} → ${msg.slice(0, 120)}`);
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, messageIds.length) }, () => worker())
  );

  if (failed > 0) {
    console.warn(
      `[getEmailsBatch] ${failed}/${messageIds.length} emails échoués après retries. ` +
        `Échantillon : ${failureSamples.join(" | ")}`
    );
  }

  return results.filter((e): e is EmailMessage => e !== undefined);
}

// ─── Keyword Search (for non-participant emails) ────────────────────

/**
 * Search emails by keyword using Graph $search.
 * Used to find emails related to the meeting subject from non-participants.
 * Returns light emails for embedding.
 */
export async function searchEmailsByKeyword(
  keyword: string,
  maxResults = 50
): Promise<LightEmail[]> {
  const select = "id,subject,bodyPreview,from,toRecipients,receivedDateTime,conversationId";
  const encodedQuery = encodeURIComponent(keyword);
  const url = `${GRAPH}/me/messages?$search="${encodedQuery}"&$select=${select}&$top=50`;
  return fetchAllPages<LightEmail>(url, maxResults);
}

/**
 * Get all recent received emails (inbox) within a date range.
 * Used by topic-wide tools (identify_topic_participants, summarize_topic_status)
 * to feed semantic reranking without a person filter.
 */
export async function getRecentEmails(
  months = 6,
  maxResults = 2000
): Promise<LightEmail[]> {
  const select = "id,subject,bodyPreview,from,toRecipients,receivedDateTime,conversationId";
  const startDate = new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000);
  const dateFilter = `receivedDateTime ge ${startDate.toISOString().slice(0, 10)}T00:00:00Z`;
  const url = `${GRAPH}/me/messages?$filter=${encodeURI(dateFilter)}&$orderby=receivedDateTime desc&$select=${select}&$top=50`;
  return fetchAllPages<LightEmail>(url, maxResults);
}

/**
 * Get all recent sent emails (sentitems folder) within a date range.
 * Counterpart to getRecentEmails for the user's outgoing mail.
 */
export async function getRecentSentEmails(
  months = 6,
  maxResults = 2000
): Promise<LightEmail[]> {
  const select = "id,subject,bodyPreview,from,toRecipients,receivedDateTime,conversationId";
  const startDate = new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000);
  const dateFilter = `sentDateTime ge ${startDate.toISOString().slice(0, 10)}T00:00:00Z`;
  const url = `${GRAPH}/me/mailFolders/sentitems/messages?$filter=${encodeURI(dateFilter)}&$orderby=sentDateTime desc&$select=${select}&$top=50`;
  return fetchAllPages<LightEmail>(url, maxResults);
}

// ─── Contact Cache + Fuzzy Search (for agent) ──────────────────────

interface CachedContact {
  name: string;
  email: string;
  count: number; // frequency of interaction
}

let contactCache: CachedContact[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Remove diacritics/accents from a string for fuzzy comparison.
 */
function removeDiacritics(str: string): string {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}


/**
 * Score a single query word against a single name/email part.
 */
function scoreWordPart(qWord: string, part: string): number {
  // Exact match
  if (part === qWord) return 100;
  // Part starts with query word
  if (part.startsWith(qWord)) return 90;
  // Query word starts with part (partial typing of a longer name)
  if (qWord.startsWith(part)) return 85;
  // Substring match
  if (part.includes(qWord)) return 80;

  // Levenshtein distance
  const dist = levenshtein(qWord, part);
  const maxLen = Math.max(qWord.length, part.length);
  // Threshold scales with word length: 1 for 3 chars, 2 for 4-6, 3 for 7+
  const threshold = qWord.length <= 3 ? 1 : qWord.length <= 6 ? 2 : 3;
  if (dist <= threshold) {
    return 75 * (1 - dist / maxLen);
  }

  // Prefix with typos: compare query word to the beginning of the part
  if (qWord.length < part.length) {
    const partPrefix = part.slice(0, qWord.length);
    const prefixDist = levenshtein(qWord, partPrefix);
    if (prefixDist <= 1) {
      return 70 - prefixDist * 10;
    }
  }

  return 0;
}

/**
 * Compute a fuzzy match score (0 = no match, higher = better).
 * Splits multi-word queries and matches each word independently against name/email parts.
 */
function fuzzyScore(query: string, contact: CachedContact): number {
  const fullQuery = removeDiacritics(query.toLowerCase().trim());
  const fullName = removeDiacritics(contact.name.toLowerCase());
  const emailUser = contact.email.split("@")[0].toLowerCase().replace(/[._-]/g, " ");

  // Exact substring match in full name or email → high score (for multi-word exact match)
  if (fullName.includes(fullQuery)) {
    return 100 - (fullName.length - fullQuery.length);
  }
  if (emailUser.replace(/\s/g, "").includes(fullQuery.replace(/\s/g, ""))) {
    return 95;
  }

  // Split query and target into words
  const queryWords = fullQuery.split(/\s+/).filter(Boolean);
  const nameParts = fullName.split(/[\s\-._]+/).filter(Boolean);
  const emailParts = emailUser.split(/\s+/).filter(Boolean);
  const allParts = [...new Set([...nameParts, ...emailParts])]; // deduplicate

  if (queryWords.length === 0 || allParts.length === 0) return 0;

  // For each query word, find its best match among all parts
  let totalScore = 0;
  let matchedWords = 0;

  for (const qWord of queryWords) {
    let bestWordScore = 0;
    for (const part of allParts) {
      const s = scoreWordPart(qWord, part);
      bestWordScore = Math.max(bestWordScore, s);
    }
    if (bestWordScore > 0) matchedWords++;
    totalScore += bestWordScore;
  }

  // No words matched at all
  if (matchedWords === 0) return 0;

  // Average score across query words, bonus for matching all words
  const avgScore = totalScore / queryWords.length;
  const coverageBonus = matchedWords === queryWords.length ? 10 : 0;

  return avgScore + coverageBonus;
}

/**
 * Build the contact cache from recent emails.
 * Scans inbox + sent items to extract all unique contacts.
 */
async function buildContactCache(): Promise<CachedContact[]> {
  console.log(`[contactCache] Building contact cache from recent emails...`);

  const receivedUrl = `${GRAPH}/me/messages?$select=from&$top=200&$orderby=receivedDateTime desc`;
  const sentUrl = `${GRAPH}/me/mailFolders/sentitems/messages?$select=toRecipients&$top=200&$orderby=sentDateTime desc`;

  const [received, sent] = await Promise.all([
    fetchAllPages<EmailMessage>(receivedUrl, 500).catch((err) => {
      console.warn(`[contactCache] Failed to fetch received:`, err.message);
      return [] as EmailMessage[];
    }),
    fetchAllPages<EmailMessage>(sentUrl, 500).catch((err) => {
      console.warn(`[contactCache] Failed to fetch sent:`, err.message);
      return [] as EmailMessage[];
    }),
  ]);

  console.log(`[contactCache] Fetched ${received.length} received, ${sent.length} sent`);

  const seen = new Map<string, CachedContact>();

  for (const msg of received) {
    if (msg.from?.emailAddress?.address) {
      const addr = msg.from.emailAddress.address.toLowerCase();
      const existing = seen.get(addr);
      if (existing) {
        existing.count++;
      } else {
        seen.set(addr, {
          name: msg.from.emailAddress.name || addr,
          email: msg.from.emailAddress.address,
          count: 1,
        });
      }
    }
  }

  for (const msg of sent) {
    for (const recipient of msg.toRecipients || []) {
      if (recipient.emailAddress?.address) {
        const addr = recipient.emailAddress.address.toLowerCase();
        const existing = seen.get(addr);
        if (existing) {
          existing.count++;
        } else {
          seen.set(addr, {
            name: recipient.emailAddress.name || addr,
            email: recipient.emailAddress.address,
            count: 1,
          });
        }
      }
    }
  }

  const cache = Array.from(seen.values());
  console.log(`[contactCache] Cache built: ${cache.length} unique contacts`);
  return cache;
}

/**
 * Get the contact cache, building it if necessary.
 */
async function getContactCache(): Promise<CachedContact[]> {
  const now = Date.now();
  if (contactCache && (now - cacheTimestamp) < CACHE_TTL) {
    console.log(`[contactCache] Using cached contacts (${contactCache.length} entries, age: ${Math.round((now - cacheTimestamp) / 1000)}s)`);
    return contactCache;
  }
  contactCache = await buildContactCache();
  cacheTimestamp = now;
  return contactCache;
}

// ─── Directory (Microsoft Graph /users) ─────────────────────────────

interface GraphUser {
  displayName?: string;
  givenName?: string;
  surname?: string;
  mail?: string;
  userPrincipalName?: string;
  jobTitle?: string;
  department?: string;
}

// Set to true after the first failure attributable to missing
// User.ReadBasic.All admin consent. We then skip /users for the rest of
// the session — preserves the legacy behavior until Pascal grants consent.
let directorySearchUnavailable = false;

function looksLikeConsentError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /consent_required|AADSTS65001|insufficient privileges|forbidden|403/i.test(msg);
}

/**
 * Search the EPFL directory via Microsoft Graph /users.
 * Requires the User.ReadBasic.All scope (admin-consented).
 * Returns [] if the scope isn't granted yet (degrades to legacy mail-history search).
 */
export async function searchUsersInDirectory(
  query: string
): Promise<Array<{ name: string; email: string; source: "directory"; jobTitle?: string; department?: string; score: number }>> {
  if (directorySearchUnavailable) return [];
  const trimmed = query.trim();
  if (!trimmed) return [];

  // $search wants a quoted value per field. We OR over displayName/givenName/surname/mail.
  // The whole quoted string is URL-encoded so spaces and accents pass through.
  const q = trimmed.replace(/"/g, ""); // drop quotes to avoid breaking the $search syntax
  const clauses = [
    `"displayName:${q}"`,
    `"givenName:${q}"`,
    `"surname:${q}"`,
    `"mail:${q}"`,
  ].join(" OR ");
  const select = "displayName,givenName,surname,mail,userPrincipalName,jobTitle,department";
  const url =
    `${GRAPH}/users` +
    `?$search=${encodeURIComponent(clauses)}` +
    `&$select=${select}` +
    `&$top=25&$count=true`;

  try {
    const resp = await graphFetch<GraphPagedResponse<GraphUser>>(url, {
      headers: { ConsistencyLevel: "eventual" },
    });

    const out: Array<{ name: string; email: string; source: "directory"; jobTitle?: string; department?: string; score: number }> = [];
    for (const u of resp.value) {
      const email = u.mail || u.userPrincipalName;
      if (!email) continue; // skip shared mailboxes / accounts with no addressable identity
      const name = u.displayName || [u.givenName, u.surname].filter(Boolean).join(" ") || email;

      // Filter false positives with the same fuzzy score we apply to mail-history hits.
      // Graph's $search ranking is opaque, so on common names it can return unrelated entries.
      const fScore = fuzzyScore(trimmed, { name, email, count: 1 });
      if (fScore <= 0) {
        console.log(`[searchUsersInDirectory] Filtered (low fuzzy): ${name} <${email}>`);
        continue;
      }

      out.push({
        name,
        email,
        source: "directory",
        jobTitle: u.jobTitle,
        department: u.department,
        score: fScore + 8, // small tie-breaker (a verified directory person beats
                           // mail-history noise at equal name match) — kept well
                           // below the correspondence bonus (+25..+35), so people
                           // you actually email still rank first.
      });
    }

    console.log(`[searchUsersInDirectory] "${trimmed}" → ${out.length} directory hits`);
    return out;
  } catch (err) {
    if (looksLikeConsentError(err)) {
      console.warn(`[searchUsersInDirectory] Scope not granted (User.ReadBasic.All), disabling directory search for this session`);
      directorySearchUnavailable = true;
      return [];
    }
    console.warn(`[searchUsersInDirectory] failed:`, (err as Error).message);
    return [];
  }
}

export interface UserProfile {
  displayName?: string;
  jobTitle?: string;
  department?: string;
  officeLocation?: string;
  mail?: string;
}

/**
 * Fetch a single user's directory profile by email (or UPN).
 * Used to enrich meeting participants with title/department/location.
 *
 * Returns null on any failure: consent missing (sets the session-wide
 * `directorySearchUnavailable` flag like searchUsersInDirectory), 404 for
 * external addresses not in the tenant, or transient errors. Callers should
 * treat null as "no extra info available, skip the enrichment".
 */
export async function getUserByEmail(email: string): Promise<UserProfile | null> {
  if (directorySearchUnavailable) return null;
  const select = "displayName,jobTitle,department,officeLocation,mail";
  const url = `${GRAPH}/users/${encodeURIComponent(email)}?$select=${select}`;
  try {
    return await graphFetch<UserProfile>(url);
  } catch (err) {
    if (looksLikeConsentError(err)) {
      console.warn(`[getUserByEmail] Scope not granted (User.ReadBasic.All), disabling directory lookups for this session`);
      directorySearchUnavailable = true;
      return null;
    }
    const msg = err instanceof Error ? err.message : String(err);
    // 404 for external (non-EPFL) addresses is normal — log at debug level only
    if (/404|Resource.*not found|Request_ResourceNotFound/i.test(msg)) {
      return null;
    }
    console.warn(`[getUserByEmail] ${email} failed:`, msg);
    return null;
  }
}

// ─── Mail-history strategies (legacy fallback path) ────────────────────

interface ScoredContact { name: string; email: string; source: string; score: number; jobTitle?: string; department?: string; count?: number }

/** Strategy: Graph $search on /me/messages from + sentitems to. */
async function searchContactsViaMailHistory(query: string): Promise<ScoredContact[]> {
  const encodedQuery = encodeURIComponent(query);
  const receivedUrl = `${GRAPH}/me/messages?$search="from:${encodedQuery}"&$select=from&$top=30`;
  const sentUrl = `${GRAPH}/me/mailFolders/sentitems/messages?$search="to:${encodedQuery}"&$select=toRecipients&$top=30`;

  const [received, sent] = await Promise.all([
    graphFetch<GraphPagedResponse<EmailMessage>>(receivedUrl).catch((err) => {
      console.warn(`[searchContacts] Graph from: search failed:`, err.message);
      return { value: [] as EmailMessage[] };
    }),
    graphFetch<GraphPagedResponse<EmailMessage>>(sentUrl).catch((err) => {
      console.warn(`[searchContacts] Graph to: search failed:`, err.message);
      return { value: [] as EmailMessage[] };
    }),
  ]);

  const seen = new Map<string, { name: string; email: string; count: number }>();
  for (const msg of received.value) {
    if (msg.from?.emailAddress?.address) {
      const addr = msg.from.emailAddress.address.toLowerCase();
      const e = seen.get(addr);
      if (e) e.count++;
      else seen.set(addr, { name: msg.from.emailAddress.name, email: msg.from.emailAddress.address, count: 1 });
    }
  }
  for (const msg of sent.value) {
    for (const r of msg.toRecipients || []) {
      if (r.emailAddress?.address) {
        const addr = r.emailAddress.address.toLowerCase();
        const e = seen.get(addr);
        if (e) e.count++;
        else seen.set(addr, { name: r.emailAddress.name, email: r.emailAddress.address, count: 1 });
      }
    }
  }

  const out: ScoredContact[] = [];
  for (const c of seen.values()) {
    const fScore = fuzzyScore(query, { name: c.name, email: c.email, count: c.count });
    if (fScore > 0) out.push({ name: c.name, email: c.email, source: "email", score: fScore, count: c.count });
  }
  return out;
}

/**
 * Search for contacts by name.
 * Primary: EPFL directory via Graph /users (requires User.ReadBasic.All).
 * Fallbacks (always run, dedup-merged with directory hits):
 *   - Graph $search on /me/messages from/to fields (catches external contacts in mail history)
 *   - ServiceDesk extraction (contacts who only appear in ServiceNow ticket bodies)
 * If the directory returns 0 hits AND mail-history returns 0 hits, also runs a
 * local Levenshtein search over the cached recent-contacts list (slow, last resort).
 */
export async function searchContactsByName(
  query: string
): Promise<Array<{ name: string; email: string; source?: string; jobTitle?: string; department?: string }>> {
  console.log(`[searchContacts] Searching for "${query}"`);

  // Run directory + mail-history in parallel — both are network calls, mail-history
  // is cheap to keep running even on a directory hit (covers external contacts).
  const [directoryHits, mailHits] = await Promise.all([
    searchUsersInDirectory(query),
    searchContactsViaMailHistory(query),
  ]);

  console.log(`[searchContacts] directory=${directoryHits.length} mail-history=${mailHits.length}`);

  // Merge directory + mail-history by email. Having actually corresponded with
  // someone is a strong relevance signal for "my contacts" intents, so a
  // mail-history hit adds a bonus (scaled by interaction count) — otherwise a
  // person you email daily gets buried under directory namesakes (the +20
  // directory boost). A contact present in BOTH sources is the strongest match:
  // keep the directory metadata (job/department) AND add the correspondence bonus.
  const byEmail = new Map<string, ScoredContact>();
  for (const c of directoryHits) byEmail.set(c.email.toLowerCase(), { ...c });
  for (const c of mailHits) {
    const k = c.email.toLowerCase();
    const historyBonus = 25 + Math.min(c.count ?? 1, 10);
    const existing = byEmail.get(k);
    if (existing) {
      existing.score = Math.max(existing.score, c.score) + historyBonus;
      existing.source = "directory+email";
    } else {
      byEmail.set(k, { ...c, score: c.score + historyBonus });
    }
  }

  // ServiceDesk: name-only entries (no email), so they don't dedup with the others
  try {
    const sdContacts = await searchContactsInServiceDesk(query);
    for (const sd of sdContacts) {
      // Use a synthetic key so multiple no-email entries don't collide
      byEmail.set(`__sd__${sd.name.toLowerCase()}`, {
        name: sd.name,
        email: "",
        source: "servicedesk",
        score: 70 + sd.ticketCount,
      });
    }
    console.log(`[searchContacts] ServiceDesk: ${sdContacts.length} contacts`);
  } catch (err) {
    console.warn(`[searchContacts] ServiceDesk search failed:`, (err as Error).message);
  }

  // If still nothing, fall back to the slow local-cache Levenshtein scan.
  if (byEmail.size === 0) {
    console.log(`[searchContacts] No directory/mail-history/ServiceDesk hits — trying local cache fuzzy`);
    const cache = await getContactCache();
    const scored = cache
      .map((c) => ({ contact: c, score: fuzzyScore(query, c) }))
      .filter((x) => x.score > 30)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    for (const { contact, score } of scored) {
      byEmail.set(contact.email.toLowerCase(), { name: contact.name, email: contact.email, source: "email", score });
    }
  }

  const merged = Array.from(byEmail.values()).sort((a, b) => b.score - a.score).slice(0, 25);
  const final = merged.map(({ name, email, source, jobTitle, department }) => ({
    name, email, source,
    ...(jobTitle ? { jobTitle } : {}),
    ...(department ? { department } : {}),
  }));
  console.log(`[searchContacts] Final results:`, final);
  return final;
}

/**
 * Full-text search across all messages.
 *
 * `sender` (optional) restricts to emails FROM a given person (name or address),
 * combined with the free-text query in a SINGLE Graph $search via the KQL
 * `from:` operator — so "from:matéo docling" is one fast request, no embeddings.
 */
export async function searchEmails(
  query: string,
  maxResults = 20,
  dateRange?: DateRange,
  sender?: string
): Promise<LightEmail[]> {
  // Include `body` in the projection so the search returns the full content in
  // the SAME paginated request (like searchEmailsFromSender) — no per-email
  // fetch. Lets callers read the actual content (e.g. extract a URL).
  const select = "id,subject,bodyPreview,body,from,toRecipients,receivedDateTime,conversationId,hasAttachments";

  if (dateRange) {
    // Can't combine $search + $filter on messages, so $filter date + post-filter
    // text client-side. Sender is also matched client-side here (against from
    // name/address). The body is in the projection, so deep matches count too.
    const dateFilter = buildDateFilter(dateRange);
    const url = `${GRAPH}/me/messages?$filter=${encodeURI(dateFilter)}&$orderby=receivedDateTime desc&$select=${select}&$top=50`;
    const results = await fetchAllPages<LightEmail>(url, 1000);
    const lower = query.toLowerCase();
    const senderLower = sender?.toLowerCase();
    const filtered = results.filter(e => {
      const textMatch = !lower ||
        e.subject?.toLowerCase().includes(lower) ||
        e.bodyPreview?.toLowerCase().includes(lower) ||
        e.body?.content?.toLowerCase().includes(lower) ||
        e.from?.emailAddress?.name?.toLowerCase().includes(lower) ||
        e.from?.emailAddress?.address?.toLowerCase().includes(lower);
      const senderMatch = !senderLower ||
        e.from?.emailAddress?.name?.toLowerCase().includes(senderLower) ||
        e.from?.emailAddress?.address?.toLowerCase().includes(senderLower);
      return textMatch && senderMatch;
    });
    return filtered.slice(0, maxResults);
  }

  // KQL: `from:<sender>` narrows to the sender, ANDed with the free-text query.
  // Quote the sender if it contains spaces (e.g. a full name) so KQL treats it
  // as one phrase rather than two terms.
  const fromClause = sender ? `from:${/\s/.test(sender) ? `"${sender}"` : sender} ` : "";
  const kql = `${fromClause}${query}`.trim();
  const url = `${GRAPH}/me/messages?$search="${encodeURIComponent(kql)}"&$select=${select}&$top=50`;
  return fetchAllPages<LightEmail>(url, maxResults);
}

// ─── ServiceDesk / ServiceNow Integration ───────────────────────────

const SERVICEDESK_EMAIL = "1234@epfl.ch";

/**
 * Strip HTML tags from a string, returning plain text.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract person names from email body text using a sliding window + fuzzy match.
 * Returns matching name strings found in the text.
 */
function extractNamesFromBody(bodyText: string, query: string): string[] {
  const words = bodyText.split(/\s+/).filter((w) => w.length > 1);
  const normalizedQuery = removeDiacritics(query.toLowerCase());
  const queryWords = normalizedQuery.split(/\s+/).filter(Boolean);
  const found: string[] = [];

  // Sliding window of 2-4 words (typical name length)
  for (let windowSize = 2; windowSize <= 4; windowSize++) {
    for (let i = 0; i <= words.length - windowSize; i++) {
      const window = words.slice(i, i + windowSize);
      const windowText = window.join(" ");
      const normalizedWindow = removeDiacritics(windowText.toLowerCase());
      const windowParts = normalizedWindow.split(/\s+/);

      // Check if every query word fuzzy-matches a window word
      let allMatch = true;
      for (const qw of queryWords) {
        let wordMatched = false;
        for (const wp of windowParts) {
          const dist = levenshtein(qw, wp);
          const threshold = qw.length <= 3 ? 1 : qw.length <= 6 ? 2 : 3;
          if (dist <= threshold) {
            wordMatched = true;
            break;
          }
        }
        if (!wordMatched) {
          allMatch = false;
          break;
        }
      }

      if (allMatch) {
        // Clean up: capitalize each word properly
        const cleanName = window
          .map((w) => w.replace(/[^a-zA-ZÀ-ÿ\-]/g, ""))
          .filter((w) => w.length > 1)
          .join(" ");
        if (cleanName && !found.includes(cleanName)) {
          found.push(cleanName);
        }
      }
    }
  }

  return found;
}

/**
 * Search for contacts in ServiceDesk/ServiceNow emails.
 * Uses Graph $search to find ServiceDesk emails mentioning the query,
 * then extracts the actual person name from the email body.
 */
export async function searchContactsInServiceDesk(
  query: string
): Promise<Array<{ name: string; ticketCount: number }>> {
  const encodedQuery = encodeURIComponent(query);
  const url = `${GRAPH}/me/messages?$search="from:${SERVICEDESK_EMAIL} ${encodedQuery}"&$select=id,subject,body,bodyPreview&$top=20`;

  console.log(`[serviceDeskSearch] Searching ServiceDesk emails for "${query}"`);

  let messages: EmailMessage[];
  try {
    messages = await fetchAllPages<EmailMessage>(url, 20);
  } catch (err) {
    console.warn(`[serviceDeskSearch] Search failed:`, (err as Error).message);
    return [];
  }

  console.log(`[serviceDeskSearch] Found ${messages.length} ServiceDesk emails`);

  // Extract names from email bodies
  const nameCounts = new Map<string, number>();

  for (const msg of messages) {
    const bodyText = msg.body?.content
      ? stripHtml(msg.body.content)
      : msg.bodyPreview || "";

    const names = extractNamesFromBody(bodyText, query);
    for (const name of names) {
      nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
    }
  }

  const results = Array.from(nameCounts.entries())
    .map(([name, ticketCount]) => ({ name, ticketCount }))
    .sort((a, b) => b.ticketCount - a.ticketCount)
    .slice(0, 5);

  console.log(`[serviceDeskSearch] Extracted names:`, results);
  return results;
}

/**
 * Get ServiceDesk emails that mention a specific person by name.
 * Used to include ServiceNow ticket exchanges in interaction summaries.
 */
export async function getServiceDeskEmailsForPerson(
  personName: string,
  maxResults = 30,
  dateRange?: DateRange,
  onPage?: (itemsSoFar: number) => void
): Promise<EmailMessage[]> {
  // Split name into words and match each independently (no quotes)
  // so "Pablo Tanner" matches "Pablo Sidney Tanner" or "Tanner, Pablo"
  const nameWords = personName.trim().split(/\s+/);
  const select = "id,subject,body,bodyPreview,from,receivedDateTime,parentFolderId,isRead";

  // $search narrows to the ServiceDesk sender + name mentions server-side. The date
  // range is pushed into the KQL query (received:start..end) so the search is bounded
  // server-side — without it, $search returns only the ~1000 most-recent matches and
  // older years get truncated. The whole KQL string is encoded once.
  const search = `from:${SERVICEDESK_EMAIL} ${nameWords.join(" ")}${kqlDateClause(dateRange, "received")}`;
  const url = `${GRAPH}/me/messages?$search="${encodeURIComponent(search)}"&$select=${select}&$top=50`;

  console.log(`[serviceDeskEmails] Fetching ServiceDesk emails mentioning "${personName}" (words: ${nameWords.join(", ")})`);

  try {
    // Deep fetch for date ranges so the client date filter reaches old tickets.
    const fetchCap = dateRange ? Math.max(maxResults * 20, 600) : maxResults;
    let allMessages = await fetchAllPages<EmailMessage>(url, fetchCap, undefined, onPage);

    if (dateRange) {
      allMessages = filterByDate(allMessages, "receivedDateTime", dateRange);
    }

    // Post-filter: verify the person's name actually appears in the body
    // ($search without quotes can return loose matches).
    const filtered = allMessages.filter((msg) => {
      const bodyText = msg.body?.content
        ? stripHtml(msg.body.content).toLowerCase()
        : (msg.bodyPreview || "").toLowerCase();
      return nameWords.every((w) => bodyText.includes(w.toLowerCase()));
    });

    console.log(`[serviceDeskEmails] Found ${allMessages.length} emails, ${filtered.length} after name verification`);
    return filtered.slice(0, maxResults);
  } catch (err) {
    console.warn(`[serviceDeskEmails] Search failed:`, (err as Error).message);
    return [];
  }
}
