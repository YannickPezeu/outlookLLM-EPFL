/**
 * Shared mail/calendar types used by both the add-in and eval scripts.
 * These are pure type definitions with NO runtime dependencies.
 */

export interface EmailAddress {
  name: string;
  address: string;
}

export interface EmailMessage {
  id: string;
  subject: string;
  bodyPreview: string;
  body?: { contentType: string; content: string };
  from?: { emailAddress: EmailAddress };
  toRecipients?: Array<{ emailAddress: EmailAddress }>;
  receivedDateTime: string;
  sentDateTime?: string;
  parentFolderId: string;
  isRead: boolean;
  hasAttachments?: boolean;
  attachmentTexts?: Array<{ name: string; text: string }>;
}

export interface LightEmail {
  id: string;
  subject: string;
  bodyPreview: string;
  from?: { emailAddress: EmailAddress };
  toRecipients?: Array<{ emailAddress: EmailAddress }>;
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
    emailAddress: EmailAddress;
    type: string;
    status?: { response: string };
  }>;
  isOrganizer: boolean;
  organizer?: { emailAddress: EmailAddress };
  seriesMasterId?: string;
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

export interface MailDataSource {
  getCalendarEvent(eventId: string): Promise<CalendarEvent>;
  collectEmailsWithParticipant(participantEmail: string): Promise<LightEmail[]>;
  getEmailsBatch(messageIds: string[]): Promise<EmailMessage[]>;
  getMessageAttachments(messageId: string): Promise<GraphAttachment[]>;
}
