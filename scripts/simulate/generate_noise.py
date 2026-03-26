"""
Generate noise/spam emails from PDF chunks and Wikipedia content.
No LLM calls — just random chunks inserted into realistic-looking admin emails.

Usage:
    python -m scripts.simulate.generate_noise --db data/mock-mailbox.sqlite --days 3
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sqlite3
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path

# ── PDF parsing ───────────────────────────────────────────────────────────────

def parse_all_pdfs(pdf_dir: str) -> list[str]:
    """Parse all PDFs and return a list of text chunks (~300-800 chars each)."""
    from pypdf import PdfReader

    chunks = []
    pdf_files = sorted(Path(pdf_dir).glob("*.pdf"))
    print(f"Parsing {len(pdf_files)} PDFs...")

    for pdf_path in pdf_files:
        try:
            reader = PdfReader(str(pdf_path))
            full_text = ""
            for page in reader.pages:
                text = page.extract_text()
                if text:
                    full_text += text + "\n"

            # Split into chunks of 300-800 chars on paragraph boundaries
            paragraphs = [p.strip() for p in full_text.split("\n\n") if len(p.strip()) > 50]
            current_chunk = ""
            for para in paragraphs:
                if len(current_chunk) + len(para) > 800:
                    if len(current_chunk) > 100:
                        chunks.append(current_chunk.strip())
                    current_chunk = para
                else:
                    current_chunk += "\n\n" + para
            if len(current_chunk) > 100:
                chunks.append(current_chunk.strip())

        except Exception as e:
            print(f"  Warning: could not parse {pdf_path.name}: {e}")

    print(f"  Extracted {len(chunks)} text chunks from PDFs")
    return chunks


# ── Wikipedia content ─────────────────────────────────────────────────────────

WIKI_TOPICS = [
    # Topics related to meeting subjects (will match semantic search)
    "Intelligence artificielle",
    "Grand modèle de langage",
    "EPFL",
    "GPU computing",
    "RGPD",
    "Horizon Europe",
    "Traitement automatique du langage naturel",
    "Fine-tuning (deep learning)",
    "Kubernetes",
    "Cloud computing",
    "Pédagogie universitaire",
    "Bologna Process",
    "Machine learning",
    "Data protection",
    "European Research Council",
    # General noise topics
    "Lausanne",
    "Confédération suisse",
    "Fonds national suisse de la recherche scientifique",
    "Organisation des Nations unies",
    "Développement durable",
]


def fetch_wikipedia_chunks() -> list[str]:
    """Fetch Wikipedia articles and split into chunks."""
    try:
        import wikipediaapi
    except ImportError:
        print("  wikipedia-api not installed, skipping Wikipedia content")
        return []

    wiki = wikipediaapi.Wikipedia(
        user_agent="EPFL-MailSim/1.0 (research project)",
        language="fr",
    )
    chunks = []

    print(f"Fetching {len(WIKI_TOPICS)} Wikipedia articles...")
    for topic in WIKI_TOPICS:
        try:
            page = wiki.page(topic)
            if not page.exists():
                # Try English
                wiki_en = wikipediaapi.Wikipedia(
                    user_agent="EPFL-MailSim/1.0 (research project)",
                    language="en",
                )
                page = wiki_en.page(topic)
            if not page.exists():
                continue

            text = page.text
            # Split into chunks
            paragraphs = [p.strip() for p in text.split("\n\n") if len(p.strip()) > 80]
            for para in paragraphs[:15]:  # Max 15 chunks per article
                if 100 < len(para) < 1000:
                    chunks.append(para)

        except Exception as e:
            print(f"  Warning: Wikipedia fetch failed for '{topic}': {e}")

    print(f"  Fetched {len(chunks)} chunks from Wikipedia")
    return chunks


# ── Noise email generators ────────────────────────────────────────────────────

NOISE_SENDERS = [
    ("Service juridique EPFL", "legal@epfl.ch"),
    ("DIT - Direction informatique", "dit-info@epfl.ch"),
    ("Vice-présidence pour les affaires académiques", "vpaa-info@epfl.ch"),
    ("Ressources Humaines EPFL", "rh-info@epfl.ch"),
    ("Service financier EPFL", "finances@epfl.ch"),
    ("Bibliothèque EPFL", "library@epfl.ch"),
    ("Service de la recherche", "research-office@epfl.ch"),
    ("Campus EPFL", "campus@epfl.ch"),
    ("Formation continue EPFL", "formation-continue@epfl.ch"),
    ("Service académique", "sac@epfl.ch"),
    ("Direction générale EPFL", "direction@epfl.ch"),
    ("Commission d'éthique EPFL", "ethics@epfl.ch"),
    ("Service des relations internationales", "international@epfl.ch"),
    ("Secrétariat général", "secretariat.general@epfl.ch"),
    ("EPFL Innovation Park", "innovation-park@epfl.ch"),
    ("Service de sécurité EPFL", "securite@epfl.ch"),
    ("Sustainability Office", "sustainability@epfl.ch"),
    ("Newsletter EPFL", "newsletter@epfl.ch"),
    ("IT Security EPFL", "it-security@epfl.ch"),
    ("Grant Office EPFL", "grants@epfl.ch"),
]

SUBJECT_TEMPLATES = [
    # Administrative
    "Mise à jour de la directive {ref}",
    "Rappel : {ref} — consultation ouverte jusqu'au {date}",
    "[INFO] Modification du règlement {ref}",
    "Nouvelle version de la LEX {ref} — entrée en vigueur {date}",
    "Consultation : projet de révision {ref}",
    "[IMPORTANT] Changement de procédure — {ref}",
    "Information : mise à jour réglementaire {ref}",
    # IT/Infra
    "Maintenance planifiée — {system} le {date}",
    "[ACTION REQUISE] Migration {system} — deadline {date}",
    "Mise à jour sécurité {system}",
    "Nouveau service disponible : {system}",
    # Events
    "Invitation : séminaire {topic} — {date}",
    "Rappel : workshop {topic} le {date}",
    "Conférence invitée : {topic}",
    "[SAVE THE DATE] {topic} — {date}",
    # Research/Grants
    "Appel à projets : {topic}",
    "Deadline rappel : soumission {topic} le {date}",
    "Résultats évaluation {topic}",
    "Opportunité de financement : {topic}",
    # HR/Admin
    "Rappel : formulaire {ref} à soumettre avant le {date}",
    "Mise à jour politique RH : {ref}",
    "Information importante : {ref}",
    "Procédure révisée : {ref}",
]

LEX_REFS = [
    "LEX 1.1.1", "LEX 1.3.4", "LEX 2.4.1", "LEX 2.11.2", "LEX 3.2.1",
    "LEX 4.1.3", "LEX 1.5.1", "LEX 2.3.1", "LEX 3.4.2", "LEX 1.10.1",
    "LEX 5.1.1", "LEX 2.1.0", "LEX 3.3.0", "LEX 4.2.1", "LEX 1.8.3",
]

SYSTEMS = [
    "SESAME", "IS-Academia", "ServiceNow", "Accred", "People@EPFL",
    "Infoscience", "VPN EPFL", "Zoom EPFL", "myPrint", "Tequila",
    "Exchange Online", "EPFL Cloud (ENAC-IT)", "NAS Storage", "HPC Cluster",
    "GitLab EPFL", "Moodle", "SWITCHdrive", "EPFL Wifi",
]

TOPICS_NOISE = [
    "IA responsable dans l'enseignement supérieur",
    "Open Science et données de recherche",
    "Cybersécurité et protection des données",
    "Développement durable sur le campus",
    "Diversité et inclusion dans la recherche",
    "Mobilité académique internationale",
    "Entrepreneuriat et innovation",
    "Bien-être au travail dans le monde académique",
    "Éthique de la recherche",
    "Transformation numérique de l'enseignement",
    "Collaboration industrie-académie",
    "Financement européen de la recherche",
]


def random_date_str() -> str:
    d = datetime(2026, 3, 1) + timedelta(days=random.randint(5, 60))
    return d.strftime("%d %B %Y")


def generate_subject() -> str:
    template = random.choice(SUBJECT_TEMPLATES)
    return template.format(
        ref=random.choice(LEX_REFS),
        date=random_date_str(),
        system=random.choice(SYSTEMS),
        topic=random.choice(TOPICS_NOISE),
    )


def build_noise_email(
    chunks: list[str],
    recipient_email: str,
    recipient_name: str,
    sim_date: datetime,
) -> dict:
    """Build a noise email with 1-3 random chunks."""
    sender_name, sender_email = random.choice(NOISE_SENDERS)
    subject = generate_subject()

    # Pick 1-3 random chunks
    num_chunks = random.randint(1, 3)
    selected = random.sample(chunks, min(num_chunks, len(chunks)))
    body = "\n\n---\n\n".join(selected)

    # Add a generic header/footer
    headers = [
        f"Bonjour,\n\nVeuillez trouver ci-dessous les informations relatives à ce sujet.\n\n",
        f"Cher/Chère collègue,\n\nNous vous informons des éléments suivants :\n\n",
        f"Madame, Monsieur,\n\nPour information :\n\n",
        f"Information importante pour la communauté EPFL :\n\n",
        f"Dear colleagues,\n\nPlease find below the relevant information.\n\n",
    ]
    footers = [
        "\n\nCordialement,\n" + sender_name,
        "\n\nBest regards,\n" + sender_name,
        "\n\nMerci de votre attention.\n" + sender_name,
        f"\n\n---\nCe message est envoyé automatiquement. Pour toute question : {sender_email}",
        "\n\nAvec nos meilleures salutations,\n" + sender_name,
    ]

    full_body = random.choice(headers) + body + random.choice(footers)

    hour = random.randint(6, 22)
    minute = random.randint(0, 59)
    email_time = sim_date.replace(hour=hour, minute=minute, second=random.randint(0, 59))

    return {
        "id": str(uuid.uuid4()),
        "subject": subject,
        "body_content": full_body,
        "body_content_type": "Text",
        "body_preview": full_body.replace("\n", " ").strip()[:255],
        "from_name": sender_name,
        "from_address": sender_email,
        "to_recipients_json": json.dumps([{
            "emailAddress": {"name": recipient_name, "address": recipient_email}
        }]),
        "cc_recipients_json": "[]",
        "received_date_time": email_time.isoformat(),
        "sent_date_time": (email_time - timedelta(seconds=30)).isoformat(),
        "conversation_id": str(uuid.uuid4()),
        "parent_folder_id": "inbox",
        "is_read": 1 if random.random() > 0.4 else 0,
        "project_id": None,
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Generate noise emails from PDFs and Wikipedia")
    parser.add_argument("--db", default="data/mock-mailbox.sqlite", help="SQLite database path")
    parser.add_argument("--pdf-dir", default="data/LEXs", help="Directory with PDF files")
    parser.add_argument("--days", type=int, default=3, help="Number of simulated days")
    parser.add_argument("--emails-per-day", type=int, default=15, help="Noise emails per participant per day")
    parser.add_argument("--no-wikipedia", action="store_true", help="Skip Wikipedia fetching")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"Database not found: {db_path}")
        sys.exit(1)

    # Parse sources
    chunks = parse_all_pdfs(args.pdf_dir)

    if not args.no_wikipedia:
        wiki_chunks = fetch_wikipedia_chunks()
        chunks.extend(wiki_chunks)

    if not chunks:
        print("No text chunks available. Exiting.")
        sys.exit(1)

    print(f"Total chunks available: {len(chunks)}")

    # Open DB
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    # Get participants
    participants = conn.execute("SELECT email, name FROM participants").fetchall()
    print(f"Participants: {len(participants)}")

    # Get simulation start date from existing emails
    first_date = conn.execute(
        "SELECT MIN(received_date_time) FROM messages"
    ).fetchone()[0]
    start_date = datetime.fromisoformat(first_date[:10])

    # Generate noise
    total = 0
    for day in range(args.days):
        sim_date = start_date + timedelta(days=day)
        print(f"\nDay {day + 1}/{args.days} — {sim_date.strftime('%A %d %B %Y')}")

        for p in participants:
            # Variable noise per participant (some get more spam than others)
            num_emails = random.randint(
                args.emails_per_day // 2,
                args.emails_per_day,
            )

            for _ in range(num_emails):
                email = build_noise_email(chunks, p["email"], p["name"], sim_date)
                conn.execute(
                    """INSERT INTO messages
                    (id, subject, body_content, body_content_type, body_preview,
                     from_name, from_address, to_recipients_json, cc_recipients_json,
                     received_date_time, sent_date_time, conversation_id,
                     parent_folder_id, is_read, project_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        email["id"], email["subject"], email["body_content"],
                        email["body_content_type"], email["body_preview"],
                        email["from_name"], email["from_address"],
                        email["to_recipients_json"], email["cc_recipients_json"],
                        email["received_date_time"], email["sent_date_time"],
                        email["conversation_id"], email["parent_folder_id"],
                        email["is_read"], email["project_id"],
                    ),
                )
                total += 1

        conn.commit()
        print(f"  Generated {total} noise emails so far")

    conn.close()
    print(f"\nDone! {total} noise emails added to {db_path}")


if __name__ == "__main__":
    main()
