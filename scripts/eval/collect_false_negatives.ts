/**
 * Collect ~15 false negatives across multiple events and dump to JSON for review.
 * False negative = Gemma < 7 but ground truth >= 7 for the event's project.
 */

import "./node_shims";
import { cleanEmailBody } from "../../src/services/cleanEmailBody";
import * as fs from "fs";

const Database = require("better-sqlite3");
const db = new Database("data/mock-mailbox-large.sqlite", { readonly: true });

const rcpUrl = process.env.RCP_API_ENDPOINT || "https://inference.rcp.epfl.ch/v1";
const rcpKey = process.env.RCP_API_KEY!;
const model = "google/gemma-4-E2B-it-bfloat16";

const SYSTEM_PROMPT = `Bonjour, je te demande ton aide d'expert pour filtrer des emails avant une réunion.

CONTEXTE : Les participants à cette réunion travaillent sur PLUSIEURS projets différents. Tu vas recevoir des emails échangés avec ces participants — certains concernent DIRECTEMENT la réunion, d'autres concernent leurs AUTRES projets et ne sont PAS pertinents.

CRITÈRE PRINCIPAL : L'email parle-t-il SPÉCIFIQUEMENT du sujet de cette réunion ? Un email sur un autre sujet, même envoyé par un participant, doit recevoir un score bas.

Échelle :
- 9-10 : Indispensable. Directement lié au sujet de la réunion. Décisions, résultats, problèmes critiques.
- 7-8 : Très utile. Avancées concrètes sur le sujet de la réunion.
- 5-6 : Lien indirect. Mentionne le sujet mais surtout de la logistique.
- 3-4 : Autre sujet mais même participants. Réunion différente, projet différent.
- 1-2 : Sans rapport avec la réunion. Autre projet des mêmes personnes.
- 0 : Spam ou totalement hors sujet.

IMPORTANT : Ne te laisse pas tromper par le fait qu'un email mentionne des mots-clés similaires. Si c'est pour UN AUTRE PROJET que celui de la réunion, score 2-4 maximum.

Réponds UNIQUEMENT en JSON : [{"index":0,"score":7},{"index":1,"score":3}, ...]`;

const getEventProjectStmt = db.prepare(`
  SELECT pp.project_id FROM calendar_events ce, json_each(ce.attendees_json) je, project_participants pp
  WHERE json_extract(je.value, '$.emailAddress.address') = pp.participant_email AND ce.id = ?
  GROUP BY pp.project_id ORDER BY COUNT(*) DESC LIMIT 1
`);

async function callLLM(prompt: string): Promise<string> {
  const resp = await fetch(`${rcpUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${rcpKey}` },
    body: JSON.stringify({ model, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }], temperature: 0.1, max_tokens: 4096 }),
  });
  const json = await resp.json() as any;
  return json.choices?.[0]?.message?.content || "";
}

// Get all events
const allEvents = db.prepare("SELECT id, subject, body_preview, body_content, start_date_time, attendees_json FROM calendar_events ORDER BY start_date_time").all() as any[];

interface FalseNegative {
  eventSubject: string;
  eventDescription: string;
  eventParticipants: string;
  eventProjectId: string;
  emailSubject: string;
  emailFrom: string;
  emailDate: string;
  emailCleanBody: string;
  gemmaScore: number;
  groundTruth: number;
}

const falseNegatives: FalseNegative[] = [];

(async () => {
  for (let ei = 0; ei < allEvents.length && falseNegatives.length < 15; ei++) {
    const event = allEvents[ei];
    const eventProjectId = (getEventProjectStmt.get(event.id) as any)?.project_id;
    if (!eventProjectId) continue;

    const attendees = JSON.parse(event.attendees_json || "[]");
    const participants = attendees.map((a: any) => a.emailAddress?.name || "").filter(Boolean).join(", ");
    const eventBody = event.body_content ? cleanEmailBody(event.body_content) : event.body_preview || "";

    // Get top 200 pre-event emails
    const rows = db.prepare(`
      SELECT ees.email_id, m.subject, m.body_content, m.body_preview, m.from_name, m.received_date_time,
             m.project_id, COALESCE(m.relevance_score, 0) as relevance
      FROM email_event_scores ees JOIN messages m ON m.id = ees.email_id
      WHERE ees.event_id = ? AND m.received_date_time < ?
      ORDER BY ees.embedding_score DESC LIMIT 200
    `).all(event.id, event.start_date_time) as any[];

    // Only process if there are important emails from this project
    const projectImportant = rows.filter((r: any) => r.project_id === eventProjectId && r.relevance >= 7);
    if (projectImportant.length < 2) continue;

    // Score with Gemma
    const gemmaScores = new Map<string, number>();
    for (let i = 0; i < rows.length; i += 30) {
      const batch = rows.slice(i, i + 30);
      const emailsStr = batch.map((e: any, idx: number) => {
        const clean = e.body_content ? cleanEmailBody(e.body_content).slice(0, 3000) : e.body_preview;
        return `[${idx}] Sujet: ${e.subject}\n${clean}`;
      }).join("\n\n---\n\n");
      const prompt = `## Réunion\nSujet : ${event.subject}\nParticipants : ${participants}\n\n## Emails à noter\n\n${emailsStr}\n\nNote chaque email de 0 à 10.`;
      try {
        const text = await callLLM(prompt);
        const match = text.match(/\[[\s\S]*\]/);
        if (match) {
          const arr = JSON.parse(match[0]) as Array<{ index: number; score: number }>;
          for (const s of arr) {
            if (typeof s.index === "number" && s.index >= 0 && s.index < batch.length)
              gemmaScores.set(batch[s.index].email_id, s.score);
          }
        }
      } catch { /* skip */ }
    }

    // Find false negatives
    let foundInEvent = 0;
    for (const r of rows) {
      if (r.project_id !== eventProjectId || r.relevance < 7) continue;
      const gs = gemmaScores.get(r.email_id);
      if (gs === undefined || gs >= 7) continue;

      const clean = r.body_content ? cleanEmailBody(r.body_content) : r.body_preview;
      falseNegatives.push({
        eventSubject: event.subject,
        eventDescription: eventBody.slice(0, 500),
        eventParticipants: participants,
        eventProjectId,
        emailSubject: r.subject,
        emailFrom: r.from_name,
        emailDate: r.received_date_time,
        emailCleanBody: clean,
        gemmaScore: gs,
        groundTruth: r.relevance,
      });
      foundInEvent++;
    }

    console.log(`[${ei + 1}/${allEvents.length}] ${event.subject.slice(0, 50)} — ${foundInEvent} false negatives (total: ${falseNegatives.length})`);
  }

  fs.writeFileSync("data/false_negatives_examples.json", JSON.stringify(falseNegatives, null, 2));
  console.log(`\nSaved ${falseNegatives.length} false negatives to data/false_negatives_examples.json`);

  db.close();
})();
