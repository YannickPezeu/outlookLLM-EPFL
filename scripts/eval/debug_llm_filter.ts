/**
 * Debug: compare Gemma E2B scores vs ground truth for one event.
 * Shows false positives (Gemma says important but ground truth disagrees)
 * and false negatives (Gemma says unimportant but ground truth disagrees).
 */

import "./node_shims";
import { cleanEmailBody } from "../../src/services/cleanEmailBody";

const Database = require("better-sqlite3");
const db = new Database("data/mock-mailbox-large.sqlite", { readonly: true });

const rcpUrl = process.env.RCP_API_ENDPOINT || "https://inference.rcp.epfl.ch/v1";
const rcpKey = process.env.RCP_API_KEY!;
const model = "google/gemma-4-E2B-it-bfloat16";

// Pick first event
const eventId = db.prepare("SELECT DISTINCT event_id FROM email_event_scores LIMIT 1").get().event_id;
const eventInfo = db.prepare("SELECT subject, body_preview, start_date_time, attendees_json FROM calendar_events WHERE id = ?").get(eventId) as any;

const getEventProjectStmt = db.prepare(`
  SELECT pp.project_id FROM calendar_events ce, json_each(ce.attendees_json) je, project_participants pp
  WHERE json_extract(je.value, '$.emailAddress.address') = pp.participant_email AND ce.id = ?
  GROUP BY pp.project_id ORDER BY COUNT(*) DESC LIMIT 1
`);
const eventProjectId = (getEventProjectStmt.get(eventId) as any)?.project_id;

console.log(`Event: ${eventInfo.subject}`);
console.log(`Project: ${eventProjectId}\n`);

// Get top 200 emails with ground truth
const rows = db.prepare(`
  SELECT ees.email_id, ees.embedding_score, m.subject, m.body_content, m.body_preview,
         m.project_id, COALESCE(m.relevance_score, 0) as relevance, m.from_name, m.received_date_time
  FROM email_event_scores ees
  JOIN messages m ON m.id = ees.email_id
  WHERE ees.event_id = ? AND m.received_date_time < ?
  ORDER BY ees.embedding_score DESC LIMIT 200
`).all(eventId, eventInfo.start_date_time) as any[];

// Call Gemma on batch of 30
const SYSTEM_PROMPT = `Bonjour, je te demande ton aide d'expert pour filtrer des emails.

CONTEXTE : On prépare une réunion. On a récupéré des emails échangés avec les participants. Tu dois noter chaque email de 0 à 10 selon sa valeur pour préparer un briefing de cette réunion.

CRITÈRE : L'email contient-il de l'information exploitable pour rédiger un briefing ?

Échelle :
- 9-10 : Indispensable. Décisions, résultats, problèmes critiques.
  Ex: "Les tests montrent une réduction de 40% de latence. Je recommande la prod."
  Ex: "Le budget est réduit de 30%. Il faut couper le module NLP ou reporter."
- 7-8 : Très utile. Avancées concrètes, engagements, questions ouvertes.
  Ex: "L'intégration du module multilingue avance. Résultats FR/DE prometteurs."
  Ex: "Le partenariat Milano est confirmé. 3 datasets d'ici fin mars."
- 5-6 : Contexte secondaire. Logistique, coordination informative.
  Ex: "Salle BC 410 réservée pour la démo du 20 mars."
  Ex: "Budget GPU restant : 12'000 CHF. Arbitrage nécessaire."
- 3-4 : Faible valeur. Accusés de réception, relances sans contenu.
  Ex: "OK pour mardi."
  Ex: "Bien reçu, on en parle jeudi."
- 1-2 : Quasi inutile.
- 0 : Aucun rapport.

Réponds UNIQUEMENT en JSON : [{"index":0,"score":7},{"index":1,"score":3}, ...]`;

const attendees = JSON.parse(eventInfo.attendees_json || "[]");
const participants = attendees.map((a: any) => a.emailAddress?.name || "").filter(Boolean).join(", ");

async function scoreBatch(batch: any[]): Promise<Map<number, number>> {
  const emailsStr = batch.map((e: any, i: number) => {
    const clean = e.body_content ? cleanEmailBody(e.body_content) : e.body_preview;
    return `[${i}] Sujet: ${e.subject}\n${clean}`;
  }).join("\n\n---\n\n");

  const userPrompt = `## Réunion\nSujet : ${eventInfo.subject}\nDate : ${eventInfo.start_date_time.slice(0, 10)}\nParticipants : ${participants}\n\n## Emails à noter\n\n${emailsStr}\n\nNote chaque email de 0 à 10.`;

  const resp = await fetch(`${rcpUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${rcpKey}` },
    body: JSON.stringify({ model, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userPrompt }], temperature: 0.1, max_tokens: 4096 }),
  });
  const json = await resp.json() as any;
  const text = json.choices?.[0]?.message?.content || "";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return new Map();
  const arr = JSON.parse(match[0]) as Array<{ index: number; score: number }>;
  const scores = new Map<number, number>();
  for (const s of arr) {
    if (typeof s.index === "number" && typeof s.score === "number") scores.set(s.index, s.score);
  }
  return scores;
}

(async () => {
  // Score first 60 emails (2 batches of 30) to have enough examples
  const gemmaScores = new Map<string, number>();

  for (let i = 0; i < Math.min(rows.length, 60); i += 30) {
    const batch = rows.slice(i, i + 30);
    console.log(`Scoring batch ${i / 30 + 1}...`);
    const scores = await scoreBatch(batch);
    for (const [idx, score] of scores) {
      gemmaScores.set(batch[idx].email_id, score);
    }
  }

  console.log(`\nScored ${gemmaScores.size} emails\n`);

  // Classify errors
  const falsePositives: any[] = []; // Gemma >= 7 but NOT this project (or low relevance)
  const falseNegatives: any[] = []; // Gemma < 7 but IS this project with high relevance
  const truePositives: any[] = [];
  const trueNegatives: any[] = [];

  for (const r of rows.slice(0, 60)) {
    const gemma = gemmaScores.get(r.email_id);
    if (gemma === undefined) continue;

    const isProjectEmail = r.project_id === eventProjectId;
    const isImportant = isProjectEmail && r.relevance >= 7;
    const gemmaImportant = gemma >= 7;

    const entry = {
      gemmaScore: gemma,
      groundTruth: r.relevance,
      isThisProject: isProjectEmail,
      projectId: r.project_id?.slice(0, 30) || "NOISE",
      subject: r.subject.slice(0, 70),
      from: r.from_name,
      cleanBody: (r.body_content ? cleanEmailBody(r.body_content) : r.body_preview).slice(0, 300),
    };

    if (gemmaImportant && !isImportant) falsePositives.push(entry);
    else if (!gemmaImportant && isImportant) falseNegatives.push(entry);
    else if (gemmaImportant && isImportant) truePositives.push(entry);
    else trueNegatives.push(entry);
  }

  console.log(`True Positives: ${truePositives.length}`);
  console.log(`True Negatives: ${trueNegatives.length}`);
  console.log(`False Positives: ${falsePositives.length} (Gemma says important, ground truth disagrees)`);
  console.log(`False Negatives: ${falseNegatives.length} (Gemma says not important, ground truth disagrees)`);

  console.log(`\n${"═".repeat(80)}`);
  console.log("FALSE POSITIVES — Gemma >= 7 but NOT important for this project");
  console.log("═".repeat(80));
  for (const e of falsePositives.slice(0, 10)) {
    console.log(`\n  Gemma: ${e.gemmaScore} | GT: ${e.groundTruth} | Project: ${e.projectId}`);
    console.log(`  From: ${e.from} | Subject: ${e.subject}`);
    console.log(`  Body: ${e.cleanBody}`);
  }

  console.log(`\n${"═".repeat(80)}`);
  console.log("FALSE NEGATIVES — Gemma < 7 but IS important for this project");
  console.log("═".repeat(80));
  for (const e of falseNegatives.slice(0, 10)) {
    console.log(`\n  Gemma: ${e.gemmaScore} | GT: ${e.groundTruth} | Project: ${e.projectId}`);
    console.log(`  From: ${e.from} | Subject: ${e.subject}`);
    console.log(`  Body: ${e.cleanBody}`);
  }

  console.log(`\n${"═".repeat(80)}`);
  console.log("TRUE POSITIVES — Both agree important (sample)");
  console.log("═".repeat(80));
  for (const e of truePositives.slice(0, 5)) {
    console.log(`\n  Gemma: ${e.gemmaScore} | GT: ${e.groundTruth} | Project: ${e.projectId}`);
    console.log(`  Subject: ${e.subject}`);
  }

  db.close();
})();
