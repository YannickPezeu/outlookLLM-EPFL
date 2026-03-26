"""CLI entry point — python -m scripts.simulate [command]"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import datetime
from pathlib import Path

# Ensure project root is in path
project_root = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(project_root))


def cmd_generate(args):
    """Run the full simulation."""
    from scripts.simulate.database import SimDatabase
    from scripts.simulate.engine import SimulationEngine
    from scripts.simulate.llm_client import LLMClient

    # Choose scenario
    if args.scenario == "large":
        from scripts.simulate.scenarios.large_epfl import (
            MEETING_SCHEDULE, NOISE_SENDERS, NOISE_TOPICS, PARTICIPANTS, PROJECTS,
        )
    else:
        from scripts.simulate.scenarios.default_epfl import (
            MEETING_SCHEDULE, NOISE_SENDERS, NOISE_TOPICS, PARTICIPANTS, PROJECTS,
        )

    # Load .env if present
    env_path = project_root / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                os.environ.setdefault(key.strip(), value.strip())

    output_path = Path(args.output)
    if output_path.exists():
        if args.force:
            output_path.unlink()
        else:
            print(f"Database already exists at {output_path}. Use --force to overwrite.")
            sys.exit(1)

    db = SimDatabase(output_path)
    llm = LLMClient(model=args.model, backend=args.backend)

    engine = SimulationEngine(
        db=db,
        llm=llm,
        projects=PROJECTS,
        participants=PARTICIPANTS,
        meeting_schedule=MEETING_SCHEDULE,
        noise_senders=NOISE_SENDERS,
        noise_topics=NOISE_TOPICS,
        start_date=datetime(2026, 3, 2),  # Monday
        num_days=args.days,
    )

    try:
        engine.run()
    except KeyboardInterrupt:
        print("\nInterrupted. Partial data saved.")
    finally:
        print(f"\n{llm.usage_summary()}")
        db.close()
        print(f"Database saved to {output_path}")


def cmd_stats(args):
    """Show database statistics."""
    from scripts.simulate.database import SimDatabase

    db_path = Path(args.input)
    if not db_path.exists():
        print(f"Database not found: {db_path}")
        sys.exit(1)

    db = SimDatabase(db_path)
    stats = db.stats()
    db.close()

    print(f"\nDatabase stats: {db_path}")
    print(f"  Projects:        {stats['projects']}")
    print(f"  Participants:    {stats['participants']}")
    print(f"  Messages:        {stats['messages']}")
    print(f"  Threads:         {stats['threads']}")
    print(f"  Calendar events: {stats['calendar_events']}")
    print(f"  Problems:        {stats['problems']}")


def cmd_export(args):
    """Export SQLite to JSON for browser consumption."""
    import json
    from scripts.simulate.database import SimDatabase

    db_path = Path(args.input)
    if not db_path.exists():
        print(f"Database not found: {db_path}")
        sys.exit(1)

    db = SimDatabase(db_path)

    # Export all data
    cursor = db.conn.execute("SELECT * FROM messages ORDER BY received_date_time")
    messages = [dict(row) for row in cursor.fetchall()]

    cursor = db.conn.execute("SELECT * FROM calendar_events ORDER BY start_date_time")
    events = [dict(row) for row in cursor.fetchall()]

    cursor = db.conn.execute("SELECT * FROM participants")
    participants = [dict(row) for row in cursor.fetchall()]

    db.close()

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(
            {"participants": participants, "messages": messages, "events": events},
            f,
            ensure_ascii=False,
            indent=2,
        )

    print(f"Exported {len(messages)} messages, {len(events)} events, {len(participants)} participants")
    print(f"Saved to {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="EPFL Mail Simulation — Multi-agent LLM email/meeting generator"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # generate
    gen = subparsers.add_parser("generate", help="Run the simulation")
    gen.add_argument("--output", "-o", default="data/mock-mailbox.sqlite",
                     help="Output SQLite path")
    gen.add_argument("--days", "-d", type=int, default=30,
                     help="Number of days to simulate")
    gen.add_argument("--model", "-m", default=None,
                     help="LLM model (default: claude-haiku-4-5-20241022)")
    gen.add_argument("--force", "-f", action="store_true",
                     help="Overwrite existing database")
    gen.add_argument("--scenario", "-s", default="default", choices=["default", "large"],
                     help="Scenario: 'default' (3 projects) or 'large' (20 projects)")
    gen.add_argument("--backend", "-b", default="gemini", choices=["gemini", "anthropic"],
                     help="LLM backend (default: gemini)")
    gen.set_defaults(func=cmd_generate)

    # stats
    st = subparsers.add_parser("stats", help="Show database statistics")
    st.add_argument("--input", "-i", default="data/mock-mailbox.sqlite",
                    help="Input SQLite path")
    st.set_defaults(func=cmd_stats)

    # export
    exp = subparsers.add_parser("export", help="Export SQLite to JSON")
    exp.add_argument("--input", "-i", default="data/mock-mailbox.sqlite",
                     help="Input SQLite path")
    exp.add_argument("--output", "-o", default="dist/mock-data.json",
                     help="Output JSON path")
    exp.set_defaults(func=cmd_export)

    # Parse
    args = parser.parse_args()

    # Setup logging
    log_level = logging.DEBUG if os.environ.get("DEBUG") else logging.INFO
    logging.basicConfig(
        level=log_level,
        format="%(message)s",
        handlers=[logging.StreamHandler()],
    )

    args.func(args)


if __name__ == "__main__":
    main()
