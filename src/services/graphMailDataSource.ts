/**
 * MailDataSource implementation backed by Microsoft Graph API.
 * Simply delegates to the existing graphMailService functions.
 */

import type { MailDataSource } from "./mailDataSource";
import {
  CalendarEvent,
  EmailMessage,
  GraphAttachment,
  LightEmail,
  getCalendarEvent,
  collectEmailsWithParticipant,
  searchEmailsByKeyword,
  getServiceDeskEmailsForPerson,
  getEmailsBatch,
  getMessageAttachments,
} from "./graphMailService";

export class GraphMailDataSource implements MailDataSource {
  getCalendarEvent(eventId: string): Promise<CalendarEvent> {
    return getCalendarEvent(eventId);
  }

  collectEmailsWithParticipant(participantEmail: string): Promise<LightEmail[]> {
    return collectEmailsWithParticipant(participantEmail);
  }

  searchEmailsByKeyword(keyword: string, maxResults?: number): Promise<LightEmail[]> {
    return searchEmailsByKeyword(keyword, maxResults);
  }

  async searchServiceDeskEmailsForPerson(personName: string, maxResults = 50): Promise<LightEmail[]> {
    const emails = await getServiceDeskEmailsForPerson(personName, maxResults);
    // Convert EmailMessage → LightEmail
    return emails.map((e) => ({
      id: e.id,
      subject: e.subject,
      bodyPreview: e.bodyPreview,
      from: e.from,
      toRecipients: e.toRecipients,
      receivedDateTime: e.receivedDateTime,
      conversationId: (e as any).conversationId || "",
    }));
  }

  getEmailsBatch(messageIds: string[]): Promise<EmailMessage[]> {
    return getEmailsBatch(messageIds);
  }

  getMessageAttachments(messageId: string): Promise<GraphAttachment[]> {
    return getMessageAttachments(messageId);
  }
}
