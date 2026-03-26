"""Dataclasses shared across the simulation."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional


def new_id() -> str:
    return str(uuid.uuid4())


@dataclass
class Participant:
    email: str
    name: str
    role: str
    personality: str
    activity_level: str = "medium"  # low | medium | high


@dataclass
class Project:
    id: str
    title: str
    description: str
    participants: list[str] = field(default_factory=list)  # emails


@dataclass
class EmailRecipient:
    name: str
    address: str

    def to_graph_json(self) -> dict:
        return {"emailAddress": {"name": self.name, "address": self.address}}


@dataclass
class SimEmail:
    id: str = field(default_factory=new_id)
    subject: str = ""
    body_content: str = ""
    body_content_type: str = "Text"
    from_name: str = ""
    from_address: str = ""
    to_recipients: list[EmailRecipient] = field(default_factory=list)
    cc_recipients: list[EmailRecipient] = field(default_factory=list)
    received_date_time: str = ""  # ISO 8601
    sent_date_time: str = ""
    conversation_id: str = ""
    is_read: bool = True
    project_id: Optional[str] = None

    @property
    def body_preview(self) -> str:
        text = self.body_content.replace("\n", " ").strip()
        return text[:255]

    def to_recipients_json(self) -> str:
        return json.dumps([r.to_graph_json() for r in self.to_recipients])

    def cc_recipients_json(self) -> str:
        return json.dumps([r.to_graph_json() for r in self.cc_recipients])


@dataclass
class SimCalendarEvent:
    id: str = field(default_factory=new_id)
    subject: str = ""
    body_content: str = ""
    body_content_type: str = "Text"
    start_date_time: str = ""
    start_time_zone: str = "Europe/Zurich"
    end_date_time: str = ""
    end_time_zone: str = "Europe/Zurich"
    location_display_name: str = ""
    organizer_name: str = ""
    organizer_address: str = ""
    attendees: list[Participant] = field(default_factory=list)
    meeting_report: str = ""

    @property
    def body_preview(self) -> str:
        text = self.body_content.replace("\n", " ").strip()
        return text[:255]

    def attendees_json(self) -> str:
        return json.dumps([
            {
                "emailAddress": {"name": a.name, "address": a.email},
                "type": "required",
                "status": {"response": "accepted"},
            }
            for a in self.attendees
        ])


@dataclass
class Problem:
    id: str = field(default_factory=new_id)
    project_id: str = ""
    description: str = ""
    injected_on_day: int = 0
    affects_participants: list[str] = field(default_factory=list)  # emails
    resolved: bool = False

    def affects_json(self) -> str:
        return json.dumps(self.affects_participants)


@dataclass
class AgentAction:
    """What an agent decided to do."""
    action_type: str  # "reply" | "new_thread"
    to_emails: list[str] = field(default_factory=list)
    cc_emails: list[str] = field(default_factory=list)
    subject: str = ""
    reply_to_conversation_id: str = ""
    context_hint: str = ""  # brief description of what to write about


@dataclass
class ThreadInfo:
    """Tracks a conversation thread."""
    conversation_id: str
    subject: str
    messages: list[SimEmail] = field(default_factory=list)
    project_id: Optional[str] = None
