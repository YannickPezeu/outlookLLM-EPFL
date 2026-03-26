"""SQLite database operations for the simulation."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from .models import (
    Participant,
    Problem,
    Project,
    SimCalendarEvent,
    SimEmail,
)

SCHEMA = """\
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
    email TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    personality TEXT NOT NULL,
    activity_level TEXT DEFAULT 'medium'
);

CREATE TABLE IF NOT EXISTS project_participants (
    project_id TEXT REFERENCES projects(id),
    participant_email TEXT REFERENCES participants(email),
    PRIMARY KEY (project_id, participant_email)
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    body_content TEXT NOT NULL,
    body_content_type TEXT DEFAULT 'Text',
    body_preview TEXT NOT NULL,
    from_name TEXT NOT NULL,
    from_address TEXT NOT NULL,
    to_recipients_json TEXT NOT NULL,
    cc_recipients_json TEXT DEFAULT '[]',
    received_date_time TEXT NOT NULL,
    sent_date_time TEXT,
    conversation_id TEXT NOT NULL,
    parent_folder_id TEXT DEFAULT 'inbox',
    is_read INTEGER DEFAULT 1,
    project_id TEXT REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS calendar_events (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    body_content TEXT,
    body_content_type TEXT DEFAULT 'Text',
    body_preview TEXT,
    start_date_time TEXT NOT NULL,
    start_time_zone TEXT DEFAULT 'Europe/Zurich',
    end_date_time TEXT NOT NULL,
    end_time_zone TEXT DEFAULT 'Europe/Zurich',
    location_display_name TEXT,
    organizer_name TEXT,
    organizer_address TEXT,
    attendees_json TEXT NOT NULL,
    meeting_report TEXT
);

CREATE TABLE IF NOT EXISTS problems (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    description TEXT NOT NULL,
    injected_on_day INTEGER NOT NULL,
    affects_participants_json TEXT,
    resolved INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_msg_from ON messages(from_address);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_msg_date ON messages(received_date_time);
CREATE INDEX IF NOT EXISTS idx_evt_start ON calendar_events(start_date_time);
"""


class SimDatabase:
    """SQLite persistence for the simulation."""

    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.db_path))
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self._init_schema()

    def _init_schema(self):
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self):
        self.conn.close()

    # ── Projects ──────────────────────────────────────────────────────

    def insert_project(self, project: Project):
        self.conn.execute(
            "INSERT OR REPLACE INTO projects (id, title, description) VALUES (?, ?, ?)",
            (project.id, project.title, project.description),
        )
        for email in project.participants:
            self.conn.execute(
                "INSERT OR IGNORE INTO project_participants (project_id, participant_email) VALUES (?, ?)",
                (project.id, email),
            )
        self.conn.commit()

    # ── Participants ──────────────────────────────────────────────────

    def insert_participant(self, p: Participant):
        self.conn.execute(
            "INSERT OR REPLACE INTO participants (email, name, role, personality, activity_level) "
            "VALUES (?, ?, ?, ?, ?)",
            (p.email, p.name, p.role, p.personality, p.activity_level),
        )
        self.conn.commit()

    # ── Messages ──────────────────────────────────────────────────────

    def insert_message(self, msg: SimEmail):
        self.conn.execute(
            """INSERT INTO messages
            (id, subject, body_content, body_content_type, body_preview,
             from_name, from_address, to_recipients_json, cc_recipients_json,
             received_date_time, sent_date_time, conversation_id,
             parent_folder_id, is_read, project_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                msg.id,
                msg.subject,
                msg.body_content,
                msg.body_content_type,
                msg.body_preview,
                msg.from_name,
                msg.from_address,
                msg.to_recipients_json(),
                msg.cc_recipients_json(),
                msg.received_date_time,
                msg.sent_date_time,
                msg.conversation_id,
                "inbox",
                1 if msg.is_read else 0,
                msg.project_id,
            ),
        )
        self.conn.commit()

    def get_thread_messages(self, conversation_id: str) -> list[dict]:
        """Get all messages in a thread, ordered by date."""
        cursor = self.conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY received_date_time ASC",
            (conversation_id,),
        )
        return [dict(row) for row in cursor.fetchall()]

    def get_participant_recent_emails(
        self, email: str, limit: int = 20
    ) -> list[dict]:
        """Get the most recent emails involving a participant."""
        cursor = self.conn.execute(
            """SELECT * FROM messages
            WHERE from_address = ?
               OR to_recipients_json LIKE ?
               OR cc_recipients_json LIKE ?
            ORDER BY received_date_time DESC
            LIMIT ?""",
            (email, f"%{email}%", f"%{email}%", limit),
        )
        return [dict(row) for row in cursor.fetchall()]

    def count_messages(self) -> int:
        cursor = self.conn.execute("SELECT COUNT(*) FROM messages")
        return cursor.fetchone()[0]

    # ── Calendar Events ───────────────────────────────────────────────

    def insert_calendar_event(self, event: SimCalendarEvent):
        self.conn.execute(
            """INSERT INTO calendar_events
            (id, subject, body_content, body_content_type, body_preview,
             start_date_time, start_time_zone, end_date_time, end_time_zone,
             location_display_name, organizer_name, organizer_address,
             attendees_json, meeting_report)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                event.id,
                event.subject,
                event.body_content,
                event.body_content_type,
                event.body_preview,
                event.start_date_time,
                event.start_time_zone,
                event.end_date_time,
                event.end_time_zone,
                event.location_display_name,
                event.organizer_name,
                event.organizer_address,
                event.attendees_json(),
                event.meeting_report,
            ),
        )
        self.conn.commit()

    def count_events(self) -> int:
        cursor = self.conn.execute("SELECT COUNT(*) FROM calendar_events")
        return cursor.fetchone()[0]

    # ── Problems ──────────────────────────────────────────────────────

    def insert_problem(self, problem: Problem):
        self.conn.execute(
            """INSERT INTO problems
            (id, project_id, description, injected_on_day,
             affects_participants_json, resolved)
            VALUES (?, ?, ?, ?, ?, ?)""",
            (
                problem.id,
                problem.project_id,
                problem.description,
                problem.injected_on_day,
                problem.affects_json(),
                1 if problem.resolved else 0,
            ),
        )
        self.conn.commit()

    def get_active_problems(self, project_id: str) -> list[Problem]:
        cursor = self.conn.execute(
            "SELECT * FROM problems WHERE project_id = ? AND resolved = 0",
            (project_id,),
        )
        import json
        results = []
        for row in cursor.fetchall():
            results.append(Problem(
                id=row["id"],
                project_id=row["project_id"],
                description=row["description"],
                injected_on_day=row["injected_on_day"],
                affects_participants=json.loads(row["affects_participants_json"] or "[]"),
                resolved=bool(row["resolved"]),
            ))
        return results

    def count_problems(self) -> int:
        cursor = self.conn.execute("SELECT COUNT(*) FROM problems")
        return cursor.fetchone()[0]

    # ── Stats ─────────────────────────────────────────────────────────

    def stats(self) -> dict:
        return {
            "messages": self.count_messages(),
            "calendar_events": self.count_events(),
            "problems": self.count_problems(),
            "participants": self.conn.execute("SELECT COUNT(*) FROM participants").fetchone()[0],
            "projects": self.conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0],
            "threads": self.conn.execute("SELECT COUNT(DISTINCT conversation_id) FROM messages").fetchone()[0],
        }
