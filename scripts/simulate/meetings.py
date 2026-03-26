"""Meeting simulator — multi-agent turn-based discussion + report generation."""

from __future__ import annotations

import logging
import random
from datetime import datetime, timedelta

from .llm_client import LLMClient
from .models import (
    EmailRecipient,
    Participant,
    Problem,
    SimCalendarEvent,
    SimEmail,
    new_id,
)
from .prompts import (
    MEETING_REPORT_SYSTEM,
    MEETING_REPORT_USER,
    MEETING_TURN_SYSTEM,
    MEETING_TURN_USER,
)

log = logging.getLogger(__name__)


class MeetingSimulator:
    """Simulates a multi-participant meeting via turn-based LLM calls."""

    def __init__(self, llm: LLMClient):
        self.llm = llm

    def run_meeting(
        self,
        meeting_config: dict,
        participants: dict[str, Participant],
        active_problems: list[Problem],
        recent_emails_by_participant: dict[str, list[SimEmail]],
        sim_date: datetime,
    ) -> tuple[SimCalendarEvent, SimEmail | None]:
        """
        Run a full meeting simulation.

        Returns:
            (calendar_event, report_email) — the event and optionally a report email
        """
        subject = meeting_config["subject"]
        agenda = meeting_config["agenda"]
        location = meeting_config.get("location", "BC 410")
        duration = meeting_config.get("duration_minutes", 60)
        attendee_emails = meeting_config["attendees"]

        attendees = [participants[e] for e in attendee_emails if e in participants]
        if len(attendees) < 2:
            log.warning("Meeting '%s' has fewer than 2 valid attendees, skipping", subject)
            return None, None

        log.info("  🤝 Meeting: %s (%d participants)", subject, len(attendees))

        # Simulate the discussion
        transcript = self._simulate_discussion(
            subject=subject,
            agenda=agenda,
            location=location,
            attendees=attendees,
            active_problems=active_problems,
            recent_emails_by_participant=recent_emails_by_participant,
            sim_date=sim_date,
        )

        # Generate meeting report
        report = self._generate_report(
            subject=subject,
            location=location,
            attendees=attendees,
            transcript=transcript,
            sim_date=sim_date,
        )

        # Create calendar event
        start_hour = random.choice([9, 10, 11, 14, 15, 16])
        start_time = sim_date.replace(hour=start_hour, minute=0, second=0)
        end_time = start_time + timedelta(minutes=duration)

        organizer = attendees[0]
        event = SimCalendarEvent(
            id=new_id(),
            subject=subject,
            body_content=agenda,
            start_date_time=start_time.isoformat(),
            end_date_time=end_time.isoformat(),
            location_display_name=location,
            organizer_name=organizer.name,
            organizer_address=organizer.email,
            attendees=attendees,
            meeting_report=report,
        )

        # Create report email sent by organizer
        report_email = SimEmail(
            id=new_id(),
            subject=f"CR: {subject}",
            body_content=report,
            from_name=organizer.name,
            from_address=organizer.email,
            to_recipients=[
                EmailRecipient(name=a.name, address=a.email)
                for a in attendees
                if a.email != organizer.email
            ],
            received_date_time=(end_time + timedelta(hours=1)).isoformat(),
            sent_date_time=(end_time + timedelta(minutes=55)).isoformat(),
            conversation_id=new_id(),
            project_id=meeting_config.get("project_id"),
        )

        return event, report_email

    def _simulate_discussion(
        self,
        subject: str,
        agenda: str,
        location: str,
        attendees: list[Participant],
        active_problems: list[Problem],
        recent_emails_by_participant: dict[str, list[SimEmail]],
        sim_date: datetime,
    ) -> str:
        """Simulate turn-by-turn discussion. Returns full transcript."""
        num_turns = random.randint(10, 18)
        transcript_lines = []
        transcript_so_far = ""

        for turn_idx in range(num_turns):
            # Random speaker selection (weighted: organizer speaks more)
            weights = [1.5 if i == 0 else 1.0 for i in range(len(attendees))]
            speaker = random.choices(attendees, weights=weights, k=1)[0]

            # Build recent context for this speaker
            recent_emails = recent_emails_by_participant.get(speaker.email, [])
            recent_context = self._format_recent_context(recent_emails[-5:])

            # Build problems context
            relevant_problems = [
                p for p in active_problems
                if speaker.email in p.affects_participants
            ]
            problems_ctx = ""
            if relevant_problems:
                problems_ctx = "Problèmes en cours :\n" + "\n".join(
                    f"- {p.description}" for p in relevant_problems
                )

            system = MEETING_TURN_SYSTEM.format(
                name=speaker.name,
                role=speaker.role,
                personality=speaker.personality,
                project_title=subject,
                date=sim_date.strftime("%d %B %Y"),
                location=location,
                recent_context=recent_context,
                problems_context=problems_ctx,
            )

            # Summarize transcript if getting long (every 10 turns)
            if turn_idx > 0 and turn_idx % 10 == 0:
                transcript_so_far = self._summarize_transcript(transcript_so_far)

            user = MEETING_TURN_USER.format(
                agenda=agenda,
                transcript=transcript_so_far or "(Début de la réunion)",
                name=speaker.name,
            )

            try:
                speech = self.llm.chat(system, user, temperature=0.8, max_tokens=256)
                speech = speech.strip()
            except Exception as e:
                log.warning("Meeting turn failed for %s: %s", speaker.name, e)
                speech = "Je suis d'accord avec ce qui a été dit."

            line = f"**{speaker.name}** : {speech}"
            transcript_lines.append(line)
            transcript_so_far += f"\n{line}\n"

        return "\n\n".join(transcript_lines)

    def _format_recent_context(self, emails: list[SimEmail]) -> str:
        if not emails:
            return "(Pas de contexte email récent)"
        lines = []
        for msg in emails:
            body_short = msg.body_content.split("\n________________________________")[0].strip()
            if len(body_short) > 100:
                body_short = body_short[:100] + "…"
            lines.append(f"- [{msg.from_name}] {msg.subject}: {body_short}")
        return "\n".join(lines)

    def _summarize_transcript(self, transcript: str) -> str:
        """Summarize a long transcript to keep context manageable."""
        try:
            summary = self.llm.chat(
                "Tu es un assistant qui résume des transcriptions de réunion de façon concise.",
                f"Résume cette transcription en gardant les points clés, décisions, "
                f"et questions ouvertes (max 10 lignes) :\n\n{transcript}",
                temperature=0.3,
                max_tokens=512,
            )
            return f"[Résumé de la discussion précédente]\n{summary}\n\n[Suite de la discussion]"
        except Exception:
            # If summarization fails, just truncate
            return transcript[-2000:]

    def _generate_report(
        self,
        subject: str,
        location: str,
        attendees: list[Participant],
        transcript: str,
        sim_date: datetime,
    ) -> str:
        """Generate a structured meeting report from the transcript."""
        attendees_str = ", ".join(f"{a.name} ({a.role})" for a in attendees)

        try:
            report = self.llm.chat(
                MEETING_REPORT_SYSTEM,
                MEETING_REPORT_USER.format(
                    subject=subject,
                    date=sim_date.strftime("%d %B %Y"),
                    location=location,
                    attendees=attendees_str,
                    transcript=transcript,
                ),
                temperature=0.3,
                max_tokens=1024,
            )
            return report.strip()
        except Exception as e:
            log.warning("Meeting report generation failed: %s", e)
            return f"# Compte-rendu : {subject}\n\nDate : {sim_date.strftime('%d/%m/%Y')}\n\n(Rapport non disponible)"
