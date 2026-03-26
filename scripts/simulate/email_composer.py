"""Builds realistic email messages with threading, quoting, and CC."""

from __future__ import annotations

import random
from datetime import datetime, timedelta

from .models import (
    AgentAction,
    EmailRecipient,
    Participant,
    SimEmail,
    ThreadInfo,
    new_id,
)


class EmailComposer:
    """Assembles SimEmail objects from agent decisions and LLM-generated bodies."""

    def __init__(self, participants: dict[str, Participant]):
        self.participants = participants  # email -> Participant

    def build_email(
        self,
        sender: Participant,
        action: AgentAction,
        body: str,
        sim_date: datetime,
        thread: ThreadInfo | None,
        project_id: str | None = None,
    ) -> SimEmail:
        """Build a complete SimEmail with proper threading and quoting."""
        # Resolve recipients
        to_recipients = [
            EmailRecipient(
                name=self.participants[e].name if e in self.participants else e.split("@")[0],
                address=e,
            )
            for e in action.to_emails
        ]
        cc_recipients = [
            EmailRecipient(
                name=self.participants[e].name if e in self.participants else e.split("@")[0],
                address=e,
            )
            for e in action.cc_emails
        ]

        # Build full body with quoted history
        full_body = body
        if thread and thread.messages:
            full_body = self._add_quoted_history(body, thread.messages)

        # Random time within the day
        hour = random.randint(7, 19)
        minute = random.randint(0, 59)
        email_time = sim_date.replace(hour=hour, minute=minute, second=random.randint(0, 59))

        conversation_id = (
            action.reply_to_conversation_id
            if action.action_type == "reply" and action.reply_to_conversation_id
            else new_id()
        )

        return SimEmail(
            id=new_id(),
            subject=action.subject,
            body_content=full_body,
            from_name=sender.name,
            from_address=sender.email,
            to_recipients=to_recipients,
            cc_recipients=cc_recipients,
            received_date_time=email_time.isoformat(),
            sent_date_time=(email_time - timedelta(seconds=30)).isoformat(),
            conversation_id=conversation_id,
            is_read=random.random() > 0.2,  # 80% read
            project_id=project_id,
        )

    def _add_quoted_history(self, fresh_body: str, previous_messages: list[SimEmail]) -> str:
        """Add Outlook-style quoted previous messages."""
        result = fresh_body + "\n"
        # Show last 3 messages max to keep it readable
        for msg in reversed(previous_messages[-3:]):
            date_str = msg.received_date_time[:16].replace("T", " ")
            result += f"\n________________________________"
            result += f"\nDe : {msg.from_name} <{msg.from_address}>"
            result += f"\nEnvoyé : {date_str}"
            to_names = ", ".join(
                r.name for r in msg.to_recipients
            )
            result += f"\nÀ : {to_names}"
            result += f"\nObjet : {msg.subject}"
            # Only include the fresh part of previous body (not their quoted part)
            body_lines = msg.body_content.split("\n________________________________")[0]
            result += f"\n\n{body_lines}"
        return result
