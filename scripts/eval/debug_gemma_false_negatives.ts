/**
 * Debug: find emails that Gemma scored low but ground truth says important.
 * Run on a few events to see what's happening.
 */

import "./node_shims";
import { cleanEmailBody } from "../../src/services/cleanEmailBody";

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

// Pick 3 diverse events
const eventIds = db.prepare(`
  SELECT id, subject FROM calendar_events
  WHERE subject IN ('HPC Cluster Expansion - Infrastructure Planning', 'Student Wellbeing Program - Needs Assessment', 'Biomedical NLP - Literature Mining Pipeline')
`).all() as Array<{ id: string; subject: string }>;

async function callLLM(prompt: string): Promise<string> {
  const resp = await fetch(`${rcpUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${rcpKey}` },
    body: JSON.stringify({ model, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }], temperature: 0.1, max_tokens: 4096 }),
  });
  const json = await resp.json() as any;
  return json.choices?.[0]?.message?.content || "";
}

(async () => {
  for (const event of eventIds) {
    const eventProjectId = (getEventProjectStmt.get(event.id) as any)?.project_id;
    const eventInfo = db.prepare("SELECT body_preview, start_date_time, attendees_json FROM calendar_events WHERE id = ?").get(event.id) as any;
    const attendees = JSON.parse(eventInfo.attendees_json || "[]");
    const participants = attendees.map((a: any) => a.emailAddress?.name || "").filter(Boolean).join(", ");

    // Get top 200 by embedding, only pre-event
    const rows = db.prepare(`
      SELECT ees.email_id, ees.embedding_score, m.subject, m.body_content, m.body_preview,
             m.project_id, COALESCE(m.relevance_score, 0) as relevance, m.from_name
      FROM email_event_scores ees JOIN messages m ON m.id = ees.email_id
      WHERE ees.event_id = ? AND m.received_date_time < ?
      ORDER BY ees.embedding_score DESC LIMIT 200
    `).all(event.id, eventInfo.start_date_time) as any[];

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

    // Find false negatives: ground truth important (same project, rel>=7) but Gemma < 7
    console.log(`\n${"═".repeat(80)}`);
    console.log(`Event: ${event.subject} | Project: ${eventProjectId}`);
    console.log(`${"═".repeat(80)}`);

    const falseNegs: any[] = [];
    const truePos: any[] = [];

    for (const r of rows) {
      const gs = gemmaScores.get(r.email_id);
      if (gs === undefined) continue;
      if (r.project_id !== eventProjectId) continue;
      if (r.relevance < 7) continue;

      // This is a ground-truth important email for this project
      const clean = r.body_content ? cleanEmailBody(r.body_content) : r.body_preview;
      const entry = { gemma: gs, gt: r.relevance, subject: r.subject, from: r.from_name, cleanBody: clean.slice(0, 400) };

      if (gs < 7) falseNegs.push(entry);
      else truePos.push(entry);
    }

    console.log(`\nTrue positives: ${truePos.length} | False negatives: ${falseNegs.length}`);

    if (falseNegs.length > 0) {
      console.log(`\nFALSE NEGATIVES (Gemma < 7, but GT >= 7 for this project):`);
      for (const e of falseNegs.slice(0, 8)) {
        console.log(`\n  Gemma: ${e.gemma} | GT: ${e.gt}`);
        console.log(`  From: ${e.from} | Subject: ${e.subject}`);
        console.log(`  Body: ${e.cleanBody.slice(0, 250)}`);
      }
    } else {
      console.log("\nNo false negatives! Gemma caught all important emails.");
    }

    // Also show a couple true positives for comparison
    console.log(`\nTRUE POSITIVES sample:`);
    for (const e of truePos.slice(0, 3)) {
      console.log(`  Gemma: ${e.gemma} | GT: ${e.gt} | ${e.subject.slice(0, 60)}`);
    }
  }

  db.close();
})();
