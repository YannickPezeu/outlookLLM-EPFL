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
}

export interface MailFolder {
  id: string;
  displayName: string;
  parentFolderId?: string;
  childFolderCount: number;
  totalItemCount: number;
  unreadItemCount: number;
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
  const filter = encodeURIComponent(`from/emailAddress/address eq '${senderEmail}'`);
  const select = "id,subject,bodyPreview,body,from,receivedDateTime,parentFolderId,isRead";
  const url = `${GRAPH}/me/messages?$filter=${filter}&$select=${select}&$orderby=receivedDateTime desc&$top=${Math.min(maxResults, 50)}`;

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
  const url = `${GRAPH}/me/mailFolders/sentitems/messages?$search="to:${recipientEmail}"&$select=id,subject,bodyPreview,body,toRecipients,sentDateTime,parentFolderId&$orderby=sentDateTime desc&$top=${Math.min(maxResults, 50)}`;

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
  const url = `${GRAPH}/me/messages/${messageId}?$select=id,subject,body,bodyPreview,from,toRecipients,receivedDateTime,sentDateTime,parentFolderId,isRead`;
  return graphFetch<EmailMessage>(url);
}
