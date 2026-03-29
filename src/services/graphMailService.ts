import { getGraphToken } from "./authService";
import { config } from "../config";

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

// ─── Contact & Full-text Search (for agent) ─────────────────────────

/**
 * Search for contacts by name using Graph $search on messages.
 * Looks in both received and sent emails, deduplicates by email address.
 * Handles partial names, missing accents, etc. (Graph search is fuzzy).
 * Falls back to general search if from:/to: returns nothing.
 */
export async function searchContactsByName(
  query: string
): Promise<Array<{ name: string; email: string }>> {
  const encodedQuery = encodeURIComponent(query);
  const select = "from";

  // Strategy 1: search from: and to: fields
  const receivedUrl = `${GRAPH}/me/messages?$search="from:${encodedQuery}"&$select=${select}&$top=30`;
  const sentUrl = `${GRAPH}/me/mailFolders/sentitems/messages?$search="to:${encodedQuery}"&$select=toRecipients&$top=30`;

  console.log(`[searchContacts] Searching for "${query}" (encoded: ${encodedQuery})`);
  console.log(`[searchContacts] Received URL: ${receivedUrl}`);
  console.log(`[searchContacts] Sent URL: ${sentUrl}`);

  const [received, sent] = await Promise.all([
    graphFetch<GraphPagedResponse<EmailMessage>>(receivedUrl).catch((err) => {
      console.warn(`[searchContacts] from: search failed:`, err.message);
      return { value: [] as EmailMessage[] };
    }),
    graphFetch<GraphPagedResponse<EmailMessage>>(sentUrl).catch((err) => {
      console.warn(`[searchContacts] to: search failed:`, err.message);
      return { value: [] as EmailMessage[] };
    }),
  ]);

  console.log(`[searchContacts] from: returned ${received.value.length} messages, to: returned ${sent.value.length} messages`);

  // Extract unique contacts by email (case-insensitive)
  const seen = new Map<string, { name: string; email: string; count: number }>();

  for (const msg of received.value) {
    if (msg.from?.emailAddress) {
      const addr = msg.from.emailAddress.address.toLowerCase();
      const existing = seen.get(addr);
      if (existing) {
        existing.count++;
      } else {
        seen.set(addr, {
          name: msg.from.emailAddress.name,
          email: msg.from.emailAddress.address,
          count: 1,
        });
      }
    }
  }

  for (const msg of sent.value) {
    for (const recipient of msg.toRecipients || []) {
      const addr = recipient.emailAddress.address.toLowerCase();
      const existing = seen.get(addr);
      if (existing) {
        existing.count++;
      } else {
        seen.set(addr, {
          name: recipient.emailAddress.name,
          email: recipient.emailAddress.address,
          count: 1,
        });
      }
    }
  }

  // Strategy 2: if no results, fallback to general search and extract contacts
  if (seen.size === 0) {
    console.log(`[searchContacts] No results from from:/to:, trying general search`);
    const fallbackUrl = `${GRAPH}/me/messages?$search="${encodedQuery}"&$select=from,toRecipients&$top=30`;
    console.log(`[searchContacts] Fallback URL: ${fallbackUrl}`);

    try {
      const fallback = await graphFetch<GraphPagedResponse<EmailMessage>>(fallbackUrl);
      console.log(`[searchContacts] Fallback returned ${fallback.value.length} messages`);

      for (const msg of fallback.value) {
        // Check from field
        if (msg.from?.emailAddress) {
          const fromName = msg.from.emailAddress.name?.toLowerCase() || "";
          const fromAddr = msg.from.emailAddress.address?.toLowerCase() || "";
          if (fromName.includes(query.toLowerCase()) || fromAddr.includes(query.toLowerCase())) {
            const addr = msg.from.emailAddress.address.toLowerCase();
            const existing = seen.get(addr);
            if (existing) {
              existing.count++;
            } else {
              seen.set(addr, {
                name: msg.from.emailAddress.name,
                email: msg.from.emailAddress.address,
                count: 1,
              });
            }
          }
        }
        // Check toRecipients
        for (const recipient of msg.toRecipients || []) {
          const rName = recipient.emailAddress.name?.toLowerCase() || "";
          const rAddr = recipient.emailAddress.address?.toLowerCase() || "";
          if (rName.includes(query.toLowerCase()) || rAddr.includes(query.toLowerCase())) {
            const addr = recipient.emailAddress.address.toLowerCase();
            const existing = seen.get(addr);
            if (existing) {
              existing.count++;
            } else {
              seen.set(addr, {
                name: recipient.emailAddress.name,
                email: recipient.emailAddress.address,
                count: 1,
              });
            }
          }
        }
      }
      console.log(`[searchContacts] Fallback extracted ${seen.size} unique contacts`);
    } catch (err) {
      console.warn(`[searchContacts] Fallback search also failed:`, (err as Error).message);
    }
  }

  const results = Array.from(seen.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map(({ name, email }) => ({ name, email }));

  console.log(`[searchContacts] Final results:`, results);
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
