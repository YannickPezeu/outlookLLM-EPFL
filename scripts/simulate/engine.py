"""Simulation engine — orchestrates the day-by-day simulation loop."""

from __future__ import annotations

import logging
import random
from datetime import datetime, timedelta

from .agents import ParticipantAgent
from .database import SimDatabase
from .email_composer import EmailComposer
from .llm_client import LLMClient
from .meetings import MeetingSimulator
from .models import (
    EmailRecipient,
    Participant,
    Problem,
    Project,
    SimEmail,
    ThreadInfo,
    new_id,
)
from .problems import ProblemGenerator
from .prompts import (
    NOISE_EMAIL_SYSTEM,
    NOISE_EMAIL_USER,
    EXTERNAL_EMAIL_SYSTEM,
    EXTERNAL_EMAIL_USER,
    FORWARD_INTRO_SYSTEM,
    FORWARD_INTRO_USER,
)

log = logging.getLogger(__name__)

# Emails per day by activity level
ACTIVITY_RANGES = {
    "low": (0, 1),
    "medium": (1, 2),
    "high": (2, 3),
}


class SimulationEngine:
    """Main simulation orchestrator."""

    def __init__(
        self,
        db: SimDatabase,
        llm: LLMClient,
        projects: list[Project],
        participants: list[Participant],
        meeting_schedule: list[dict],
        noise_senders: list[dict],
        noise_topics: list[str],
        start_date: datetime | None = None,
        num_days: int = 30,
    ):
        self.db = db
        self.llm = llm
        self.num_days = num_days
        self.start_date = start_date or datetime(2026, 3, 1)

        # Index participants by email
        self.participants: dict[str, Participant] = {p.email: p for p in participants}

        # Projects
        self.projects = {p.id: p for p in projects}

        # Meeting schedule
        self.meeting_schedule = meeting_schedule

        # Noise
        self.noise_senders = noise_senders
        self.noise_topics = noise_topics

        # Components
        self.problem_generator = ProblemGenerator(llm)
        self.meeting_simulator = MeetingSimulator(llm)
        self.email_composer = EmailComposer(self.participants)

        # Per-project state
        self.agents: dict[str, dict[str, ParticipantAgent]] = {}  # project_id -> {email -> agent}
        self.threads: dict[str, ThreadInfo] = {}  # conversation_id -> ThreadInfo
        self.problems: dict[str, list[Problem]] = {}  # project_id -> [Problem]

        # Initialize
        self._init_agents()
        self._init_db()

    def _init_agents(self):
        """Create ParticipantAgent instances for each project."""
        for proj in self.projects.values():
            self.agents[proj.id] = {}
            self.problems[proj.id] = []
            # Get participants for this project
            project_participants = {
                e: self.participants[e]
                for e in proj.participants
                if e in self.participants
            }
            for email, participant in project_participants.items():
                self.agents[proj.id][email] = ParticipantAgent(
                    participant=participant,
                    project_title=proj.title,
                    project_description=proj.description,
                    all_participants=project_participants,
                    llm=self.llm,
                )

    def _init_db(self):
        """Persist projects and participants to DB."""
        for p in self.participants.values():
            self.db.insert_participant(p)
        for proj in self.projects.values():
            self.db.insert_project(proj)

    # ------------------------------------------------------------------
    def run(self):
        """Run the full simulation."""
        log.info("=" * 60)
        log.info("Starting simulation: %d days, %d projects, %d participants",
                 self.num_days, len(self.projects), len(self.participants))
        log.info("=" * 60)

        for day in range(1, self.num_days + 1):
            sim_date = self.start_date + timedelta(days=day - 1)
            weekday = sim_date.weekday()

            # Skip weekends (reduced activity)
            is_weekend = weekday >= 5

            log.info("\n📅 Day %d/%d — %s%s",
                     day, self.num_days,
                     sim_date.strftime("%A %d %B %Y"),
                     " (weekend)" if is_weekend else "")

            # 1. Generate problems for each project
            for proj_id, proj in self.projects.items():
                prob = self.problem_generator.maybe_generate(
                    project=proj,
                    participants=self.participants,
                    day=day,
                    existing_problems=self.problems[proj_id],
                    probability=0.15 if not is_weekend else 0.05,
                )
                if prob:
                    self.problems[proj_id].append(prob)
                    self.db.insert_problem(prob)

            # 2. Simulate emails for each project
            if not is_weekend:
                for proj_id, proj in self.projects.items():
                    self._simulate_project_day(proj_id, proj, day, sim_date)

                # 3. External contacts + forwards
                self._generate_external_emails(sim_date)

                # 4. Noise emails (~20% of total)
                self._generate_noise_emails(sim_date)

            # 4. Check for meetings today
            for meeting in self.meeting_schedule:
                if meeting["day"] == day:
                    self._run_meeting(meeting, sim_date)

            # Progress report
            stats = self.db.stats()
            log.info("  📊 Total: %d emails, %d events, %d problems",
                     stats["messages"], stats["calendar_events"], stats["problems"])

        log.info("\n" + "=" * 60)
        log.info("Simulation complete!")
        log.info(self.llm.usage_summary())
        final_stats = self.db.stats()
        for k, v in final_stats.items():
            log.info("  %s: %s", k, v)

    # ------------------------------------------------------------------
    def _simulate_project_day(
        self, proj_id: str, proj: Project, day: int, sim_date: datetime
    ):
        """Simulate one day of email exchange for a project."""
        agents = self.agents[proj_id]
        participant_emails = list(agents.keys())
        random.shuffle(participant_emails)

        active_problems = self.problems.get(proj_id, [])

        for email in participant_emails:
            agent = agents[email]
            participant = self.participants[email]

            # How many emails today
            lo, hi = ACTIVITY_RANGES.get(participant.activity_level, (1, 2))
            num_emails = random.randint(lo, hi)

            for _ in range(num_emails):
                self._agent_send_email(agent, proj_id, active_problems, sim_date)

    def _agent_send_email(
        self,
        agent: ParticipantAgent,
        project_id: str,
        active_problems: list[Problem],
        sim_date: datetime,
    ):
        """Have one agent decide and send one email."""
        # Decide
        action = agent.decide_action(
            current_date=sim_date,
            active_problems=active_problems,
            threads=self.threads,
        )
        if not action:
            return

        # Get thread if reply
        thread = None
        if action.action_type == "reply" and action.reply_to_conversation_id:
            thread = self.threads.get(action.reply_to_conversation_id)

        # Compose
        body = agent.compose_email(action, sim_date, thread)

        # Build email
        email = self.email_composer.build_email(
            sender=agent.participant,
            action=action,
            body=body,
            sim_date=sim_date,
            thread=thread,
            project_id=project_id,
        )

        # Store in DB
        self.db.insert_message(email)

        # Update thread tracking
        conv_id = email.conversation_id
        if conv_id not in self.threads:
            base_subject = action.subject.replace("Re: ", "")
            self.threads[conv_id] = ThreadInfo(
                conversation_id=conv_id,
                subject=base_subject,
                project_id=project_id,
            )
        self.threads[conv_id].messages.append(email)

        # Update all involved agents' context
        involved_emails = (
            [email.from_address]
            + [r.address for r in email.to_recipients]
            + [r.address for r in email.cc_recipients]
        )
        for proj_agents in self.agents.values():
            for e, a in proj_agents.items():
                if e in involved_emails:
                    a.add_email_to_context(email)

        log.debug("    ✉️  %s → %s: %s",
                  agent.participant.name,
                  ", ".join(r.address for r in email.to_recipients),
                  action.subject[:50])

    # ------------------------------------------------------------------
    def _generate_noise_emails(self, sim_date: datetime):
        """Generate a few noise/admin emails."""
        num_noise = random.randint(1, 3)
        all_participant_emails = list(self.participants.keys())

        for _ in range(num_noise):
            sender = random.choice(self.noise_senders)
            recipient_email = random.choice(all_participant_emails)
            recipient = self.participants[recipient_email]
            topic = random.choice(self.noise_topics)

            system = NOISE_EMAIL_SYSTEM.format(
                sender_name=sender["name"],
                sender_role=sender["role"],
            )
            user = NOISE_EMAIL_USER.format(
                recipient_name=recipient.name,
                recipient_role=recipient.role,
                topic=topic,
            )

            try:
                body = self.llm.chat(system, user, temperature=0.8, max_tokens=256)
            except Exception as e:
                log.warning("Noise email generation failed: %s", e)
                continue

            hour = random.randint(8, 17)
            email_time = sim_date.replace(
                hour=hour, minute=random.randint(0, 59), second=random.randint(0, 59)
            )

            email = SimEmail(
                id=new_id(),
                subject=topic,
                body_content=body.strip(),
                from_name=sender["name"],
                from_address=sender["email"],
                to_recipients=[EmailRecipient(name=recipient.name, address=recipient.email)],
                received_date_time=email_time.isoformat(),
                sent_date_time=(email_time - timedelta(seconds=30)).isoformat(),
                conversation_id=new_id(),
                project_id=None,
            )
            self.db.insert_message(email)

    # ------------------------------------------------------------------
    # External contacts that send project-relevant emails
    EXTERNAL_CONTACTS = [
        {"name": "Patrick Aebischer", "email": "p.aebischer@swisscom.ch", "role": "Director AI Strategy, Swisscom", "topics": ["infrastructure cloud", "partenariat industrie", "GPU hosting"]},
        {"name": "Silvia Bentivoglio", "email": "s.bentivoglio@ec.europa.eu", "role": "Programme Officer, European Commission DG RTD", "topics": ["Horizon Europe", "reporting", "consortium", "deliverables"]},
        {"name": "Thomas Meier", "email": "t.meier@nvidia.com", "role": "Enterprise Account Manager, NVIDIA", "topics": ["GPU", "H100", "A100", "devis", "livraison", "DGX"]},
        {"name": "Catherine Bellamy", "email": "c.bellamy@educa.ch", "role": "Directrice, educa.ch — agence nationale pour l'éducation", "topics": ["pédagogie", "enseignement", "curriculum", "réforme"]},
        {"name": "Daniel Krämer", "email": "d.kraemer@snf.ch", "role": "Responsable division, Fonds National Suisse", "topics": ["financement", "grant", "évaluation", "budget recherche"]},
        {"name": "Lisa Chang", "email": "l.chang@aws.amazon.com", "role": "Solutions Architect, AWS", "topics": ["cloud", "GPU instances", "SageMaker", "pricing"]},
        {"name": "Roberto Fusco", "email": "r.fusco@springer.com", "role": "Editor, Springer Nature", "topics": ["publication", "journal", "review", "deadline soumission"]},
        {"name": "Markus Hofmann", "email": "m.hofmann@edoeb.admin.ch", "role": "Juriste, Préposé fédéral à la protection des données", "topics": ["RGPD", "LPD", "protection données", "compliance"]},
        {"name": "Sophie Moreau", "email": "s.moreau@cnil.fr", "role": "Chargée de mission, CNIL France", "topics": ["RGPD", "transfert données", "IA Act", "régulation"]},
        {"name": "John Davis", "email": "j.davis@openai.com", "role": "Research Partnerships, OpenAI", "topics": ["LLM", "API", "modèles", "benchmark", "collaboration"]},
    ]

    def _generate_external_emails(self, sim_date: datetime):
        """Generate emails from external contacts relevant to projects, then forward them."""
        # ~2-4 external emails per day
        num_external = random.randint(2, 4)

        for _ in range(num_external):
            ext = random.choice(self.EXTERNAL_CONTACTS)

            # Pick a project that matches this external's topics
            matching_projects = []
            for proj in self.projects.values():
                desc_lower = proj.description.lower() + " " + proj.title.lower()
                if any(t.lower() in desc_lower for t in ext["topics"]):
                    matching_projects.append(proj)

            if not matching_projects:
                matching_projects = list(self.projects.values())
            project = random.choice(matching_projects)

            # Pick a recipient from the project
            recipient_email = random.choice(project.participants)
            if recipient_email not in self.participants:
                continue
            recipient = self.participants[recipient_email]

            topic = random.choice(ext["topics"])
            subject = f"{topic.capitalize()} — {ext['name'].split()[0]}"

            # Generate external email
            try:
                body = self.llm.chat(
                    EXTERNAL_EMAIL_SYSTEM.format(
                        sender_name=ext["name"],
                        sender_role=ext["role"],
                        project_title=project.title,
                        topic=topic,
                    ),
                    EXTERNAL_EMAIL_USER.format(
                        recipient_name=recipient.name,
                        recipient_role=recipient.role,
                        subject=subject,
                    ),
                    temperature=0.8,
                    max_tokens=384,
                )
            except Exception as e:
                log.warning("External email generation failed: %s", e)
                continue

            hour = random.randint(7, 20)
            email_time = sim_date.replace(hour=hour, minute=random.randint(0, 59))

            ext_email = SimEmail(
                id=new_id(),
                subject=subject,
                body_content=body.strip(),
                from_name=ext["name"],
                from_address=ext["email"],
                to_recipients=[EmailRecipient(name=recipient.name, address=recipient.email)],
                received_date_time=email_time.isoformat(),
                sent_date_time=(email_time - timedelta(seconds=30)).isoformat(),
                conversation_id=new_id(),
                project_id=project.id,  # tagged with project for ground truth
            )
            self.db.insert_message(ext_email)

            # ~60% chance the recipient forwards it to a colleague
            if random.random() < 0.6:
                self._forward_email(ext_email, recipient, project, sim_date)

    def _forward_email(
        self, original: SimEmail, forwarder: Participant, project: Project, sim_date: datetime
    ):
        """Forward an external email to a project colleague."""
        # Pick a colleague from the same project (not the forwarder)
        colleagues = [e for e in project.participants if e != forwarder.email and e in self.participants]
        if not colleagues:
            return
        fwd_to_email = random.choice(colleagues)
        fwd_to = self.participants[fwd_to_email]

        try:
            intro = self.llm.chat(
                FORWARD_INTRO_SYSTEM.format(
                    name=forwarder.name,
                    role=forwarder.role,
                    personality=self.participants[forwarder.email].personality if forwarder.email in self.participants else "",
                ),
                FORWARD_INTRO_USER.format(
                    recipient_name=fwd_to.name,
                    original_sender=original.from_name,
                    original_subject=original.subject,
                    original_body_preview=original.body_preview[:200],
                ),
                temperature=0.7,
                max_tokens=128,
            )
        except Exception as e:
            intro = "FYI, see below."

        # Build forwarded body
        fwd_body = (
            f"{intro.strip()}\n\n"
            f"---------- Forwarded message ----------\n"
            f"De : {original.from_name} <{original.from_address}>\n"
            f"Date : {original.received_date_time[:16]}\n"
            f"Objet : {original.subject}\n\n"
            f"{original.body_content}"
        )

        fwd_time = datetime.fromisoformat(original.received_date_time) + timedelta(
            minutes=random.randint(5, 120)
        )

        fwd_email = SimEmail(
            id=new_id(),
            subject=f"FW: {original.subject}",
            body_content=fwd_body,
            from_name=forwarder.name,
            from_address=forwarder.email,
            to_recipients=[EmailRecipient(name=fwd_to.name, address=fwd_to_email)],
            received_date_time=fwd_time.isoformat(),
            sent_date_time=(fwd_time - timedelta(seconds=30)).isoformat(),
            conversation_id=new_id(),  # new thread for the forward
            project_id=project.id,
        )
        self.db.insert_message(fwd_email)

        # Update context of involved agents
        for proj_agents in self.agents.values():
            for e, a in proj_agents.items():
                if e in (forwarder.email, fwd_to_email):
                    a.add_email_to_context(fwd_email)

    # ------------------------------------------------------------------
    def _run_meeting(self, meeting_config: dict, sim_date: datetime):
        """Run a scheduled meeting."""
        # Build recent emails per participant
        recent_by_participant = {}
        for email in meeting_config["attendees"]:
            for proj_agents in self.agents.values():
                if email in proj_agents:
                    recent_by_participant[email] = proj_agents[email].recent_emails[-5:]
                    break

        # Active problems for this project
        proj_id = meeting_config.get("project_id", "")
        active_problems = self.problems.get(proj_id, [])

        event, report_email = self.meeting_simulator.run_meeting(
            meeting_config=meeting_config,
            participants=self.participants,
            active_problems=active_problems,
            recent_emails_by_participant=recent_by_participant,
            sim_date=sim_date,
        )

        if event:
            self.db.insert_calendar_event(event)

        if report_email:
            self.db.insert_message(report_email)
            # Add report to all attendee agents' context
            for proj_agents in self.agents.values():
                for e, a in proj_agents.items():
                    if e in meeting_config["attendees"]:
                        a.add_email_to_context(report_email)
