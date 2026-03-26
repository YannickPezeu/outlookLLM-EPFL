"""Default EPFL scenario: 2-3 projects with overlapping participants."""

from __future__ import annotations

from ..models import Participant, Project

# ─── Participants ─────────────────────────────────────────────────────────────
# Each participant has a distinct personality that shapes their email style.

PARTICIPANTS: list[Participant] = [
    # Project 1: GenAI EPFL - Senior leadership + tech
    Participant(
        email="marc.dubois@epfl.ch",
        name="Marc Dubois",
        role="Vice-président associé pour les systèmes d'information (VPA-SI)",
        personality="Stratégique et direct. Pense en termes de budget et d'impact institutionnel. "
        "Impatient avec les détails techniques. Veut des résumés clairs et des décisions rapides.",
        activity_level="high",
    ),
    Participant(
        email="sophie.martin@epfl.ch",
        name="Sophie Martin",
        role="Cheffe de projet Infrastructure IA, Direction IT",
        personality="Organisée et méticuleuse. Crée des tableaux Excel pour tout. "
        "Envoie beaucoup de mails de suivi. Légèrement stressée par les deadlines.",
        activity_level="high",
    ),
    Participant(
        email="thomas.keller@epfl.ch",
        name="Thomas Keller",
        role="Professeur, Laboratoire d'Intelligence Artificielle (LIA)",
        personality="Brillant mais distrait. Répond souvent en retard. Très pointu sur la technique. "
        "Tendance à proposer des solutions trop ambitieuses. Écrit en anglais par défaut.",
        activity_level="medium",
    ),
    Participant(
        email="nadia.benali@epfl.ch",
        name="Nadia Benali",
        role="Responsable sécurité des données (DPO), Direction IT",
        personality="Prudente et rigoureuse. Soulève systématiquement les questions de compliance et RGPD. "
        "Bloque les projets si les aspects légaux ne sont pas couverts. Très professionnelle.",
        activity_level="medium",
    ),
    Participant(
        email="lucas.favre@epfl.ch",
        name="Lucas Favre",
        role="Ingénieur système senior, équipe Cloud & HPC",
        personality="Pragmatique et décontracté. Expert Kubernetes et GPU. "
        "Fait des blagues geek dans ses mails. Répond vite mais de façon concise.",
        activity_level="high",
    ),
    Participant(
        email="elena.rossi@epfl.ch",
        name="Elena Rossi",
        role="Doctorante, LIA — spécialiste fine-tuning LLM",
        personality="Enthousiaste et travailleuse. Toujours volontaire pour les benchmarks. "
        "Écrit des mails détaillés avec des résultats. Mélange italien et français parfois.",
        activity_level="medium",
    ),
    Participant(
        email="pierre.muller@epfl.ch",
        name="Pierre Müller",
        role="Gestionnaire financier, Faculté IC",
        personality="Méthodique et un peu rigide. Cite toujours les règlements. "
        "Envoie des rappels de deadline budget. Formulation très administrative.",
        activity_level="low",
    ),

    # Project 2: Collaboration recherche internationale
    Participant(
        email="isabelle.chen@epfl.ch",
        name="Isabelle Chen",
        role="Professeure associée, NLP Lab",
        personality="Dynamique et collaborative. Réseau international important. "
        "Souvent en déplacement. Répond depuis son téléphone (mails courts). "
        "Pousse pour publier rapidement.",
        activity_level="high",
    ),
    Participant(
        email="alexandre.morin@epfl.ch",
        name="Alexandre Morin",
        role="Doctorant 3e année, NLP Lab",
        personality="Sérieux et méthodique. Stressé par sa deadline de thèse. "
        "Pose beaucoup de questions techniques. Écrit des mails longs et détaillés.",
        activity_level="medium",
    ),
    Participant(
        email="james.wilson@mit.edu",
        name="James Wilson",
        role="Professor, MIT CSAIL — collaborateur externe",
        personality="Américain direct et efficace. Écrit uniquement en anglais. "
        "Très occupé, répond souvent en 1-2 phrases. Jet-setter académique.",
        activity_level="low",
    ),
    Participant(
        email="anna.schmidt@ethz.ch",
        name="Anna Schmidt",
        role="PostDoc, ETH Zürich — collaboratrice Horizon Europe",
        personality="Allemande organisée. Rédige des documents de travail impeccables. "
        "Aime les to-do lists et les deadlines claires. Bilingue allemand-anglais.",
        activity_level="medium",
    ),

    # Project 3: Réforme pédagogique IC
    Participant(
        email="christine.dupont@epfl.ch",
        name="Christine Dupont",
        role="Doyenne associée pour l'enseignement, Faculté IC",
        personality="Diplomate et pondérée. Cherche toujours le consensus. "
        "Prend le temps de la réflexion avant de répondre. Mails bien structurés.",
        activity_level="medium",
    ),
    Participant(
        email="david.nguyen@epfl.ch",
        name="David Nguyen",
        role="Coordinateur pédagogique, Section Informatique",
        personality="Enthousiaste et un peu bavard. Champion de l'innovation pédagogique. "
        "Envoie beaucoup de liens et de ressources. Parfois hors-sujet.",
        activity_level="high",
    ),

    # Shared across projects / noise
    Participant(
        email="sandra.roux@epfl.ch",
        name="Sandra Roux",
        role="Assistante administrative, Faculté IC",
        personality="Efficace et serviable. Point de contact pour la logistique. "
        "Répond toujours rapidement. Mails courts et pratiques.",
        activity_level="medium",
    ),
    Participant(
        email="olivier.blanc@epfl.ch",
        name="Olivier Blanc",
        role="Responsable communication, Faculté IC",
        personality="Créatif et sociable. S'occupe des events, séminaires, visites. "
        "Écrit des mails engageants. Toujours au courant des potins du campus.",
        activity_level="low",
    ),
]

# ─── Projects ─────────────────────────────────────────────────────────────────

PROJECTS: list[Project] = [
    Project(
        id="genai-epfl-2026",
        title="Déploiement GenAI EPFL 2026",
        description=(
            "Projet stratégique de déploiement d'outils d'IA générative pour la communauté EPFL. "
            "Comprend le choix d'un LLM institutionnel, le provisionnement GPU, "
            "la mise en conformité RGPD, le budget d'exploitation, et le pilote avec 3 facultés. "
            "Budget total : 2.8M CHF sur 3 ans. Deadline pilote : septembre 2026."
        ),
        participants=[
            "marc.dubois@epfl.ch",
            "sophie.martin@epfl.ch",
            "thomas.keller@epfl.ch",
            "nadia.benali@epfl.ch",
            "lucas.favre@epfl.ch",
            "elena.rossi@epfl.ch",
            "pierre.muller@epfl.ch",
        ],
    ),
    Project(
        id="horizon-nlp-2026",
        title="Horizon Europe — Multilingual NLP for Science",
        description=(
            "Projet Horizon Europe avec MIT, ETH Zürich et 3 partenaires européens. "
            "Développement de modèles NLP multilingues pour l'extraction d'information scientifique. "
            "WP1: corpus building, WP2: model training, WP3: evaluation, WP4: dissemination. "
            "Budget EPFL : 850K EUR. Kick-off prévu avril 2026."
        ),
        participants=[
            "isabelle.chen@epfl.ch",
            "alexandre.morin@epfl.ch",
            "thomas.keller@epfl.ch",  # overlap avec projet 1
            "james.wilson@mit.edu",
            "anna.schmidt@ethz.ch",
            "elena.rossi@epfl.ch",  # overlap avec projet 1
        ],
    ),
    Project(
        id="reforme-pedagogique-ic",
        title="Réforme pédagogique IC — Intégration IA dans le cursus",
        description=(
            "Réforme du programme Bachelor et Master de la Faculté IC pour intégrer "
            "l'IA dans tous les cours. Refonte de 12 cours, création de 3 nouveaux cours, "
            "formation des enseignants. Entrée en vigueur : semestre automne 2026. "
            "Comité de pilotage avec le Vice-président académique."
        ),
        participants=[
            "christine.dupont@epfl.ch",
            "david.nguyen@epfl.ch",
            "thomas.keller@epfl.ch",  # overlap
            "isabelle.chen@epfl.ch",  # overlap
            "marc.dubois@epfl.ch",  # overlap — il supervise aussi
        ],
    ),
]

# ─── Noise senders (not in projects) ─────────────────────────────────────────
NOISE_SENDERS: list[dict] = [
    {"name": "Service Desk EPFL", "email": "servicedesk@epfl.ch", "role": "Support IT central EPFL"},
    {"name": "RH EPFL", "email": "rh-info@epfl.ch", "role": "Ressources Humaines EPFL"},
    {"name": "Bibliothèque EPFL", "email": "library@epfl.ch", "role": "Service bibliothèque"},
    {"name": "Formation continue", "email": "formation-continue@epfl.ch", "role": "Centre de formation continue"},
    {"name": "Campus EPFL", "email": "campus@epfl.ch", "role": "Services généraux campus"},
]

NOISE_TOPICS: list[str] = [
    "Maintenance planifiée du VPN ce week-end",
    "Rappel : formulaire de vacances à soumettre avant le 15",
    "Invitation : séminaire IA et société — 25 mars 14h",
    "Nouvelle politique de mots de passe — action requise",
    "Fermeture exceptionnelle du restaurant BC le 28 mars",
    "Workshop: Introduction à GitHub Copilot pour les enseignants",
    "Rappel: évaluation des enseignements — deadline vendredi",
    "Mise à jour des imprimantes — nouveau driver à installer",
    "Invitation: Apéro de printemps de la Faculté IC",
    "Réservation salles: nouveau système en ligne",
    "Conférence invitée: Prof. Yann LeCun — 2 avril 16h, Forum Rolex",
    "Enquête satisfaction IT — 5 minutes de votre temps",
    "Changement horaires navette EPFL-gare — dès le 1er avril",
    "Appel à candidatures: prix du meilleur enseignement IC 2026",
    "Rappel: backup de vos données avant migration serveurs",
]

# ─── Meeting schedule template ────────────────────────────────────────────────
# Meetings are scheduled relative to the start of the simulation.
# day: day number (1-30), attendees: list of participant emails

MEETING_SCHEDULE: list[dict] = [
    # Project 1: GenAI — biweekly steering + weekly tech
    {
        "day": 3,
        "project_id": "genai-epfl-2026",
        "subject": "Comité de pilotage GenAI — Sprint Review",
        "agenda": "1. Avancement technique (Lucas, Elena)\n2. Point budget (Pierre)\n3. Conformité RGPD (Nadia)\n4. Décisions architecture",
        "location": "BC 410",
        "duration_minutes": 60,
        "attendees": ["marc.dubois@epfl.ch", "sophie.martin@epfl.ch", "thomas.keller@epfl.ch", "nadia.benali@epfl.ch", "lucas.favre@epfl.ch", "elena.rossi@epfl.ch", "pierre.muller@epfl.ch"],
    },
    {
        "day": 8,
        "project_id": "genai-epfl-2026",
        "subject": "GenAI — Réunion technique GPU & infra",
        "agenda": "1. Benchmark GPU A100 vs H100\n2. Estimation coûts cloud\n3. Architecture Kubernetes\n4. Planning déploiement",
        "location": "INJ 218",
        "duration_minutes": 45,
        "attendees": ["sophie.martin@epfl.ch", "lucas.favre@epfl.ch", "elena.rossi@epfl.ch", "thomas.keller@epfl.ch"],
    },
    {
        "day": 17,
        "project_id": "genai-epfl-2026",
        "subject": "Comité de pilotage GenAI — Mi-parcours",
        "agenda": "1. Bilan des 2 premières semaines\n2. Risques identifiés\n3. Ajustement planning\n4. Budget révisé",
        "location": "BC 410",
        "duration_minutes": 60,
        "attendees": ["marc.dubois@epfl.ch", "sophie.martin@epfl.ch", "thomas.keller@epfl.ch", "nadia.benali@epfl.ch", "lucas.favre@epfl.ch", "pierre.muller@epfl.ch"],
    },
    {
        "day": 24,
        "project_id": "genai-epfl-2026",
        "subject": "GenAI — Point sécurité et compliance",
        "agenda": "1. Audit RGPD\n2. Politique de rétention des données\n3. Formation utilisateurs\n4. Validation DPO",
        "location": "BC 329",
        "duration_minutes": 45,
        "attendees": ["nadia.benali@epfl.ch", "sophie.martin@epfl.ch", "marc.dubois@epfl.ch", "lucas.favre@epfl.ch"],
    },
    # Project 2: Horizon NLP
    {
        "day": 5,
        "project_id": "horizon-nlp-2026",
        "subject": "Horizon NLP — Consortium Call",
        "agenda": "1. WP1 corpus status\n2. WP2 model architecture decisions\n3. Budget allocation\n4. Deliverable D1.1 timeline",
        "location": "Réunion Zoom",
        "duration_minutes": 60,
        "attendees": ["isabelle.chen@epfl.ch", "alexandre.morin@epfl.ch", "thomas.keller@epfl.ch", "james.wilson@mit.edu", "anna.schmidt@ethz.ch"],
    },
    {
        "day": 12,
        "project_id": "horizon-nlp-2026",
        "subject": "Horizon NLP — EPFL Internal Sync",
        "agenda": "1. Avancement Alexandre (fine-tuning)\n2. Elena: embedding experiments\n3. Prochain papier: target venue\n4. Ressources GPU",
        "location": "INJ 114",
        "duration_minutes": 45,
        "attendees": ["isabelle.chen@epfl.ch", "alexandre.morin@epfl.ch", "elena.rossi@epfl.ch", "thomas.keller@epfl.ch"],
    },
    {
        "day": 19,
        "project_id": "horizon-nlp-2026",
        "subject": "Horizon NLP — Paper Writing Sprint Planning",
        "agenda": "1. Target: ACL 2026 deadline\n2. Experiments needed\n3. Writing assignments\n4. Internal review process",
        "location": "Réunion Zoom",
        "duration_minutes": 60,
        "attendees": ["isabelle.chen@epfl.ch", "alexandre.morin@epfl.ch", "james.wilson@mit.edu", "anna.schmidt@ethz.ch", "elena.rossi@epfl.ch"],
    },
    {
        "day": 26,
        "project_id": "horizon-nlp-2026",
        "subject": "Horizon NLP — Consortium Monthly Review",
        "agenda": "1. Month 1 progress\n2. Milestones check\n3. Risk register update\n4. Next month planning",
        "location": "Réunion Zoom",
        "duration_minutes": 90,
        "attendees": ["isabelle.chen@epfl.ch", "alexandre.morin@epfl.ch", "thomas.keller@epfl.ch", "james.wilson@mit.edu", "anna.schmidt@ethz.ch"],
    },
    # Project 3: Réforme pédagogique
    {
        "day": 7,
        "project_id": "reforme-pedagogique-ic",
        "subject": "Réforme IC — Réunion du comité pédagogique",
        "agenda": "1. Bilan consultation des sections\n2. Nouveaux cours proposés\n3. Budget formation enseignants\n4. Calendrier de mise en œuvre",
        "location": "CM 1 120",
        "duration_minutes": 90,
        "attendees": ["christine.dupont@epfl.ch", "david.nguyen@epfl.ch", "thomas.keller@epfl.ch", "isabelle.chen@epfl.ch", "marc.dubois@epfl.ch"],
    },
    {
        "day": 21,
        "project_id": "reforme-pedagogique-ic",
        "subject": "Réforme IC — Atelier conception cours IA",
        "agenda": "1. Syllabus draft 'IA pour tous'\n2. TP et projets pratiques\n3. Outils pédagogiques (Jupyter, Colab)\n4. Évaluation",
        "location": "BC 07-08",
        "duration_minutes": 120,
        "attendees": ["christine.dupont@epfl.ch", "david.nguyen@epfl.ch", "thomas.keller@epfl.ch", "isabelle.chen@epfl.ch"],
    },
]
