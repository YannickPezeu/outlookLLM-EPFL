import { getGraphToken } from "./authService";
import { config } from "../config";
import { distance as levenshtein } from "fastest-levenshtein";

const GRAPH = config.graph.baseUrl;

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

export interface MailFolder {
  id: string;
  displayName: string;
  parentFolderId?: string;
  childFolderCount: number;
  totalItemCount: number;
  unreadItemCount: number;
}

export interface LightEmail {
  id: string;
  subject: string;
  bodyPreview: string;
  from?: { emailAddress: { name: string; address: string } };
  toRecipients?: Array<{ emailAddress: { name: string; address: string } }>;
  receivedDateTime: string;
  conversationId: string;
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
 * Client-side sender filtering (used when $filter handles dates only).
 */
function filterBySender(items: EmailMessage[], senderEmail: string): EmailMessage[] {
  const lower = senderEmail.toLowerCase();
  return items.filter(e => e.from?.emailAddress?.address?.toLowerCase() === lower);
}

function filterByRecipient(items: EmailMessage[], recipientEmail: string): EmailMessage[] {
  const lower = recipientEmail.toLowerCase();
  return items.filter(e =>
    e.toRecipients?.some(r => r.emailAddress?.address?.toLowerCase() === lower)
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function graphFetch<T>(url: string, options?: RequestInit): Promise<T> {
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

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[Graph] Error ${response.status}:`, errorBody);
    throw new Error(`Graph API error ${response.status}: ${errorBody}`);
  }

  return response.json();
}

/**
 * Fetch all pages up to maxItems, following @odata.nextLink.
 */
async function fetchAllPages<T>(url: string, maxItems: number): Promise<T[]> {
  const items: T[] = [];
  let nextUrl: string | undefined = url;

  while (nextUrl && items.length < maxItems) {
    const page: GraphPagedResponse<T> = await graphFetch<GraphPagedResponse<T>>(nextUrl);
    items.push(...page.value);
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
  dateRange?: DateRange
): Promise<EmailMessage[]> {
  const select = "id,subject,bodyPreview,body,from,receivedDateTime,parentFolderId,isRead";

  if (dateRange) {
    // $filter on date only, post-filter sender client-side
    const dateFilter = buildDateFilter(dateRange);
    const url = `${GRAPH}/me/messages?$filter=${encodeURI(dateFilter)}&$orderby=receivedDateTime desc&$select=${select}&$top=50`;
    const results = await fetchAllPages<EmailMessage>(url, 1000);
    return filterBySender(results, senderEmail).slice(0, maxResults);
  }

  const url = `${GRAPH}/me/messages?$search="from:${senderEmail}"&$select=${select}&$top=50`;
  return fetchAllPages<EmailMessage>(url, maxResults);
}

/**
 * Search emails SENT TO a specific recipient.
 */
export async function searchEmailsSentTo(
  recipientEmail: string,
  maxResults = config.defaults.maxEmailsToFetch,
  dateRange?: DateRange
): Promise<EmailMessage[]> {
  const select = "id,subject,bodyPreview,body,toRecipients,sentDateTime,parentFolderId";

  if (dateRange) {
    // $filter on date only, post-filter recipient client-side
    const dateFilter = buildDateFilter(dateRange, "sentDateTime");
    const url = `${GRAPH}/me/mailFolders/sentitems/messages?$filter=${encodeURI(dateFilter)}&$orderby=sentDateTime desc&$select=${select}&$top=50`;
    const results = await fetchAllPages<EmailMessage>(url, 1000);
    return filterByRecipient(results, recipientEmail).slice(0, maxResults);
  }

  const url = `${GRAPH}/me/mailFolders/sentitems/messages?$search="to:${recipientEmail}"&$select=${select}&$top=50`;
  return fetchAllPages<EmailMessage>(url, maxResults);
}

/**
 * Get all interactions (sent + received) with a specific email address.
 */
export async function getAllInteractions(
  email: string,
  maxPerDirection = config.defaults.maxEmailsForSummary,
  dateRange?: DateRange
): Promise<{ received: EmailMessage[]; sent: EmailMessage[] }> {
  const [received, sent] = await Promise.all([
    searchEmailsFromSender(email, maxPerDirection, dateRange),
    searchEmailsSentTo(email, maxPerDirection, dateRange),
  ]);

  return { received, sent };
}

// ─── Folder Management ───────────────────────────────────────────────

/**
 * List all top-level mail folders.
 */
export async function listFolders(): Promise<MailFolder[]> {
  const url = `${GRAPH}/me/mailFolders?$top=100`;
  return fetchAllPages<MailFolder>(url, 100);
}

/**
 * List child folders of a given folder.
 */
export async function listChildFolders(parentFolderId: string): Promise<MailFolder[]> {
  const url = `${GRAPH}/me/mailFolders/${parentFolderId}/childFolders?$top=100`;
  return fetchAllPages<MailFolder>(url, 100);
}

/**
 * Create a new mail folder.
 */
export async function createFolder(displayName: string, parentFolderId?: string): Promise<MailFolder> {
  const url = parentFolderId
    ? `${GRAPH}/me/mailFolders/${parentFolderId}/childFolders`
    : `${GRAPH}/me/mailFolders`;

  return graphFetch<MailFolder>(url, {
    method: "POST",
    body: JSON.stringify({ displayName }),
  });
}

/**
 * Move a message to a different folder.
 */
export async function moveMessage(messageId: string, destinationFolderId: string): Promise<EmailMessage> {
  const url = `${GRAPH}/me/messages/${messageId}/move`;
  return graphFetch<EmailMessage>(url, {
    method: "POST",
    body: JSON.stringify({ destinationId: destinationFolderId }),
  });
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
  return graphFetch<CalendarEvent>(url);
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
  return fetchAllPages<CalendarEvent>(url, maxResults);
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
 */
export async function collectEmailsWithParticipant(
  email: string,
  maxPerDirection = config.defaults.maxEmailsPerParticipant
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

  return Array.from(byConversation.values());
}

/**
 * Get multiple emails by ID with full body (for the final reading phase).
 * Parallelized with concurrency limit.
 */
export async function getEmailsBatch(
  messageIds: string[],
  concurrency = 2
): Promise<EmailMessage[]> {
  const results: EmailMessage[] = [];

  for (let i = 0; i < messageIds.length; i += concurrency) {
    const batch = messageIds.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((id) => getEmail(id)));
    results.push(...batchResults);
  }

  return results;
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

/**
 * Search for contacts by name.
 * Strategy 1: Graph $search on from/to fields (fast, exact/close matches).
 * Strategy 2: Local cache + Levenshtein fuzzy matching (handles typos, missing accents).
 * Strategy 3: ServiceDesk emails (for contacts who only appear in ServiceNow tickets).
 * All strategies run, results are merged and tagged with their source.
 */
export async function searchContactsByName(
  query: string
): Promise<Array<{ name: string; email: string; source?: string }>> {
  console.log(`[searchContacts] Searching for "${query}"`);

  const results: Array<{ name: string; email: string; source: string; score: number }> = [];

  // --- Strategy 1: Graph $search on from/to ---
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

  const graphSeen = new Map<string, { name: string; email: string; count: number }>();

  for (const msg of received.value) {
    if (msg.from?.emailAddress?.address) {
      const addr = msg.from.emailAddress.address.toLowerCase();
      const existing = graphSeen.get(addr);
      if (existing) existing.count++;
      else graphSeen.set(addr, { name: msg.from.emailAddress.name, email: msg.from.emailAddress.address, count: 1 });
    }
  }
  for (const msg of sent.value) {
    for (const r of msg.toRecipients || []) {
      if (r.emailAddress?.address) {
        const addr = r.emailAddress.address.toLowerCase();
        const existing = graphSeen.get(addr);
        if (existing) existing.count++;
        else graphSeen.set(addr, { name: r.emailAddress.name, email: r.emailAddress.address, count: 1 });
      }
    }
  }

  for (const contact of graphSeen.values()) {
    // Score Graph results with fuzzy to filter out false positives
    const fScore = fuzzyScore(query, { name: contact.name, email: contact.email, count: contact.count });
    if (fScore > 0) {
      results.push({ name: contact.name, email: contact.email, source: "email", score: fScore });
    } else {
      console.log(`[searchContacts] Graph result filtered out (low fuzzy score): ${contact.name} <${contact.email}>`);
    }
  }

  console.log(`[searchContacts] Strategy 1 (Graph $search): ${results.length} contacts after fuzzy filter`);

  // --- Strategy 2: Fuzzy search on local contact cache ---
  const cache = await getContactCache();
  const scored = cache
    .map((contact) => ({ contact, score: fuzzyScore(query, contact) }))
    .filter((x) => x.score > 30) // Higher threshold to avoid noise
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  for (const { contact, score } of scored) {
    // Don't add if already found via Graph
    if (!results.some((r) => r.email.toLowerCase() === contact.email.toLowerCase())) {
      results.push({ name: contact.name, email: contact.email, source: "email", score });
    }
  }

  console.log(`[searchContacts] Strategy 2 (fuzzy cache): ${scored.length} additional matches`);

  // --- Strategy 3: ServiceDesk emails ---
  try {
    const sdContacts = await searchContactsInServiceDesk(query);
    for (const sd of sdContacts) {
      // ServiceDesk contacts don't have an email, tag them as servicedesk
      results.push({ name: sd.name, email: "", source: "servicedesk", score: 70 + sd.ticketCount });
    }
    console.log(`[searchContacts] Strategy 3 (ServiceDesk): ${sdContacts.length} contacts`);
  } catch (err) {
    console.warn(`[searchContacts] ServiceDesk search failed:`, (err as Error).message);
  }

  // Sort by score desc, deduplicate, return top 10
  results.sort((a, b) => b.score - a.score);
  const final = results.slice(0, 10).map(({ name, email, source }) => ({ name, email, source }));

  console.log(`[searchContacts] Final results:`, final);
  return final;
}

/**
 * Full-text search across all messages.
 */
export async function searchEmails(
  query: string,
  maxResults = 20,
  dateRange?: DateRange
): Promise<LightEmail[]> {
  const select = "id,subject,bodyPreview,from,toRecipients,receivedDateTime,conversationId";

  if (dateRange) {
    // Can't combine $search + $filter on messages, so $filter date + post-filter text client-side
    const dateFilter = buildDateFilter(dateRange);
    const url = `${GRAPH}/me/messages?$filter=${encodeURI(dateFilter)}&$orderby=receivedDateTime desc&$select=${select}&$top=50`;
    const results = await fetchAllPages<LightEmail>(url, 1000);
    const lower = query.toLowerCase();
    const filtered = results.filter(e =>
      e.subject?.toLowerCase().includes(lower) ||
      e.bodyPreview?.toLowerCase().includes(lower) ||
      e.from?.emailAddress?.name?.toLowerCase().includes(lower) ||
      e.from?.emailAddress?.address?.toLowerCase().includes(lower)
    );
    return filtered.slice(0, maxResults);
  }

  const encodedQuery = encodeURIComponent(query);
  const url = `${GRAPH}/me/messages?$search="${encodedQuery}"&$select=${select}&$top=50`;
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
  dateRange?: DateRange
): Promise<EmailMessage[]> {
  // Split name into words and search each independently (no quotes)
  // so "Pablo Tanner" matches "Pablo Sidney Tanner" or "Tanner, Pablo"
  const nameWords = personName.trim().split(/\s+/);
  const searchTerms = nameWords.map((w) => encodeURIComponent(w)).join(" ");
  let url: string;

  if (dateRange) {
    // $filter date + $search for servicedesk sender won't combine, so use $filter date only
    // then post-filter for servicedesk sender + name in body
    const dateFilter = buildDateFilter(dateRange);
    url = `${GRAPH}/me/messages?$filter=${encodeURI(dateFilter)}&$orderby=receivedDateTime desc&$select=id,subject,body,bodyPreview,from,receivedDateTime,parentFolderId,isRead&$top=50`;
  } else {
    url = `${GRAPH}/me/messages?$search="from:${SERVICEDESK_EMAIL} ${searchTerms}"&$select=id,subject,body,bodyPreview,from,receivedDateTime,parentFolderId,isRead&$top=50`;
  }

  console.log(`[serviceDeskEmails] Fetching ServiceDesk emails mentioning "${personName}" (words: ${nameWords.join(", ")})`);

  try {
    let allMessages = await fetchAllPages<EmailMessage>(url, dateRange ? 1000 : maxResults);

    // When using $filter (date mode), also filter by ServiceDesk sender
    if (dateRange) {
      allMessages = filterBySender(allMessages, SERVICEDESK_EMAIL);
    }

    // Post-filter: verify the person's name actually appears in the body
    // (Graph $search without quotes can return loose matches)
    const filtered = allMessages.filter((msg) => {
      const bodyText = msg.body?.content
        ? stripHtml(msg.body.content).toLowerCase()
        : (msg.bodyPreview || "").toLowerCase();
      // Check that all name words appear somewhere in the body
      return nameWords.every((w) => bodyText.includes(w.toLowerCase()));
    });

    console.log(`[serviceDeskEmails] Found ${allMessages.length} emails, ${filtered.length} after name verification`);
    return filtered.slice(0, maxResults);
  } catch (err) {
    console.warn(`[serviceDeskEmails] Search failed:`, (err as Error).message);
    return [];
  }
}
