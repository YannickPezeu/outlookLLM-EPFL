"""
Inject meetings into an existing DB, using prior meeting report + delta emails as context.

For each meeting:
1. Find the previous meeting report for the same project (if any)
2. Query all project emails SINCE that previous meeting
3. Pass both as context to the meeting simulator

Usage:
    python -m scripts.simulate.inject_meetings --db data/mock-mailbox-large.sqlite
"""

from __future__ import annotations

import argparse
import importlib
import json
import logging
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

project_root = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(project_root))

log = logging.getLogger(__name__)


def main():
    parser = argparse.ArgumentParser(description="Inject meetings with email context")
    parser.add_argument("--db", default="data/mock-mailbox-large.sqlite")
    parser.add_argument("--scenario", default="large", choices=["default", "large"])
    parser.add_argument("--backend", "-b", default="gemini", choices=["gemini", "anthropic"])
    parser.add_argument("--model", "-m", default=None)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    # Load .env
    env_path = project_root / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                os.environ.setdefault(key.strip(), value.strip())

    from scripts.simulate.database import SimDatabase
    from scripts.simulate.llm_client import LLMClient
    from scripts.simulate.meetings import MeetingSimulator
    from scripts.simulate.models import Problem, SimEmail

    if args.scenario == "large":
        import scripts.simulate.scenarios.large_epfl as scenario
    else:
        import scripts.simulate.scenarios.default_epfl as scenario
    importlib.reload(scenario)

    db = SimDatabase(args.db)
    llm = LLMClient(model=args.model, backend=args.backend)
    sim = MeetingSimulator(llm)

    participants = {p.email: p for p in scenario.PARTICIPANTS}
    start_date = datetime(2026, 3, 2)

    # Sort meetings by day
    sorted_meetings = sorted(scenario.MEETING_SCHEDULE, key=lambda m: m["day"])

    # Track last meeting date per project (for delta calculation)
    last_meeting_report: dict[str, tuple[str, str]] = {}
    # project_id -> (date_iso, report_text)

    def get_problems_for_project(project_id: str) -> list[Problem]:
        cursor = db.conn.execute(
            "SELECT * FROM problems WHERE project_id = ? AND resolved = 0",
            (project_id,),
        )
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

    def get_delta_emails(project_id: str, since_date: str, before_date: str) -> list[SimEmail]:
        """Get ALL project emails between two dates."""
        cursor = db.conn.execute(
            """SELECT * FROM messages
            WHERE project_id = ?
              AND received_date_time >= ?
              AND received_date_time < ?
            ORDER BY received_date_time ASC""",
            (project_id, since_date, before_date),
        )
        results = []
        for row in cursor.fetchall():
            results.append(SimEmail(
                id=row["id"],
                subject=row["subject"],
                body_content=row["body_content"],
                from_name=row["from_name"],
                from_address=row["from_address"],
                received_date_time=row["received_date_time"],
                conversation_id=row["conversation_id"],
            ))
        return results

    def format_email_digest(emails: list[SimEmail]) -> str:
        """Format emails into a compact digest for the meeting context."""
        if not emails:
            return "(Aucun email depuis la dernière réunion)"
        lines = []
        for e in emails:
            # Only fresh body, not quoted parts
            body = e.body_content.split("\n________________________________")[0].strip()
            if len(body) > 300:
                body = body[:300] + "..."
            lines.append(f"[{e.received_date_time[:10]}] {e.from_name} | {e.subject}\n{body}")
        return "\n\n---\n\n".join(lines)

    meetings_created = 0
    for m in sorted_meetings:
        sim_date = start_date + timedelta(days=m["day"] - 1)
        project_id = m.get("project_id", "")
        before_date = sim_date.isoformat()

        # Get previous meeting report for this project
        prev_report = last_meeting_report.get(project_id)
        if prev_report:
            since_date = prev_report[0]
            prev_report_text = prev_report[1]
        else:
            # No previous meeting: get ALL emails from project start
            since_date = "2026-01-01T00:00:00"
            prev_report_text = None

        # Get delta emails
        delta_emails = get_delta_emails(project_id, since_date, before_date)

        # Build context for meeting participants
        email_digest = format_email_digest(delta_emails)

        # Build combined context per participant
        recent_by_participant: dict[str, list[SimEmail]] = {}
        for email_addr in m["attendees"]:
            if email_addr in participants:
                # Give each participant the delta emails they were involved in
                participant_emails = [
                    e for e in delta_emails
                    if e.from_address == email_addr
                    or email_addr in e.body_content  # rough but catches to/cc
                ]
                # If few personal emails, give them the full delta (they'd have context from team)
                if len(participant_emails) < 3:
                    participant_emails = delta_emails[-15:]
                recent_by_participant[email_addr] = participant_emails

        # Enrich the meeting config with previous report context
        enriched_config = dict(m)
        if prev_report_text:
            enriched_config["agenda"] = (
                f"RAPPORT DE LA DERNIÈRE RÉUNION :\n{prev_report_text[:2000]}\n\n"
                f"---\n\n"
                f"EMAILS ÉCHANGÉS DEPUIS ({len(delta_emails)} emails) :\n{email_digest[:3000]}\n\n"
                f"---\n\n"
                f"ORDRE DU JOUR :\n{m['agenda']}"
            )
        else:
            enriched_config["agenda"] = (
                f"EMAILS ÉCHANGÉS ({len(delta_emails)} emails) :\n{email_digest[:4000]}\n\n"
                f"---\n\n"
                f"ORDRE DU JOUR :\n{m['agenda']}"
            )

        # Get problems
        active_problems = get_problems_for_project(project_id)

        print(f"Day {m['day']:2d} | {m['subject'][:50]:<50} | "
              f"{len(delta_emails):3d} delta emails | "
              f"prev report: {'yes' if prev_report_text else 'no':3s} | ", end="", flush=True)

        event, report_email = sim.run_meeting(
            meeting_config=enriched_config,
            participants=participants,
            active_problems=active_problems,
            recent_emails_by_participant=recent_by_participant,
            sim_date=sim_date,
        )

        if event:
            db.insert_calendar_event(event)
            meetings_created += 1
            # Store report for next meeting of this project
            last_meeting_report[project_id] = (
                sim_date.isoformat(),
                event.meeting_report,
            )
            print("OK")
        else:
            print("SKIPPED")

        if report_email:
            db.insert_message(report_email)

    db.close()
    print(f"\nCreated {meetings_created}/{len(scenario.MEETING_SCHEDULE)} meetings")
    print(llm.usage_summary())


if __name__ == "__main__":
    main()
