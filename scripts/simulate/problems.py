"""Problem generator — injects realistic complications into the simulation."""

from __future__ import annotations

import logging
import random

from .llm_client import LLMClient
from .models import Problem, Project, Participant, new_id
from .prompts import PROBLEM_GENERATOR_SYSTEM, PROBLEM_GENERATOR_USER

log = logging.getLogger(__name__)


class ProblemGenerator:
    """Generates random project complications via LLM."""

    def __init__(self, llm: LLMClient):
        self.llm = llm

    def maybe_generate(
        self,
        project: Project,
        participants: dict[str, Participant],
        day: int,
        existing_problems: list[Problem],
        probability: float = 0.20,
    ) -> Problem | None:
        """Generate a problem with the given probability. Returns None if no problem."""
        if random.random() > probability:
            return None

        participants_list = "\n".join(
            f"- {participants[e].name} <{e}> ({participants[e].role})"
            for e in project.participants
            if e in participants
        )
        previous = "\n".join(
            f"- Jour {p.injected_on_day}: {p.description}"
            for p in existing_problems
        ) or "(Aucun problème précédent)"

        try:
            result = self.llm.chat_json(
                PROBLEM_GENERATOR_SYSTEM,
                PROBLEM_GENERATOR_USER.format(
                    title=project.title,
                    description=project.description,
                    participants_list=participants_list,
                    day=day,
                    previous_problems=previous,
                ),
                temperature=0.9,
                max_tokens=256,
            )
        except Exception as e:
            log.warning("Problem generation failed for %s: %s", project.id, e)
            return None

        description = result.get("description", "Problème technique imprévu")
        affects = result.get("affects", [])
        if isinstance(affects, str):
            affects = [affects]

        # Filter to valid project participants
        valid = set(project.participants)
        affects = [e for e in affects if e in valid]
        if not affects:
            # Pick 2-3 random participants
            affects = random.sample(project.participants, min(3, len(project.participants)))

        problem = Problem(
            id=new_id(),
            project_id=project.id,
            description=description,
            injected_on_day=day,
            affects_participants=affects,
        )
        log.info("  💥 Problem injected (day %d, %s): %s", day, project.id, description)
        return problem
