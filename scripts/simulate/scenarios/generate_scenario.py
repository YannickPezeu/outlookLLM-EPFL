"""
Generate a large-scale EPFL scenario with ~30 participants and ~20 projects.
Uses LLM to create realistic project descriptions and participant assignments.

Usage:
    python -m scripts.simulate.scenarios.generate_scenario [--output scenarios/large_epfl.py]
"""

from __future__ import annotations

import json
import os
import random
import sys
from pathlib import Path

# Ensure project root is in path
project_root = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(project_root))

from scripts.simulate.llm_client import LLMClient


# ─── Fixed participant pool ──────────────────────────────────────────────────
# We define participants manually for consistency, then let the LLM assign them
# to projects.

PARTICIPANT_POOL = [
    # Senior leadership
    {"name": "Marc Dubois", "email": "marc.dubois@epfl.ch", "role": "Vice-président associé pour les systèmes d'information", "personality": "Stratégique et direct. Pense budget et impact institutionnel. Impatient avec les détails techniques. Veut des décisions rapides.", "activity": "high"},
    {"name": "Christine Dupont", "email": "christine.dupont@epfl.ch", "role": "Doyenne associée pour l'enseignement, Faculté IC", "personality": "Diplomate et pondérée. Cherche le consensus. Mails bien structurés, prend le temps de la réflexion.", "activity": "medium"},
    {"name": "Philippe Renaud", "email": "philippe.renaud@epfl.ch", "role": "Doyen de la Faculté IC", "personality": "Visionnaire mais pragmatique. Délègue beaucoup. Intervient surtout sur les décisions stratégiques. Mails courts.", "activity": "low"},
    {"name": "Carla Monti", "email": "carla.monti@epfl.ch", "role": "Vice-présidente pour la recherche", "personality": "Exigeante et analytique. Pousse pour l'excellence. Demande toujours des métriques et des résultats concrets.", "activity": "medium"},

    # Professors
    {"name": "Thomas Keller", "email": "thomas.keller@epfl.ch", "role": "Professeur, Laboratoire d'Intelligence Artificielle (LIA)", "personality": "Brillant mais distrait. Répond en retard. Très pointu techniquement. Propose des solutions trop ambitieuses. Écrit en anglais.", "activity": "medium"},
    {"name": "Isabelle Chen", "email": "isabelle.chen@epfl.ch", "role": "Professeure associée, NLP Lab", "personality": "Dynamique et collaborative. Grand réseau international. Souvent en déplacement, mails courts depuis le téléphone.", "activity": "high"},
    {"name": "Robert Andersen", "email": "robert.andersen@epfl.ch", "role": "Professeur, Data Science Lab", "personality": "Méthodique et prudent. Demande toujours plus de données avant de décider. Publications = priorité absolue.", "activity": "medium"},
    {"name": "Yuki Tanaka", "email": "yuki.tanaka@epfl.ch", "role": "Professeure assistante, Computer Vision Lab", "personality": "Jeune prof dynamique. Très active, propose beaucoup d'initiatives. Parfois trop enthousiaste. Bilingue japonais-anglais.", "activity": "high"},
    {"name": "Andreas Weber", "email": "andreas.weber@epfl.ch", "role": "Professeur, Systèmes distribués", "personality": "Ingénieur dans l'âme. Pragmatique, focus sur la scalabilité. Sceptique des solutions à la mode. Mails directs.", "activity": "medium"},
    {"name": "Marie-Claire Jolivet", "email": "marie-claire.jolivet@epfl.ch", "role": "Professeure, Éthique et IA", "personality": "Réfléchie et articulée. Soulève les questions éthiques. Écrit des mails longs et argumentés. Respectée par tous.", "activity": "medium"},

    # Senior staff / project managers
    {"name": "Sophie Martin", "email": "sophie.martin@epfl.ch", "role": "Cheffe de projet Infrastructure IA, Direction IT", "personality": "Organisée et méticuleuse. Tableaux Excel pour tout. Beaucoup de mails de suivi. Stressée par les deadlines.", "activity": "high"},
    {"name": "Nadia Benali", "email": "nadia.benali@epfl.ch", "role": "Responsable sécurité des données (DPO)", "personality": "Prudente et rigoureuse. Soulève systématiquement les questions RGPD. Bloque si pas compliant. Très pro.", "activity": "medium"},
    {"name": "David Nguyen", "email": "david.nguyen@epfl.ch", "role": "Coordinateur pédagogique, Section Informatique", "personality": "Enthousiaste et bavard. Champion de l'innovation pédagogique. Envoie plein de liens. Parfois hors-sujet.", "activity": "high"},
    {"name": "Lucas Favre", "email": "lucas.favre@epfl.ch", "role": "Ingénieur système senior, Cloud & HPC", "personality": "Pragmatique et décontracté. Expert Kubernetes et GPU. Blagues geek. Répond vite mais concis.", "activity": "high"},
    {"name": "Pierre Müller", "email": "pierre.muller@epfl.ch", "role": "Gestionnaire financier, Faculté IC", "personality": "Méthodique et rigide. Cite les règlements. Rappels de deadline budget. Formulation administrative.", "activity": "low"},
    {"name": "Sandra Roux", "email": "sandra.roux@epfl.ch", "role": "Assistante administrative, Faculté IC", "personality": "Efficace et serviable. Point de contact logistique. Répond toujours rapidement. Mails courts et pratiques.", "activity": "medium"},
    {"name": "Olivier Blanc", "email": "olivier.blanc@epfl.ch", "role": "Responsable communication, Faculté IC", "personality": "Créatif et sociable. Events, séminaires, visites. Mails engageants. Au courant des potins du campus.", "activity": "medium"},
    {"name": "Fatima El-Khoury", "email": "fatima.el-khoury@epfl.ch", "role": "Responsable transfert de technologie", "personality": "Business-oriented. Parle licences, brevets, startups. Connecte chercheurs et industrie. Directe et efficace.", "activity": "medium"},

    # Researchers / PostDocs
    {"name": "Elena Rossi", "email": "elena.rossi@epfl.ch", "role": "Doctorante 4e année, LIA — fine-tuning LLM", "personality": "Enthousiaste et travailleuse. Volontaire pour les benchmarks. Mails détaillés avec résultats. Mélange italien/français.", "activity": "medium"},
    {"name": "Alexandre Morin", "email": "alexandre.morin@epfl.ch", "role": "Doctorant 3e année, NLP Lab", "personality": "Sérieux et méthodique. Stressé par sa thèse. Questions techniques. Mails longs et détaillés.", "activity": "medium"},
    {"name": "Anna Schmidt", "email": "anna.schmidt@ethz.ch", "role": "PostDoc, ETH Zürich — collaboratrice", "personality": "Allemande organisée. Documents impeccables. To-do lists et deadlines claires. Bilingue allemand-anglais.", "activity": "medium"},
    {"name": "James Wilson", "email": "james.wilson@mit.edu", "role": "Professor, MIT CSAIL — collaborateur externe", "personality": "Américain direct et efficace. Anglais uniquement. Très occupé, répond en 1-2 phrases.", "activity": "low"},
    {"name": "Lina Park", "email": "lina.park@epfl.ch", "role": "PostDoc, Computer Vision Lab", "personality": "Perfectionniste. Excellente en rédaction. Gère les soumissions de papiers. Calme et méthodique.", "activity": "medium"},
    {"name": "Omar Hassan", "email": "omar.hassan@epfl.ch", "role": "Doctorant 2e année, Systèmes distribués", "personality": "Curieux et proactif. Pose beaucoup de questions. Bon en coding, moins en rédaction. Informel.", "activity": "medium"},
    {"name": "Clara Zimmermann", "email": "clara.zimmermann@epfl.ch", "role": "Doctorante 3e année, Éthique et IA", "personality": "Analytique et engagée. Travaille sur les biais algorithmiques. Articulée, mails structurés.", "activity": "medium"},

    # External collaborators
    {"name": "Maria Garcia", "email": "m.garcia@google.com", "role": "Research Scientist, Google DeepMind", "personality": "Sharp et concise. Focus résultats. Contraintes corporate sur le partage de données. Anglais.", "activity": "low"},
    {"name": "Henrik Larsson", "email": "henrik.larsson@ki.se", "role": "Professeur, Karolinska Institute", "personality": "Expert en IA médicale. Prudent, éthique d'abord. Parle slow mais pertinent.", "activity": "low"},
    {"name": "Jean-Claude Martin", "email": "jc.martin@unige.ch", "role": "Professeur, Université de Genève", "personality": "Collègue de longue date. Informel, tutoie tout le monde. Expert en linguistique computationnelle.", "activity": "low"},
    {"name": "Priya Sharma", "email": "priya.sharma@inria.fr", "role": "Chargée de recherche, INRIA Paris", "personality": "Brillante et ambitieuse. Pousse pour les collaborations. Bilingue français-anglais.", "activity": "low"},
    {"name": "Marco Bianchi", "email": "marco.bianchi@polimi.it", "role": "Professore, Politecnico di Milano", "personality": "Chaleureux et enthousiaste. Partenaire Horizon Europe. Mélange italien-anglais.", "activity": "low"},
]


def generate_projects(llm: LLMClient) -> dict:
    """Use LLM to generate ~20 realistic EPFL projects."""

    participant_list = "\n".join(
        f"- {p['name']} <{p['email']}> ({p['role']})"
        for p in PARTICIPANT_POOL
    )

    prompt = f"""Tu dois créer exactement 20 projets réalistes pour une simulation d'emails EPFL.
Chaque projet doit avoir entre 4 et 8 participants choisis parmi la liste ci-dessous.

CONTRAINTES IMPORTANTES :
- Chaque participant doit apparaître dans AU MOINS 2 projets et AU PLUS 6 projets
- Les projets de recherche incluent des profs + doctorants/postdocs
- Les projets admin/infra incluent du staff + leadership
- Les projets pédagogiques incluent profs + coordinateurs
- Les collaborateurs externes (ETH, MIT, Google, etc.) ne sont que dans 1-2 projets
- Mix de types : recherche, infrastructure, pédagogie, administratif, événementiel
- Certains projets sont des "petits" projets (4 personnes), d'autres des "gros" (7-8)
- Les descriptions sont en 2-3 phrases avec des détails concrets (budgets, deadlines, salles)

PARTICIPANTS DISPONIBLES :
{participant_list}

Réponds UNIQUEMENT en JSON array :
[
  {{
    "id": "slug-du-projet",
    "title": "Titre court du projet",
    "description": "Description 2-3 phrases avec détails concrets",
    "participants": ["email1@epfl.ch", "email2@epfl.ch", ...]
  }},
  ...
]"""

    result = llm.chat_json(
        "Tu es un générateur de données de simulation pour une université suisse (EPFL). "
        "Tu crées des projets réalistes et variés.",
        prompt,
        temperature=0.9,
        max_tokens=8192,
    )
    return result


def generate_meetings(llm: LLMClient, projects: list[dict]) -> list[dict]:
    """Generate meeting schedule for 30 days."""

    projects_summary = "\n".join(
        f"- {p['id']}: {p['title']} ({len(p['participants'])} participants)"
        for p in projects
    )

    prompt = f"""Crée un planning de réunions sur 30 jours pour ces 20 projets EPFL.

PROJETS :
{projects_summary}

CONTRAINTES :
- Chaque projet a 1-3 réunions sur les 30 jours
- Total ~35-45 réunions
- Pas de réunions le week-end (jours 6,7,13,14,20,21,27,28 si on commence un lundi)
- Les réunions ont lieu dans des salles EPFL réalistes (BC 410, INJ 218, CM 1 120, etc.) ou en Zoom/Teams
- Chaque réunion a un ordre du jour en 3-4 points
- Les participants sont un SOUS-ENSEMBLE du projet (pas forcément tout le monde, 3-6 personnes)
- Durée : 30, 45, 60, 90 ou 120 minutes

Réponds UNIQUEMENT en JSON array :
[
  {{
    "day": 3,
    "project_id": "slug-du-projet",
    "subject": "Titre court de la réunion",
    "agenda": "1. Point A\\n2. Point B\\n3. Point C",
    "location": "BC 410",
    "duration_minutes": 60,
    "attendees": ["email1@epfl.ch", "email2@epfl.ch"]
  }},
  ...
]"""

    result = llm.chat_json(
        "Tu es un générateur de données de simulation pour une université suisse (EPFL).",
        prompt,
        temperature=0.8,
        max_tokens=8192,
    )
    return result


def main():
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--output", "-o", default="scripts/simulate/scenarios/large_epfl.py")
    parser.add_argument("--model", "-m", default=None)
    parser.add_argument("--backend", "-b", default="gemini", choices=["gemini", "anthropic"])
    args = parser.parse_args()

    # Load .env
    env_path = project_root / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                os.environ.setdefault(key.strip(), value.strip())

    llm = LLMClient(model=args.model, backend=args.backend)

    print("Generating 20 projects...")
    projects = generate_projects(llm)
    print(f"  Got {len(projects)} projects")

    # Validate participant coverage
    all_assigned = set()
    for p in projects:
        for e in p["participants"]:
            all_assigned.add(e)
    pool_emails = {p["email"] for p in PARTICIPANT_POOL}
    missing = pool_emails - all_assigned
    if missing:
        print(f"  Warning: {len(missing)} participants not in any project: {missing}")

    # Count assignments per participant
    counts = {}
    for p in projects:
        for e in p["participants"]:
            counts[e] = counts.get(e, 0) + 1
    print("  Assignments per participant:")
    for e, c in sorted(counts.items(), key=lambda x: -x[1]):
        name = next((p["name"] for p in PARTICIPANT_POOL if p["email"] == e), e)
        print(f"    {name}: {c} projects")

    print("\nGenerating meeting schedule...")
    meetings = generate_meetings(llm, projects)
    print(f"  Got {len(meetings)} meetings")

    print(f"\n{llm.usage_summary()}")

    # Write Python file
    output_path = project_root / args.output
    _write_scenario_file(output_path, projects, meetings)
    print(f"\nScenario written to {output_path}")


def _write_scenario_file(path: Path, projects: list[dict], meetings: list[dict]):
    """Write the scenario as a Python module."""
    lines = [
        '"""Large-scale EPFL scenario: ~20 projects, ~30 participants, ~40 meetings.',
        'Auto-generated by generate_scenario.py."""',
        "",
        "from __future__ import annotations",
        "",
        "from ..models import Participant, Project",
        "",
    ]

    # Participants
    lines.append("PARTICIPANTS: list[Participant] = [")
    for p in PARTICIPANT_POOL:
        lines.append(f"    Participant(")
        lines.append(f"        email={p['email']!r},")
        lines.append(f"        name={p['name']!r},")
        lines.append(f"        role={p['role']!r},")
        lines.append(f"        personality={p['personality']!r},")
        lines.append(f"        activity_level={p['activity']!r},")
        lines.append(f"    ),")
    lines.append("]")
    lines.append("")

    # Projects
    lines.append("PROJECTS: list[Project] = [")
    for p in projects:
        lines.append(f"    Project(")
        lines.append(f"        id={p['id']!r},")
        lines.append(f"        title={p['title']!r},")
        lines.append(f"        description={p['description']!r},")
        lines.append(f"        participants={p['participants']!r},")
        lines.append(f"    ),")
    lines.append("]")
    lines.append("")

    # Noise senders
    lines.append("NOISE_SENDERS: list[dict] = [")
    for sender in [
        {"name": "Service Desk EPFL", "email": "servicedesk@epfl.ch", "role": "Support IT central"},
        {"name": "RH EPFL", "email": "rh-info@epfl.ch", "role": "Ressources Humaines"},
        {"name": "Bibliothèque EPFL", "email": "library@epfl.ch", "role": "Service bibliothèque"},
        {"name": "Formation continue", "email": "formation-continue@epfl.ch", "role": "Centre formation continue"},
        {"name": "Campus EPFL", "email": "campus@epfl.ch", "role": "Services généraux campus"},
    ]:
        lines.append(f"    {sender!r},")
    lines.append("]")
    lines.append("")

    # Noise topics
    lines.append("NOISE_TOPICS: list[str] = [")
    for topic in [
        "Maintenance planifiée du VPN ce week-end",
        "Rappel : formulaire de vacances à soumettre avant le 15",
        "Invitation : séminaire IA et société",
        "Nouvelle politique de mots de passe",
        "Workshop: Introduction à GitHub Copilot",
        "Rappel: évaluation des enseignements",
        "Conférence invitée: Prof. Yann LeCun",
        "Enquête satisfaction IT",
        "Appel à candidatures: prix enseignement IC 2026",
        "Rappel: backup données avant migration serveurs",
    ]:
        lines.append(f"    {topic!r},")
    lines.append("]")
    lines.append("")

    # Meetings
    lines.append("MEETING_SCHEDULE: list[dict] = [")
    for m in meetings:
        lines.append(f"    {{")
        lines.append(f"        \"day\": {m['day']},")
        lines.append(f"        \"project_id\": {m['project_id']!r},")
        lines.append(f"        \"subject\": {m['subject']!r},")
        lines.append(f"        \"agenda\": {m['agenda']!r},")
        lines.append(f"        \"location\": {m.get('location', 'BC 410')!r},")
        lines.append(f"        \"duration_minutes\": {m.get('duration_minutes', 60)},")
        lines.append(f"        \"attendees\": {m['attendees']!r},")
        lines.append(f"    }},")
    lines.append("]")
    lines.append("")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
