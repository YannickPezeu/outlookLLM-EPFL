/**
 * Evaluate LLM-as-filter: use Gemma E2B to score top-N emails per event.
 *
 * Pipeline: embedding top-N → Gemma E2B scoring → keep >= threshold → measure P@7/R@7
 *
 * Compares batch sizes (30, 50, 100) and thresholds (5, 6, 7).
 *
 * Usage:
 *   npx tsx scripts/eval/eval_llm_filter.ts
 *   npx tsx scripts/eval/eval_llm_filter.ts --topn 100 --batch 30 --limit 5
 */

import "./node_shims";
import { cleanEmailBody } from "../../src/services/cleanEmailBody";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require("better-sqlite3");

function getArg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const dbPath = getArg("db", "data/mock-mailbox-large.sqlite");
const topN = parseInt(getArg("topn", "200"), 10);
const batchSizes = getArg("batches", "30").split(",").map(Number);
const limit = parseInt(getArg("limit", "0"), 10);
const model = getArg("model", "google/gemma-4-E2B-it-bfloat16");

const db = new Database(dbPath, { readonly: true });

// RCP API config
const rcpUrl = process.env.RCP_API_ENDPOINT || "https://inference.rcp.epfl.ch/v1";
const rcpKey = process.env.RCP_API_KEY;
if (!rcpKey) {
  console.error("ERROR: RCP_API_KEY not set in .env");
  process.exit(1);
}

// ─── Types ───────────────────────────────────────────────────────────

interface Email {
  emailId: string;
  embeddingScore: number;
  subject: string;
  bodyPreview: string;
  cleanBody: string;
  projectId: string | null;
  relevance: number;
}

interface EventData {
  eventId: string;
  subject: string;
  eventProjectId: string | null;
  eventBody: string;
  participants: string;
  eventDate: string;
  emails: Email[];
  totalImp7: number;
  totalImp8: number;
}

// ─── Load events ─────────────────────────────────────────────────────

const getEventProjectStmt = db.prepare(`
  SELECT pp.project_id
  FROM calendar_events ce, json_each(ce.attendees_json) je, project_participants pp
  WHERE json_extract(je.value, '$.emailAddress.address') = pp.participant_email
    AND ce.id = ?
  GROUP BY pp.project_id
  ORDER BY COUNT(*) DESC
  LIMIT 1
`);

const eventRows = db.prepare("SELECT DISTINCT event_id FROM email_event_scores ORDER BY event_id").all() as Array<{ event_id: string }>;
const events: EventData[] = [];

for (const { event_id } of eventRows) {
  const info = db.prepare("SELECT subject, body_preview, start_date_time, attendees_json FROM calendar_events WHERE id = ?")
    .get(event_id) as { subject: string; body_preview: string; start_date_time: string; attendees_json: string };

  const projectRow = getEventProjectStmt.get(event_id) as { project_id: string } | undefined;
  const eventProjectId = projectRow?.project_id || null;

  const attendees = JSON.parse(info.attendees_json || "[]") as Array<{ emailAddress?: { name: string } }>;
  const participants = attendees.map((a) => a.emailAddress?.name || "").filter(Boolean).join(", ");

  const rows = db.prepare(`
    SELECT ees.email_id, ees.embedding_score, m.subject, m.body_preview, m.body_content,
           m.project_id, COALESCE(m.relevance_score, 0) as relevance
    FROM email_event_scores ees
    JOIN messages m ON m.id = ees.email_id
    WHERE ees.event_id = ?
      AND m.received_date_time < ?
    ORDER BY ees.embedding_score DESC
    LIMIT ?
  `).all(event_id, info.start_date_time, topN) as Array<{
    email_id: string; embedding_score: number; subject: string; body_preview: string;
    body_content: string; project_id: string | null; relevance: number;
  }>;

  const emails: Email[] = rows.map((r) => ({
    emailId: r.email_id,
    embeddingScore: r.embedding_score,
    subject: r.subject,
    bodyPreview: r.body_preview,
    cleanBody: r.body_content ? cleanEmailBody(r.body_content) : r.body_preview,
    projectId: r.project_id,
    relevance: r.relevance,
  }));

  const totalImp7 = emails.filter((e) => e.projectId === eventProjectId && e.relevance >= 7).length;
  const totalImp8 = emails.filter((e) => e.projectId === eventProjectId && e.relevance >= 8).length;

  events.push({
    eventId: event_id, subject: info.subject, eventProjectId,
    eventBody: info.body_preview || "", participants,
    eventDate: info.start_date_time,
    emails, totalImp7, totalImp8,
  });
}

let evalEvents = events;
if (limit > 0) evalEvents = events.slice(0, limit);
console.log(`Loaded ${evalEvents.length} events, top ${topN} emails each, model: ${model}\n`);

// ─── LLM call ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Bonjour, je te demande ton aide d'expert pour filtrer des emails avant une réunion.

CONTEXTE : On prépare un briefing pour une réunion. Tu vas recevoir des emails échangés avec les participants. Tu dois noter chaque email selon sa valeur informative pour préparer cette réunion.

CRITÈRE : L'email contient-il de l'information exploitable pour rédiger un briefing utile ?

Échelle :
- 9-10 : Indispensable. Décisions, résultats, problèmes critiques, livrables.
  Ex: "Les tests montrent une réduction de 40% de latence. Je recommande la prod."
  Ex: "Le budget est réduit de 30%. Il faut couper le module NLP ou reporter."
- 7-8 : Très utile. Avancées concrètes, engagements, questions ouvertes.
  Ex: "L'intégration du module multilingue avance. Résultats FR/DE prometteurs."
  Ex: "Le partenariat Milano est confirmé. 3 datasets d'ici fin mars."
- 5-6 : Contexte secondaire. Logistique, coordination avec un peu d'info.
  Ex: "Salle BC 410 réservée pour la démo du 20 mars."
  Ex: "Budget GPU restant : 12'000 CHF. Arbitrage nécessaire."
- 3-4 : Faible valeur. Accusés de réception, relances sans contenu.
  Ex: "OK pour mardi, je serai là."
  Ex: "Bien reçu, on en parle jeudi."
- 1-2 : Quasi inutile. Email générique ou sans info.
- 0 : Aucun rapport avec la réunion ni ses participants.

IMPORTANT : Un email qui dit juste "on se voit mardi pour en discuter" = 3, pas 7. Seul le CONTENU informatif compte.

Réponds UNIQUEMENT en JSON : [{"index":0,"score":7},{"index":1,"score":3}, ...]`;

function buildUserPrompt(event: EventData, batch: Email[]): string {
  const emailsStr = batch
    .map((e, i) => `[${i}] Sujet: ${e.subject}\n${e.cleanBody}`)
    .join("\n\n---\n\n");

  return `## Réunion
Sujet : ${event.subject}
Date : ${event.eventDate.slice(0, 10)}
Participants : ${event.participants}
Description : ${event.eventBody.slice(0, 500) || "(aucune)"}

## Emails à noter

${emailsStr}

Note chaque email de 0 à 10.`;
}

async function callLLM(systemPrompt: string, userPrompt: string, maxRetries = 3): Promise<string> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const resp = await fetch(`${rcpUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${rcpKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.1,
          max_tokens: 4096,
        }),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        if (resp.status === 429 || resp.status === 503) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        throw new Error(`RCP error ${resp.status}: ${txt.slice(0, 300)}`);
      }
      const json = await resp.json() as { choices: Array<{ message: { content: string } }> };
      return json.choices[0]?.message?.content || "";
    } catch (err) {
      if (attempt === maxRetries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error("Max retries");
}

function parseScores(text: string, expectedCount: number): Map<number, number> {
  const scores = new Map<number, number>();
  try {
    let clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const match = clean.match(/\[[\s\S]*\]/);
    if (!match) return scores;
    const arr = JSON.parse(match[0]) as Array<{ index: number; score: number }>;
    for (const s of arr) {
      if (typeof s.index === "number" && typeof s.score === "number" && s.index >= 0 && s.index < expectedCount) {
        scores.set(s.index, Math.max(0, Math.min(10, s.score)));
      }
    }
  } catch { /* parse error — return partial */ }
  return scores;
}

// ─── Evaluate one config ─────────────────────────────────────────────

interface ConfigResult {
  batchSize: number;
  threshold: number;
  avgN: number;
  avgP7: number;
  avgR7: number;
  avgP8: number;
  avgR8: number;
  avgNoise: number;
  avgTimeMs: number;
  parseFailRate: number;
}

async function evaluateConfig(batchSize: number): Promise<{ scores: Map<string, Map<string, number>>; avgTimeMs: number; parseFailRate: number }> {
  const allScores = new Map<string, Map<string, number>>(); // eventId → emailId → llmScore
  let totalTimeMs = 0;
  let totalBatches = 0;
  let parseFails = 0;

  for (let ei = 0; ei < evalEvents.length; ei++) {
    const event = evalEvents[ei];
    const eventScores = new Map<string, number>();
    const startTime = Date.now();

    for (let i = 0; i < event.emails.length; i += batchSize) {
      const batch = event.emails.slice(i, i + batchSize);

      const scoreBatch = async (subBatch: Email[], maxBodyChars = 3000) => {
        // Cap cleanBody to avoid context overflow on giant newsletter emails
        const cappedBatch = subBatch.map((e) => ({ ...e, cleanBody: e.cleanBody.slice(0, maxBodyChars) }));
        const prompt = buildUserPrompt(event, cappedBatch);
        const response = await callLLM(SYSTEM_PROMPT, prompt);
        const scores = parseScores(response, subBatch.length);
        for (const [idx, score] of scores) {
          eventScores.set(subBatch[idx].emailId, score);
        }
        return scores.size;
      };

      try {
        // Try full batch
        const scored = await scoreBatch(batch);
        if (scored < batch.length * 0.5) parseFails++;
      } catch (err) {
        const isContextError = /context length|too long|too many tokens/i.test(
          err instanceof Error ? err.message : String(err)
        );
        if (!isContextError) {
          parseFails++;
          console.warn(`    Batch failed (non-context): ${err instanceof Error ? err.message.slice(0, 100) : err}`);
        } else {
          // Fallback: split into sub-batches of 10
          console.log(`    Context overflow on ${batch.length} emails, falling back to batches of 10...`);
          for (let j = 0; j < batch.length; j += 10) {
            const subBatch = batch.slice(j, j + 10);
            try {
              await scoreBatch(subBatch);
            } catch (err2) {
              // Final fallback: one by one
              console.log(`    Sub-batch of 10 failed, falling back to 1-by-1...`);
              for (let k = 0; k < subBatch.length; k++) {
                try {
                  await scoreBatch([subBatch[k]]);
                } catch {
                  parseFails++;
                }
              }
            }
          }
        }
      }
      totalBatches++;
    }

    const elapsed = Date.now() - startTime;
    totalTimeMs += elapsed;
    allScores.set(event.eventId, eventScores);

    console.log(`  [${ei + 1}/${evalEvents.length}] ${event.subject.slice(0, 50)} — ${eventScores.size}/${event.emails.length} scored (${(elapsed / 1000).toFixed(1)}s)`);
  }

  return {
    scores: allScores,
    avgTimeMs: totalTimeMs / evalEvents.length,
    parseFailRate: totalBatches > 0 ? parseFails / totalBatches : 0,
  };
}

function computeMetrics(
  scores: Map<string, Map<string, number>>,
  threshold: number
): { avgN: number; avgP7: number; avgR7: number; avgP8: number; avgR8: number; avgNoise: number } {
  const perEvent: Array<{ n: number; p7: number; r7: number; p8: number; r8: number; noise: number }> = [];

  for (const event of evalEvents) {
    const eventScores = scores.get(event.eventId);
    if (!eventScores) continue;

    const selected = event.emails.filter((e) => (eventScores.get(e.emailId) ?? 0) >= threshold);
    let imp7 = 0, imp8 = 0, noise = 0;
    for (const e of selected) {
      if (e.projectId === event.eventProjectId && e.relevance >= 7) imp7++;
      if (e.projectId === event.eventProjectId && e.relevance >= 8) imp8++;
      if (e.relevance === 0) noise++;
    }

    perEvent.push({
      n: selected.length,
      p7: selected.length > 0 ? imp7 / selected.length : 0,
      r7: event.totalImp7 > 0 ? imp7 / event.totalImp7 : 0,
      p8: selected.length > 0 ? imp8 / selected.length : 0,
      r8: event.totalImp8 > 0 ? imp8 / event.totalImp8 : 0,
      noise: selected.length > 0 ? noise / selected.length : 0,
    });
  }

  const n = perEvent.length;
  return {
    avgN: perEvent.reduce((s, m) => s + m.n, 0) / n,
    avgP7: perEvent.reduce((s, m) => s + m.p7, 0) / n,
    avgR7: perEvent.reduce((s, m) => s + m.r7, 0) / n,
    avgP8: perEvent.reduce((s, m) => s + m.p8, 0) / n,
    avgR8: perEvent.reduce((s, m) => s + m.r8, 0) / n,
    avgNoise: perEvent.reduce((s, m) => s + m.noise, 0) / n,
  };
}

// ─── Main ────────────────────────────────────────────────────────────

(async () => {
  const thresholds = [5, 6, 7];
  const allResults: ConfigResult[] = [];

  for (const bs of batchSizes) {
    console.log(`\n${"═".repeat(80)}`);
    console.log(`BATCH SIZE = ${bs} (${Math.ceil(topN / bs)} batches per event)`);
    console.log("═".repeat(80));

    const { scores, avgTimeMs, parseFailRate } = await evaluateConfig(bs);

    for (const thr of thresholds) {
      const m = computeMetrics(scores, thr);
      allResults.push({
        batchSize: bs,
        threshold: thr,
        ...m,
        avgTimeMs,
        parseFailRate,
      });
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────

  console.log(`\n${"═".repeat(100)}`);
  console.log(`SUMMARY — LLM filter (${model}) on top ${topN} by embedding`);
  console.log("═".repeat(100));
  console.log(`${"config".padEnd(20)}${"n".padEnd(7)}${"P@7".padEnd(9)}${"R@7".padEnd(9)}${"P@8".padEnd(9)}${"R@8".padEnd(9)}${"noise%".padEnd(9)}${"time/evt".padEnd(10)}${"parseFail"}`);
  console.log("─".repeat(100));

  // Embedding baseline (no LLM filter)
  const embBaseline = computeMetrics(
    new Map(evalEvents.map((e) => [e.eventId, new Map(e.emails.map((em) => [em.emailId, 10]))])),
    0
  );
  console.log(
    `${"emb_top" + topN + " (no filter)".padEnd(20)}` +
    `${topN.toString().padEnd(7)}` +
    `${(embBaseline.avgP7 * 100).toFixed(1).padStart(5)}%   ` +
    `${(embBaseline.avgR7 * 100).toFixed(1).padStart(5)}%   ` +
    `${(embBaseline.avgP8 * 100).toFixed(1).padStart(5)}%   ` +
    `${(embBaseline.avgR8 * 100).toFixed(1).padStart(5)}%   ` +
    `${(embBaseline.avgNoise * 100).toFixed(0).padStart(3)}%      ` +
    `${"0s".padEnd(10)}` +
    "n/a"
  );
  console.log("─".repeat(100));

  for (const r of allResults) {
    console.log(
      `${"bs" + r.batchSize + "_thr" + r.threshold}`.padEnd(20) +
      `${r.avgN.toFixed(0).padEnd(7)}` +
      `${(r.avgP7 * 100).toFixed(1).padStart(5)}%   ` +
      `${(r.avgR7 * 100).toFixed(1).padStart(5)}%   ` +
      `${(r.avgP8 * 100).toFixed(1).padStart(5)}%   ` +
      `${(r.avgR8 * 100).toFixed(1).padStart(5)}%   ` +
      `${(r.avgNoise * 100).toFixed(0).padStart(3)}%      ` +
      `${(r.avgTimeMs / 1000).toFixed(1) + "s"}`.padEnd(10) +
      `${(r.parseFailRate * 100).toFixed(0)}%`
    );
  }
  console.log("═".repeat(100));

  db.close();
})();
