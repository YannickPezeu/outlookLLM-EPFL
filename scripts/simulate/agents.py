"""Participant agents — each one is an LLM persona that writes emails."""

from __future__ import annotations

import logging
import random
from datetime import datetime

from .llm_client import LLMClient
from .models import (
    AgentAction,
    Participant,
    Problem,
    SimEmail,
    ThreadInfo,
)
from .prompts import (
    COMPOSE_EMAIL_SYSTEM,
    COMPOSE_EMAIL_USER,
    DECIDE_ACTION_SYSTEM,
    DECIDE_ACTION_USER,
)

log = logging.getLogger(__name__)


class ParticipantAgent:
    """An LLM-powered agent that acts as one participant."""

    def __init__(
        self,
        participant: Participant,
        project_title: str,
        project_description: str,
        all_participants: dict[str, Participant],
        llm: LLMClient,
    ):
        self.participant = participant
        self.project_title = project_title
        self.project_description = project_description
        self.all_participants = all_participants
        self.llm = llm
        # Sliding window of recent emails this agent has seen
        self.recent_emails: list[SimEmail] = []
        self.max_recent = 20

    def add_email_to_context(self, email: SimEmail):
        """Track an email this agent sent or received."""
        self.recent_emails.append(email)
        if len(self.recent_emails) > self.max_recent:
            self.recent_emails = self.recent_emails[-self.max_recent:]

    def _format_recent_emails(self) -> str:
        if not self.recent_emails:
            return "(Aucun échange récent)"
        lines = []
        for msg in reversed(self.recent_emails[-10:]):
            to_str = ", ".join(r.address for r in msg.to_recipients)
            # Only show fresh body, not quoted parts
            body_short = msg.body_content.split("\n________________________________")[0].strip()
            if len(body_short) > 150:
                body_short = body_short[:150] + "…"
            lines.append(
                f"[{msg.received_date_time[:10]}] "
                f"De: {msg.from_address} → À: {to_str}\n"
                f"  Sujet: {msg.subject} (conversation_id: {msg.conversation_id})\n"
                f"  {body_short}"
            )
        return "\n\n".join(lines)

    def _format_other_participants(self) -> str:
        others = [
            p for email, p in self.all_participants.items()
            if email != self.participant.email
        ]
        return "\n".join(f"- {p.name} <{p.email}> ({p.role})" for p in others)

    def _format_problems(self, problems: list[Problem]) -> str:
        relevant = [
            p for p in problems
            if self.participant.email in p.affects_participants
        ]
        if not relevant:
            return ""
        lines = ["Problèmes en cours qui te concernent :"]
        for p in relevant:
            lines.append(f"- {p.description}")
        return "\n".join(lines)

    # ------------------------------------------------------------------
    def decide_action(
        self,
        current_date: datetime,
        active_problems: list[Problem],
        threads: dict[str, ThreadInfo],
    ) -> AgentAction | None:
        """Ask the LLM to decide what email to write next."""
        system = DECIDE_ACTION_SYSTEM.format(
            name=self.participant.name,
            role=self.participant.role,
            personality=self.participant.personality,
            project_title=self.project_title,
            project_description=self.project_description,
            other_participants=self._format_other_participants(),
            current_date=current_date.strftime("%A %d %B %Y"),
        )
        user = DECIDE_ACTION_USER.format(
            recent_emails=self._format_recent_emails(),
            problems_context=self._format_problems(active_problems),
        )

        try:
            result = self.llm.chat_json(system, user, temperature=0.7, max_tokens=512)
        except Exception as e:
            log.warning("Agent %s decide_action failed: %s", self.participant.email, e)
            return None

        # Validate and build AgentAction
        action_type = result.get("action", "new_thread")
        to_emails = result.get("to", [])
        if isinstance(to_emails, str):
            to_emails = [to_emails]

        # Filter to valid participants only
        valid_emails = set(self.all_participants.keys())
        to_emails = [e for e in to_emails if e in valid_emails and e != self.participant.email]
        if not to_emails:
            # Pick a random colleague
            others = [e for e in valid_emails if e != self.participant.email]
            to_emails = [random.choice(others)] if others else []

        cc_emails = result.get("cc", [])
        if isinstance(cc_emails, str):
            cc_emails = [cc_emails]
        cc_emails = [e for e in cc_emails if e in valid_emails and e != self.participant.email and e not in to_emails]

        subject = result.get("subject", "")
        conv_id = result.get("reply_to_conversation_id", "")
        context_hint = result.get("context_hint", "point sur le projet")

        # Cap thread length: threads > 5 messages get forced to new_thread
        if action_type == "reply" and conv_id in threads:
            if len(threads[conv_id].messages) >= 5:
                action_type = "new_thread"
                conv_id = ""
                if subject.startswith("Re: "):
                    subject = subject[4:]

        # Structural bias: force new_thread ~40% of the time even if LLM chose reply,
        # to avoid the "one mega-thread" problem
        if action_type == "reply" and random.random() < 0.4:
            action_type = "new_thread"
            conv_id = ""
            # Strip "Re: " if present since it's now a new thread
            if subject.startswith("Re: "):
                subject = subject[4:]

        # Sanitize subject: strip project title if the LLM snuck it in
        for noise_word in [self.project_title, "Point de situation", "Update projet"]:
            if noise_word and noise_word.lower() in subject.lower() and len(subject) > 50:
                subject = subject  # keep it but log
                break

        # Validate reply conversation_id
        if action_type == "reply" and conv_id not in threads:
            # Don't fallback to random thread — just make it a new thread
            action_type = "new_thread"
            conv_id = ""
            if subject.startswith("Re: "):
                subject = subject[4:]

        # Ensure we have a subject
        if not subject:
            subject = context_hint[:60] if context_hint else "Question rapide"

        return AgentAction(
            action_type=action_type,
            to_emails=to_emails,
            cc_emails=cc_emails,
            subject=subject,
            reply_to_conversation_id=conv_id,
            context_hint=context_hint,
        )

    # ------------------------------------------------------------------
    def compose_email(
        self,
        action: AgentAction,
        current_date: datetime,
        thread: ThreadInfo | None,
    ) -> str:
        """Ask the LLM to write the email body."""
        # Build thread context
        thread_context = ""
        if thread and thread.messages:
            msgs = thread.messages[-5:]  # last 5 messages
            parts = []
            for m in msgs:
                body_short = m.body_content.split("\n________________________________")[0].strip()
                parts.append(f"[{m.from_name}] {body_short}")
            thread_context = "Historique du thread :\n" + "\n---\n".join(parts)
        else:
            thread_context = "(Nouveau sujet, pas d'historique)"

        recipients = ", ".join(
            f"{self.all_participants[e].name} ({self.all_participants[e].role})"
            for e in action.to_emails
            if e in self.all_participants
        )

        first_name = self.participant.name.split()[0]

        system = COMPOSE_EMAIL_SYSTEM.format(
            name=self.participant.name,
            role=self.participant.role,
            personality=self.participant.personality,
            project_title=self.project_title,
            current_date=current_date.strftime("%A %d %B %Y"),
            first_name=first_name,
        )
        user = COMPOSE_EMAIL_USER.format(
            thread_context=thread_context,
            context_hint=action.context_hint,
            recipients=recipients,
            subject=action.subject,
        )

        try:
            return self.llm.chat(system, user, temperature=0.8, max_tokens=512)
        except Exception as e:
            log.warning("Agent %s compose_email failed: %s", self.participant.email, e)
            return f"Bonjour,\n\nJe reviens vers vous concernant {action.context_hint}.\n\nCordialement,\n{first_name}"
