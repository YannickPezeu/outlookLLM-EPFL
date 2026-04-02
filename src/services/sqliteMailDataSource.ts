/**
 * MailDataSource implementation backed by a SQLite mock database.
 * Used for evaluation / dev only — NOT bundled in the Outlook add-in.
 *
 * Requires Node.js (better-sqlite3). Will NOT work in the browser.
 */

import type { MailDataSource, CalendarEvent, EmailMessage, GraphAttachment, LightEmail } from "./mailTypes";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require("better-sqlite3");

interface SqlRow {
  [key: string]: unknown;
}

export class SqliteMailDataSource implements MailDataSource {
  private db: InstanceType<typeof Database>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: true });
  }

  close(): void {
    this.db.close();
  }

  // ── getCalendarEvent ──────────────────────────────────────────────
  async getCalendarEvent(eventId: string): Promise<CalendarEvent> {
    const row = this.db
      .prepare("SELECT * FROM calendar_events WHERE id = ?")
      .get(eventId) as SqlRow | undefined;

    if (!row) {
      throw new Error(`Calendar event not found: ${eventId}`);
    }

    // Attendees in DB are already in Graph format: { emailAddress: { name, address }, type, status }
    const attendees = JSON.parse(row.attendees_json as string) as Array<{
      emailAddress?: { name: string; address: string };
      email?: string;
      name?: string;
      type?: string;
      status?: { response: string };
    }>;

    return {
      id: row.id as string,
      subject: row.subject as string,
      body: row.body_content
        ? { contentType: row.body_content_type as string, content: row.body_content as string }
        : undefined,
      bodyPreview: (row.body_preview as string) || "",
      start: {
        dateTime: row.start_date_time as string,
        timeZone: (row.start_time_zone as string) || "Europe/Zurich",
      },
      end: {
        dateTime: row.end_date_time as string,
        timeZone: (row.end_time_zone as string) || "Europe/Zurich",
      },
      location: row.location_display_name
        ? { displayName: row.location_display_name as string }
        : undefined,
      attendees: attendees.map((a) => ({
        emailAddress: a.emailAddress
          ? { name: a.emailAddress.name, address: a.emailAddress.address }
          : { name: a.name || "", address: a.email || "" },
        type: a.type || "required",
        status: a.status || { response: "accepted" },
      })),
      isOrganizer: false,
      organizer: row.organizer_address
        ? {
            emailAddress: {
              name: (row.organizer_name as string) || "",
              address: row.organizer_address as string,
            },
          }
        : undefined,
    };
  }

  // ── collectEmailsWithParticipant ──────────────────────────────────
  async collectEmailsWithParticipant(participantEmail: string): Promise<LightEmail[]> {
    const rows = this.db
      .prepare(
        `SELECT id, subject, body_preview, from_name, from_address,
                to_recipients_json, received_date_time, conversation_id
         FROM messages
         WHERE from_address = ?
            OR to_recipients_json LIKE ?
            OR cc_recipients_json LIKE ?
         ORDER BY received_date_time DESC`
      )
      .all(participantEmail, `%${participantEmail}%`, `%${participantEmail}%`) as SqlRow[];

    // Deduplicate by conversation_id (keep most recent per conversation)
    const seen = new Set<string>();
    const deduplicated: LightEmail[] = [];

    for (const row of rows) {
      const convId = row.conversation_id as string;
      if (seen.has(convId)) continue;
      seen.add(convId);

      const toRecipients = JSON.parse(row.to_recipients_json as string);

      deduplicated.push({
        id: row.id as string,
        subject: row.subject as string,
        bodyPreview: (row.body_preview as string) || "",
        from: {
          emailAddress: {
            name: row.from_name as string,
            address: row.from_address as string,
          },
        },
        toRecipients,
        receivedDateTime: row.received_date_time as string,
        conversationId: convId,
      });
    }

    return deduplicated;
  }

  // ── getEmailsBatch ────────────────────────────────────────────────
  async getEmailsBatch(messageIds: string[]): Promise<EmailMessage[]> {
    if (messageIds.length === 0) return [];

    const placeholders = messageIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT id, subject, body_content, body_content_type, body_preview,
                from_name, from_address, to_recipients_json,
                received_date_time, sent_date_time, parent_folder_id, is_read
         FROM messages
         WHERE id IN (${placeholders})`
      )
      .all(...messageIds) as SqlRow[];

    // Return in same order as messageIds
    const byId = new Map(rows.map((r) => [r.id as string, r]));

    return messageIds
      .map((id) => {
        const row = byId.get(id);
        if (!row) return null;

        const toRecipients = JSON.parse(row.to_recipients_json as string);

        return {
          id: row.id as string,
          subject: row.subject as string,
          bodyPreview: (row.body_preview as string) || "",
          body: {
            contentType: (row.body_content_type as string) || "Text",
            content: row.body_content as string,
          },
          from: {
            emailAddress: {
              name: row.from_name as string,
              address: row.from_address as string,
            },
          },
          toRecipients,
          receivedDateTime: row.received_date_time as string,
          sentDateTime: row.sent_date_time as string | undefined,
          parentFolderId: (row.parent_folder_id as string) || "inbox",
          isRead: Boolean(row.is_read),
          hasAttachments: false,
        } as EmailMessage;
      })
      .filter(Boolean) as EmailMessage[];
  }

  // ── getMessageAttachments ─────────────────────────────────────────
  async getMessageAttachments(_messageId: string): Promise<GraphAttachment[]> {
    // Mock DB has no attachments
    return [];
  }

  // ── Helpers for eval ──────────────────────────────────────────────

  /** List all calendar events (for eval script to iterate). */
  listCalendarEvents(): CalendarEvent[] {
    const rows = this.db
      .prepare("SELECT id FROM calendar_events ORDER BY start_date_time")
      .all() as SqlRow[];
    // Return just IDs — caller will use getCalendarEvent() for full data
    return rows.map((r) => ({ id: r.id as string })) as unknown as CalendarEvent[];
  }

  /** Get the ground-truth project_id for a given email. */
  getEmailProjectId(emailId: string): string | null {
    const row = this.db
      .prepare("SELECT project_id FROM messages WHERE id = ?")
      .get(emailId) as SqlRow | undefined;
    return row ? (row.project_id as string | null) : null;
  }

  /** Get the project_id associated with a calendar event (via attendees → project_participants). */
  getEventProjectId(eventId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT ce.id, pp.project_id, COUNT(*) as match_count
         FROM calendar_events ce, json_each(ce.attendees_json) je,
              project_participants pp
         WHERE json_extract(je.value, '$.emailAddress.address') = pp.participant_email
           AND ce.id = ?
         GROUP BY pp.project_id
         ORDER BY match_count DESC
         LIMIT 1`
      )
      .get(eventId) as SqlRow | undefined;
    return row ? (row.project_id as string | null) : null;
  }
}
