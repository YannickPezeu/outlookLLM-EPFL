#!/usr/bin/env node
/**
 * Generate realistic EPFL test emails and inject them into a test mailbox via Graph API.
 *
 * Usage:
 *   node scripts/generate-test-emails.mjs --token "YOUR_GRAPH_EXPLORER_TOKEN"
 *
 * The token can be obtained from https://developer.microsoft.com/en-us/graph/graph-explorer
 * (click "Access token" tab after signing in). Requires Mail.ReadWrite consent.
 */

import dotenv from "dotenv";
dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────

const GRAPH_TOKEN = process.argv.find((a, i) => process.argv[i - 1] === "--token") || "";
const RCP_API_ENDPOINT = process.env.RCP_API_ENDPOINT || "https://inference.rcp.epfl.ch/v1";
const RCP_API_KEY = process.env.RCP_API_KEY || "";
const RCP_MODEL = process.env.RCP_MISTRAL_SMALL || "mistralai/Mistral-Small-3.2-24B-Instruct-2506-bfloat16";

const TOTAL_EMAILS = parseInt(process.argv.find((a, i) => process.argv[i - 1] === "--count") || "200", 10);
const BATCH_SIZE = 10; // emails generated per LLM call
const GRAPH_BATCH_SIZE = 4; // parallel Graph API calls
const GRAPH_DELAY_MS = 200; // delay between batches to avoid rate limits

if (!GRAPH_TOKEN) {
  console.error("Usage: node scripts/generate-test-emails.mjs --token YOUR_GRAPH_TOKEN [--count 200]");
  console.error("\nGet your token from https://developer.microsoft.com/en-us/graph/graph-explorer");
  console.error("(Sign in → Access token tab → Copy)");
  process.exit(1);
}
if (!RCP_API_KEY) {
  console.error("RCP_API_KEY not found in .env");
  process.exit(1);
}

// ─── EPFL Contacts ────────────────────────────────────────────────────────────

const CONTACTS = [
  // Professors
  { name: "Martin Rajman", email: "martin.rajman@epfl.ch", role: "Professeur, Laboratoire d'Intelligence Artificielle" },
  { name: "Sabine Süsstrunk", email: "sabine.susstrunk@epfl.ch", role: "Professeure, Image and Visual Representation Lab" },
  { name: "Robert West", email: "robert.west@epfl.ch", role: "Professeur associé, Data Science Lab" },
  { name: "Antoine Bosselut", email: "antoine.bosselut@epfl.ch", role: "Professeur assistant, NLP Lab" },
  { name: "Boi Faltings", email: "boi.faltings@epfl.ch", role: "Professeur, Artificial Intelligence Laboratory" },
  { name: "Karl Aberer", email: "karl.aberer@epfl.ch", role: "Professeur, Distributed Information Systems Lab" },
  { name: "Carmela Troncoso", email: "carmela.troncoso@epfl.ch", role: "Professeure associée, SPRING Lab" },
  { name: "Mathieu Salzmann", email: "mathieu.salzmann@epfl.ch", role: "Senior Scientist, Computer Vision Lab" },
  { name: "Pascal Fua", email: "pascal.fua@epfl.ch", role: "Professeur, Computer Vision Lab" },
  { name: "François Fleuret", email: "francois.fleuret@epfl.ch", role: "Professeur, Machine Learning" },
  // PhD Students
  { name: "Alexandre Morin", email: "alexandre.morin@epfl.ch", role: "Doctorant, NLP Lab" },
  { name: "Claire Dupont", email: "claire.dupont@epfl.ch", role: "Doctorante, Data Science Lab" },
  { name: "Mehdi Benali", email: "mehdi.benali@epfl.ch", role: "Doctorant, Computer Vision Lab" },
  { name: "Sophie Chen", email: "sophie.chen@epfl.ch", role: "Doctorante, AI Lab" },
  { name: "Lucas Müller", email: "lucas.muller@epfl.ch", role: "Doctorant, SPRING Lab" },
  { name: "Amira Khedher", email: "amira.khedher@epfl.ch", role: "Doctorante, Machine Learning" },
  { name: "Thomas Girard", email: "thomas.girard@epfl.ch", role: "Doctorant, Distributed Systems" },
  { name: "Elena Popescu", email: "elena.popescu@epfl.ch", role: "Doctorante, Image Processing" },
  { name: "Marco Bianchi", email: "marco.bianchi@epfl.ch", role: "Doctorant, NLP Lab" },
  { name: "Fatima Zahra", email: "fatima.zahra@epfl.ch", role: "Doctorante, AI Lab" },
  { name: "David Kim", email: "david.kim@epfl.ch", role: "Doctorant, Data Science Lab" },
  { name: "Laura Rossi", email: "laura.rossi@epfl.ch", role: "Doctorante, Computer Vision Lab" },
  { name: "Nils Johansson", email: "nils.johansson@epfl.ch", role: "Doctorant, Machine Learning" },
  { name: "Priya Sharma", email: "priya.sharma@epfl.ch", role: "Doctorante, SPRING Lab" },
  { name: "Julien Favre", email: "julien.favre@epfl.ch", role: "Doctorant, AI Lab" },
  // Admin & Staff
  { name: "Christine Bentley", email: "christine.bentley@epfl.ch", role: "Secrétaire de faculté IC" },
  { name: "Marc Vollenweider", email: "marc.vollenweider@epfl.ch", role: "Responsable IT, faculté IC" },
  { name: "Nathalie Fontana", email: "nathalie.fontana@epfl.ch", role: "Gestionnaire RH, EPFL" },
  { name: "Pierre-André Mudry", email: "pierre-andre.mudry@epfl.ch", role: "Coordinateur enseignement IC" },
  { name: "Isabelle Ducrey", email: "isabelle.ducrey@epfl.ch", role: "Responsable communications IC" },
  { name: "Sandra Roux", email: "sandra.roux@epfl.ch", role: "Gestionnaire financière IC" },
  { name: "Philippe Gillet", email: "philippe.gillet@epfl.ch", role: "Vice-président pour les affaires académiques" },
  // External collaborators
  { name: "Jean-Claude Martin", email: "jc.martin@unige.ch", role: "Professeur, Université de Genève" },
  { name: "Anna Schmidt", email: "anna.schmidt@ethz.ch", role: "PostDoc, ETH Zürich" },
  { name: "James Wilson", email: "j.wilson@mit.edu", role: "Professor, MIT CSAIL" },
  { name: "Maria Garcia", email: "m.garcia@google.com", role: "Research Scientist, Google DeepMind" },
  { name: "Luca Benedetti", email: "l.benedetti@polimi.it", role: "Professore, Politecnico di Milano" },
];

// ─── Topics / Projects ────────────────────────────────────────────────────────

const TOPICS = [
  {
    name: "Projet GenAI EPFL 2026",
    description: "Déploiement d'outils IA générative pour la communauté EPFL. Budget, roadmap, choix technologiques.",
    participants: ["martin.rajman@epfl.ch", "antoine.bosselut@epfl.ch", "marc.vollenweider@epfl.ch", "claire.dupont@epfl.ch"],
  },
  {
    name: "Cours CS-552 Modern NLP",
    description: "Organisation du cours de NLP. TPs, examens, assistants, salles, contenu.",
    participants: ["antoine.bosselut@epfl.ch", "alexandre.morin@epfl.ch", "marco.bianchi@epfl.ch", "sophie.chen@epfl.ch"],
  },
  {
    name: "Publication EMNLP 2026",
    description: "Paper en cours de rédaction sur les LLM multilingues. Reviews, deadline, expériences.",
    participants: ["antoine.bosselut@epfl.ch", "alexandre.morin@epfl.ch", "j.wilson@mit.edu", "marco.bianchi@epfl.ch"],
  },
  {
    name: "Recrutement PostDoc Vision",
    description: "Recrutement d'un postdoc pour le Computer Vision Lab. Candidatures, entretiens, décision.",
    participants: ["pascal.fua@epfl.ch", "mathieu.salzmann@epfl.ch", "mehdi.benali@epfl.ch", "nathalie.fontana@epfl.ch"],
  },
  {
    name: "Workshop IA et Éducation",
    description: "Organisation d'un workshop sur l'IA dans l'enseignement supérieur. Intervenants, programme, logistique.",
    participants: ["sabine.susstrunk@epfl.ch", "pierre-andre.mudry@epfl.ch", "isabelle.ducrey@epfl.ch", "jc.martin@unige.ch"],
  },
  {
    name: "Budget Lab 2026-2027",
    description: "Planification budgétaire du laboratoire. Demandes de matériel, voyages, conférences, salaires.",
    participants: ["martin.rajman@epfl.ch", "sandra.roux@epfl.ch", "christine.bentley@epfl.ch"],
  },
  {
    name: "Projet Européen Horizon",
    description: "Candidature au programme Horizon Europe. Consortium, workpackages, livrables, budget.",
    participants: ["boi.faltings@epfl.ch", "karl.aberer@epfl.ch", "anna.schmidt@ethz.ch", "l.benedetti@polimi.it"],
  },
  {
    name: "Thèse Claire Dupont",
    description: "Suivi de thèse. Avancement, publications, soutenance prévue, jury.",
    participants: ["robert.west@epfl.ch", "claire.dupont@epfl.ch", "francois.fleuret@epfl.ch"],
  },
  {
    name: "Infrastructure GPU Cluster",
    description: "Gestion du cluster GPU du lab. Allocation, maintenance, nouveaux achats, accès.",
    participants: ["marc.vollenweider@epfl.ch", "thomas.girard@epfl.ch", "david.kim@epfl.ch", "lucas.muller@epfl.ch"],
  },
  {
    name: "Collaboration Google DeepMind",
    description: "Projet de recherche conjoint avec Google. NDA, données, publications, stagiaires.",
    participants: ["antoine.bosselut@epfl.ch", "m.garcia@google.com", "priya.sharma@epfl.ch", "fatima.zahra@epfl.ch"],
  },
  {
    name: "Séminaire IC Printemps 2026",
    description: "Organisation des séminaires de la faculté IC. Invitations, planning, salles.",
    participants: ["christine.bentley@epfl.ch", "isabelle.ducrey@epfl.ch", "pierre-andre.mudry@epfl.ch"],
  },
  {
    name: "Examen session été 2026",
    description: "Organisation des examens. Surveillance, salles, copies, notes, réclamations.",
    participants: ["pierre-andre.mudry@epfl.ch", "christine.bentley@epfl.ch", "julien.favre@epfl.ch"],
  },
  {
    name: "Projet Privacy-Preserving ML",
    description: "Recherche sur le machine learning respectueux de la vie privée. Federated learning, differential privacy.",
    participants: ["carmela.troncoso@epfl.ch", "lucas.muller@epfl.ch", "priya.sharma@epfl.ch", "anna.schmidt@ethz.ch"],
  },
  {
    name: "Migration Serveurs IC",
    description: "Migration des serveurs de la faculté vers le nouveau datacenter. Planning, risques, backups.",
    participants: ["marc.vollenweider@epfl.ch", "thomas.girard@epfl.ch", "karl.aberer@epfl.ch"],
  },
  {
    name: "Visite délégation MIT",
    description: "Accueil d'une délégation du MIT. Programme, logistique, présentations, dîner.",
    participants: ["philippe.gillet@epfl.ch", "j.wilson@mit.edu", "sabine.susstrunk@epfl.ch", "isabelle.ducrey@epfl.ch"],
  },
  {
    name: "Demande de fonds SNF",
    description: "Rédaction d'une demande de subvention au Fonds National Suisse. Budget, calendrier, reviewers.",
    participants: ["robert.west@epfl.ch", "claire.dupont@epfl.ch", "sandra.roux@epfl.ch"],
  },
  {
    name: "Stage été doctorants",
    description: "Organisation des stages d'été pour les étudiants Master. Sujets, encadrement, évaluation.",
    participants: ["martin.rajman@epfl.ch", "amira.khedher@epfl.ch", "nils.johansson@epfl.ch", "elena.popescu@epfl.ch"],
  },
  {
    name: "Problème accès VPN EPFL",
    description: "Tickets IT divers. Problèmes VPN, accès réseau, comptes, installations logicielles.",
    participants: ["marc.vollenweider@epfl.ch", "david.kim@epfl.ch", "laura.rossi@epfl.ch"],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomDate(monthsBack = 12) {
  const now = new Date();
  const past = new Date(now);
  past.setMonth(past.getMonth() - monthsBack);
  const ts = past.getTime() + Math.random() * (now.getTime() - past.getTime());
  return new Date(ts);
}

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function contactByEmail(email) {
  return CONTACTS.find((c) => c.email === email);
}

// ─── RCP API ──────────────────────────────────────────────────────────────────

async function generateEmailBatch(topic, participants, count) {
  const participantDescs = participants
    .map((email) => {
      const c = contactByEmail(email);
      return c ? `${c.name} <${c.email}> (${c.role})` : email;
    })
    .join("\n");

  const prompt = `Tu es un générateur de données de test. Génère exactement ${count} emails réalistes dans le contexte universitaire EPFL, organisés en THREADS de conversation (des échanges de réponses entre participants).

SUJET/PROJET : ${topic.name}
DESCRIPTION : ${topic.description}

PARTICIPANTS :
${participantDescs}

CONSIGNES :
- Chaque email doit être un JSON avec: thread_id (int), subject, body (texte brut, pas HTML), from_email, to_email, language ("fr" ou "en")
- IMPORTANT : organise les emails en threads (conversations). Un thread = un échange de 3 à 6 replies sur le même sujet.
  - Le premier email d'un thread a un subject normal (ex: "Réunion budget Q2")
  - Les réponses ont "Re: " devant le même subject (ex: "Re: Réunion budget Q2")
  - Les participants alternent : A écrit à B, B répond à A, A relance, C intervient, etc.
- thread_id : un entier qui identifie le thread (tous les mails d'un même échange ont le même thread_id)
- Mélange français (60%) et anglais (40%)
- Les emails doivent être concis (2-8 phrases) comme de vrais emails de travail
- Varie les tons : formel (profs→admin), informel (entre doctorants), mixte
- Inclus des détails réalistes : numéros de salle (BC 410, INJ 218, etc.), dates, noms de projets, acronymes EPFL
- Le body doit contenir UNIQUEMENT le nouveau contenu de ce mail (PAS de citation des messages précédents, le script les ajoutera automatiquement)
- Les signatures sont courtes : "Cordialement, Prénom" ou juste le prénom

Réponds UNIQUEMENT avec un JSON array. Pas de markdown, pas de commentaire.
[{"thread_id":1,"subject":"...","body":"...","from_email":"...","to_email":"...","language":"fr"}, ...]`;

  const response = await fetch(`${RCP_API_ENDPOINT}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RCP_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: RCP_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.9,
      max_tokens: 8192,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`RCP API error ${response.status}: ${err}`);
  }

  const result = await response.json();
  const content = result.choices[0].message.content;

  // Parse JSON from response (handle potential markdown wrapping)
  let jsonStr = content;
  // Remove markdown code fences
  jsonStr = jsonStr.replace(/```json?\s*/gi, "").replace(/```/g, "");
  jsonStr = jsonStr.trim();
  // Find the JSON array in the response
  const arrayStart = jsonStr.indexOf("[");
  const arrayEnd = jsonStr.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd !== -1) {
    jsonStr = jsonStr.slice(arrayStart, arrayEnd + 1);
  }

  try {
    const emails = JSON.parse(jsonStr);
    // Normalize: ensure to_email is always a string
    return emails.map((e) => ({
      ...e,
      to_email: Array.isArray(e.to_email) ? e.to_email[0] : e.to_email,
      from_email: Array.isArray(e.from_email) ? e.from_email[0] : e.from_email,
    }));
  } catch (e) {
    console.error("Failed to parse LLM response:", content.slice(0, 300));
    return [];
  }
}

// ─── Thread history (in-memory) ───────────────────────────────────────────────

// Map of conversationId → array of { from_name, from_email, to_name, to_email, subject, body, date }
const threadHistories = new Map();

function buildOutlookQuotedBody(freshBody, threadHistory) {
  if (threadHistory.length === 0) return freshBody;

  let fullBody = freshBody + "\n";
  // Add previous messages in reverse chronological order (most recent first)
  for (const prev of [...threadHistory].reverse()) {
    const dateStr = prev.date.toLocaleDateString("fr-CH", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }) + " " + prev.date.toLocaleTimeString("fr-CH", { hour: "2-digit", minute: "2-digit" });

    fullBody += `\n________________________________`;
    fullBody += `\nDe : ${prev.from_name} <${prev.from_email}>`;
    fullBody += `\nEnvoyé : ${dateStr}`;
    fullBody += `\nÀ : ${prev.to_name} <${prev.to_email}>`;
    fullBody += `\nObjet : ${prev.subject}`;
    fullBody += `\n\n${prev.body}`;
  }
  return fullBody;
}

// ─── Graph API ────────────────────────────────────────────────────────────────

async function injectEmail(email, topicThreadPrefix, emailIndexInThread) {
  const fromContact = contactByEmail(email.from_email);
  const toContact = contactByEmail(email.to_email);

  // Emails in the same thread get sequential dates (hours apart)
  const threadBaseDate = randomDate();
  const date = new Date(threadBaseDate.getTime() + emailIndexInThread * 3600000 * (1 + Math.random() * 12)); // 1-12h between replies

  const threadConversationId = `${topicThreadPrefix}-thread-${email.thread_id || 0}`;

  // Build full body with Outlook-style quoted previous messages
  const history = threadHistories.get(threadConversationId) || [];
  const fullBody = buildOutlookQuotedBody(email.body, history);

  // Store this message in thread history for future replies
  const fromName = fromContact?.name || email.from_email.split("@")[0];
  const toName = toContact?.name || email.to_email.split("@")[0];
  if (!threadHistories.has(threadConversationId)) {
    threadHistories.set(threadConversationId, []);
  }
  threadHistories.get(threadConversationId).push({
    from_name: fromName,
    from_email: email.from_email,
    to_name: toName,
    to_email: email.to_email,
    subject: email.subject,
    body: email.body, // store only the fresh body, not the quoted version
    date,
  });

  const graphMessage = {
    subject: email.subject,
    body: {
      contentType: "Text",
      content: fullBody,
    },
    from: {
      emailAddress: {
        name: fromContact?.name || email.from_email.split("@")[0],
        address: email.from_email,
      },
    },
    toRecipients: [
      {
        emailAddress: {
          name: toContact?.name || email.to_email.split("@")[0],
          address: email.to_email,
        },
      },
    ],
    receivedDateTime: date.toISOString(),
    sentDateTime: new Date(date.getTime() - 30000).toISOString(), // sent 30s before received
    isRead: Math.random() > 0.3, // 70% read
    isDraft: false,
    conversationId: threadConversationId,
  };

  // Step 1: Create the message (will be draft)
  const createResponse = await fetch("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GRAPH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(graphMessage),
  });

  if (!createResponse.ok) {
    const err = await createResponse.text();
    if (createResponse.status === 429) {
      console.warn("Rate limited, waiting 10s...");
      await sleep(10000);
      return injectEmail(email, topicThreadPrefix, emailIndexInThread); // retry
    }
    throw new Error(`Graph API error ${createResponse.status}: ${err}`);
  }

  const created = await createResponse.json();

  // Step 2: PATCH to mark as non-draft
  const patchResponse = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${created.id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${GRAPH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ isDraft: false }),
  });

  if (!patchResponse.ok) {
    // Non-fatal: email exists but is still draft
    console.warn(`    ⚠ Could not un-draft message ${created.id}`);
  }

  return created;
}

// ─── Calendar Events ──────────────────────────────────────────────────────────

const EVENTS = [
  // Upcoming meetings (next few days) — these are the ones we'll "prepare"
  {
    subject: "Revue avancement Projet GenAI EPFL 2026",
    body: "Points à aborder :\n1. Etat d'avancement du déploiement\n2. Budget Q2\n3. Choix du modèle LLM\n4. Timeline recrutement",
    daysFromNow: 2,
    durationMinutes: 60,
    location: "BC 410",
    participants: ["martin.rajman@epfl.ch", "antoine.bosselut@epfl.ch", "marc.vollenweider@epfl.ch", "claire.dupont@epfl.ch"],
  },
  {
    subject: "Point thèse Claire Dupont",
    body: "Revue trimestrielle de l'avancement de thèse.\n- Publications en cours\n- Planning soutenance\n- Prochaines étapes",
    daysFromNow: 3,
    durationMinutes: 45,
    location: "INJ 218",
    participants: ["robert.west@epfl.ch", "claire.dupont@epfl.ch", "francois.fleuret@epfl.ch"],
  },
  {
    subject: "NLP Lab Weekly Meeting",
    body: "Weekly lab meeting. Chacun présente son avancement de la semaine.",
    daysFromNow: 1,
    durationMinutes: 60,
    location: "BC 329",
    participants: ["antoine.bosselut@epfl.ch", "alexandre.morin@epfl.ch", "marco.bianchi@epfl.ch", "sophie.chen@epfl.ch"],
  },
  {
    subject: "Kickoff Projet Européen Horizon",
    body: "Première réunion du consortium. Présentation des workpackages et répartition des tâches.",
    daysFromNow: 5,
    durationMinutes: 120,
    location: "Réunion Microsoft Teams",
    participants: ["boi.faltings@epfl.ch", "karl.aberer@epfl.ch", "anna.schmidt@ethz.ch", "l.benedetti@polimi.it"],
  },
  {
    subject: "Workshop IA et Éducation - Comité d'organisation",
    body: "Finaliser le programme, confirmer les intervenants, logistique salles.",
    daysFromNow: 4,
    durationMinutes: 90,
    location: "CM 1 120",
    participants: ["sabine.susstrunk@epfl.ch", "pierre-andre.mudry@epfl.ch", "isabelle.ducrey@epfl.ch", "jc.martin@unige.ch"],
  },
  {
    subject: "Budget Lab 2026-2027 - Arbitrage final",
    body: "Valider les dernières demandes de matériel et voyages conférences.",
    daysFromNow: 6,
    durationMinutes: 45,
    location: "INJ 114",
    participants: ["martin.rajman@epfl.ch", "sandra.roux@epfl.ch", "christine.bentley@epfl.ch"],
  },
  {
    subject: "Collaboration Google DeepMind - Status Update",
    body: "Monthly sync. Review progress on joint research, discuss data sharing, plan next experiments.",
    daysFromNow: 7,
    durationMinutes: 60,
    location: "Réunion Microsoft Teams",
    participants: ["antoine.bosselut@epfl.ch", "m.garcia@google.com", "priya.sharma@epfl.ch", "fatima.zahra@epfl.ch"],
  },
  {
    subject: "Entretiens PostDoc Computer Vision",
    body: "Entretiens avec les 3 candidats shortlistés pour le poste de PostDoc.",
    daysFromNow: 3,
    durationMinutes: 180,
    location: "BC 350",
    participants: ["pascal.fua@epfl.ch", "mathieu.salzmann@epfl.ch", "mehdi.benali@epfl.ch", "nathalie.fontana@epfl.ch"],
  },
  // Past meetings (for testing recurrence / past context)
  {
    subject: "Revue avancement Projet GenAI EPFL 2026",
    body: "Points à aborder :\n1. Résultats tests utilisateurs\n2. Retours beta testeurs\n3. Planning déploiement",
    daysFromNow: -14,
    durationMinutes: 60,
    location: "BC 410",
    participants: ["martin.rajman@epfl.ch", "antoine.bosselut@epfl.ch", "marc.vollenweider@epfl.ch", "claire.dupont@epfl.ch"],
  },
  {
    subject: "NLP Lab Weekly Meeting",
    body: "Weekly lab meeting.",
    daysFromNow: -7,
    durationMinutes: 60,
    location: "BC 329",
    participants: ["antoine.bosselut@epfl.ch", "alexandre.morin@epfl.ch", "marco.bianchi@epfl.ch", "sophie.chen@epfl.ch"],
  },
  {
    subject: "Collaboration Google DeepMind - Status Update",
    body: "Monthly sync. Review January results.",
    daysFromNow: -30,
    durationMinutes: 60,
    location: "Réunion Microsoft Teams",
    participants: ["antoine.bosselut@epfl.ch", "m.garcia@google.com", "priya.sharma@epfl.ch", "fatima.zahra@epfl.ch"],
  },
  {
    subject: "Visite délégation MIT - Préparation",
    body: "Préparer le programme de la visite, répartir les présentations.",
    daysFromNow: -21,
    durationMinutes: 60,
    location: "BC 410",
    participants: ["philippe.gillet@epfl.ch", "j.wilson@mit.edu", "sabine.susstrunk@epfl.ch", "isabelle.ducrey@epfl.ch"],
  },
];

async function createCalendarEvent(event) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() + event.daysFromNow);
  startDate.setHours(10, 0, 0, 0); // 10:00 AM

  const endDate = new Date(startDate.getTime() + event.durationMinutes * 60000);

  const attendees = event.participants.map((email) => {
    const c = contactByEmail(email);
    return {
      emailAddress: {
        address: email,
        name: c?.name || email.split("@")[0],
      },
      type: "required",
    };
  });

  const graphEvent = {
    subject: event.subject,
    body: {
      contentType: "Text",
      content: event.body,
    },
    start: {
      dateTime: startDate.toISOString().replace("Z", ""),
      timeZone: "Europe/Zurich",
    },
    end: {
      dateTime: endDate.toISOString().replace("Z", ""),
      timeZone: "Europe/Zurich",
    },
    location: {
      displayName: event.location,
    },
    attendees,
    isReminderOn: false,
    responseRequested: false,
  };

  const response = await fetch("https://graph.microsoft.com/v1.0/me/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GRAPH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(graphEvent),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Graph API error ${response.status}: ${err}`);
  }

  return response.json();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Step 1: Create calendar events
  console.log(`\n📅 Creating ${EVENTS.length} calendar events...\n`);
  let eventsCreated = 0;
  for (const event of EVENTS) {
    try {
      await createCalendarEvent(event);
      const when = event.daysFromNow >= 0 ? `in ${event.daysFromNow} days` : `${-event.daysFromNow} days ago`;
      console.log(`  ✓ ${event.subject} (${when}, ${event.participants.length} participants)`);
      eventsCreated++;
    } catch (e) {
      console.error(`  ✗ ${event.subject}: ${e.message.slice(0, 100)}`);
    }
    await sleep(GRAPH_DELAY_MS);
  }
  console.log(`\n  → ${eventsCreated}/${EVENTS.length} events created`);

  // Step 2: Generate and inject emails
  console.log(`\n🎯 Generating ${TOTAL_EMAILS} test emails across ${TOPICS.length} topics\n`);

  const emailsPerTopic = Math.ceil(TOTAL_EMAILS / TOPICS.length);
  let totalInjected = 0;
  let totalFailed = 0;

  for (const topic of TOPICS) {
    const batchCount = Math.ceil(emailsPerTopic / BATCH_SIZE);
    console.log(`\n📧 Topic: ${topic.name} (${emailsPerTopic} emails, ${batchCount} batches)`);

    const topicThreadPrefix = `${topic.name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`;

    for (let b = 0; b < batchCount; b++) {
      const remaining = emailsPerTopic - b * BATCH_SIZE;
      const count = Math.min(BATCH_SIZE, remaining);

      // Generate
      process.stdout.write(`  Batch ${b + 1}/${batchCount}: generating ${count} emails... `);
      let emails;
      try {
        emails = await generateEmailBatch(topic, topic.participants, count);
        console.log(`got ${emails.length}`);
      } catch (e) {
        console.error(`FAILED: ${e.message}`);
        totalFailed += count;
        continue;
      }

      // Sort by thread_id to inject in order (replies after originals)
      emails.sort((a, b) => (a.thread_id || 0) - (b.thread_id || 0));

      // Track index within each thread for sequential dating
      const threadCounters = {};

      // Inject in parallel batches
      for (let i = 0; i < emails.length; i += GRAPH_BATCH_SIZE) {
        const batch = emails.slice(i, i + GRAPH_BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map((email) => {
            const tid = email.thread_id || 0;
            threadCounters[tid] = (threadCounters[tid] || 0) + 1;
            return injectEmail(email, topicThreadPrefix, threadCounters[tid] - 1);
          })
        );

        for (const r of results) {
          if (r.status === "fulfilled") {
            totalInjected++;
          } else {
            totalFailed++;
            console.error(`    ❌ ${r.reason?.message?.slice(0, 100)}`);
          }
        }

        if (i + GRAPH_BATCH_SIZE < emails.length) {
          await sleep(GRAPH_DELAY_MS);
        }
      }

      process.stdout.write(`  → Injected: ${totalInjected} total (${totalFailed} failed)\n`);

      // Stop if we've hit the target
      if (totalInjected >= TOTAL_EMAILS) break;
    }

    if (totalInjected >= TOTAL_EMAILS) break;
  }

  console.log(`\n✅ Done! ${totalInjected} emails injected, ${totalFailed} failed.\n`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
