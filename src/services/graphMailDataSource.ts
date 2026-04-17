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

  getEmailsBatch(messageIds: string[]): Promise<EmailMessage[]> {
    return getEmailsBatch(messageIds);
  }

  getMessageAttachments(messageId: string): Promise<GraphAttachment[]> {
    return getMessageAttachments(messageId);
  }
}
