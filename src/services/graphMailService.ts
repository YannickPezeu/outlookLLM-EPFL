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

interface GraphPagedResponse<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function graphFetch<T>(url: string, options?: RequestInit): Promise<T> {
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
  maxResults = config.defaults.maxEmailsToFetch
): Promise<EmailMessage[]> {
  const select = "id,subject,bodyPreview,body,from,receivedDateTime,parentFolderId,isRead";
  const url = `${GRAPH}/me/messages?$search="from:${senderEmail}"&$select=${select}&$top=${Math.min(maxResults, 50)}`;

  return fetchAllPages<EmailMessage>(url, maxResults);
}

/**
 * Search emails SENT TO a specific recipient.
 */
export async function searchEmailsSentTo(
  recipientEmail: string,
  maxResults = config.defaults.maxEmailsToFetch
): Promise<EmailMessage[]> {
  // Use $search for sent items (OData $filter on toRecipients is limited)
  const url = `${GRAPH}/me/mailFolders/sentitems/messages?$search="to:${recipientEmail}"&$select=id,subject,bodyPreview,body,toRecipients,sentDateTime,parentFolderId&$top=${Math.min(maxResults, 50)}`;

  return fetchAllPages<EmailMessage>(url, maxResults);
}

/**
 * Get all interactions (sent + received) with a specific email address.
 */
export async function getAllInteractions(
  email: string,
  maxPerDirection = config.defaults.maxEmailsForSummary
): Promise<{ received: EmailMessage[]; sent: EmailMessage[] }> {
  const [received, sent] = await Promise.all([
    searchEmailsFromSender(email, maxPerDirection),
    searchEmailsSentTo(email, maxPerDirection),
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
  const url = `${GRAPH}/me/calendarView?startDateTime=${startDateTime}&endDateTime=${endDateTime}&$select=id,subject,bodyPreview,start,end,attendees,isOrganizer,organizer,seriesMasterId&$orderby=start/dateTime desc&$top=${Math.min(maxResults, 50)}`;
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
  const url = `${GRAPH}/me/messages?$search="from:${senderEmail}"&$select=${select}&$top=${Math.min(maxResults, 50)}`;

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
  const url = `${GRAPH}/me/mailFolders/sentitems/messages?$search="to:${recipientEmail}"&$select=${select}&$top=${Math.min(maxResults, 50)}`;

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
 * Strategy 1: Graph $search (fast, works well for exact/close matches).
 * Strategy 2: Local cache + Levenshtein fuzzy matching (handles typos, missing accents).
 */
export async function searchContactsByName(
  query: string
): Promise<Array<{ name: string; email: string }>> {
  console.log(`[searchContacts] Searching for "${query}"`);

  // --- Strategy 1: Graph $search ---
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
      const existing = seen.get(addr);
      if (existing) existing.count++;
      else seen.set(addr, { name: msg.from.emailAddress.name, email: msg.from.emailAddress.address, count: 1 });
    }
  }
  for (const msg of sent.value) {
    for (const r of msg.toRecipients || []) {
      if (r.emailAddress?.address) {
        const addr = r.emailAddress.address.toLowerCase();
        const existing = seen.get(addr);
        if (existing) existing.count++;
        else seen.set(addr, { name: r.emailAddress.name, email: r.emailAddress.address, count: 1 });
      }
    }
  }

  if (seen.size > 0) {
    const results = Array.from(seen.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map(({ name, email }) => ({ name, email }));
    console.log(`[searchContacts] Graph $search found ${results.length} contacts`);
    return results;
  }

  // --- Strategy 2: Fuzzy search on local contact cache ---
  console.log(`[searchContacts] Graph $search returned nothing, falling back to fuzzy cache search`);
  const cache = await getContactCache();

  const scored = cache
    .map((contact) => ({ contact, score: fuzzyScore(query, contact) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.contact.count - a.contact.count;
    })
    .slice(0, 10);

  const results = scored.map(({ contact, score }) => {
    console.log(`[searchContacts]   ${contact.name} <${contact.email}> — score=${score.toFixed(1)}, freq=${contact.count}`);
    return { name: contact.name, email: contact.email };
  });

  console.log(`[searchContacts] Fuzzy search found ${results.length} matches for "${query}"`);
  return results;
}

/**
 * Full-text search across all messages.
 */
export async function searchEmails(
  query: string,
  maxResults = 20
): Promise<LightEmail[]> {
  const select = "id,subject,bodyPreview,from,toRecipients,receivedDateTime,conversationId";
  const encodedQuery = encodeURIComponent(query);
  const url = `${GRAPH}/me/messages?$search="${encodedQuery}"&$select=${select}&$top=${Math.min(maxResults, 50)}`;
  return fetchAllPages<LightEmail>(url, maxResults);
}
