/**
 * Collect rerank scores for emails and store in the DB table `email_event_scores`.
 *
 * For each event, takes the top N emails by embedding score (already in the DB),
 * sends them to bge-reranker-v2-m3 in batches of 50, and writes rerank_score.
 *
 * Resumes automatically: skips events that already have rerank scores.
 *
 * Usage:
 *   npx tsx scripts/eval/collect_rerank_scores.ts
 *   npx tsx scripts/eval/collect_rerank_scores.ts --topn 200
 */

import "./node_shims";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require("better-sqlite3");

import { rerank } from "../../src/services/rcpApiService";
import { cleanEmailBody } from "../../src/services/cleanEmailBody";

function getArg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const dbPath = getArg("db", "data/mock-mailbox-large.sqlite");
const topN = parseInt(getArg("topn", "500"), 10);

const db = new Database(dbPath);

// ─── Queries ─────────────────────────────────────────────────────────

const eventsStmt = db.prepare("SELECT DISTINCT event_id FROM email_event_scores ORDER BY event_id");
const eventInfoStmt = db.prepare("SELECT subject, body_content FROM calendar_events WHERE id = ?");
const topEmailsStmt = db.prepare(`
  SELECT ees.email_id, ees.embedding_score, m.subject, m.body_content
  FROM email_event_scores ees
  JOIN messages m ON m.id = ees.email_id
  WHERE ees.event_id = ?
  ORDER BY ees.embedding_score DESC
  LIMIT ?
`);
const updateStmt = db.prepare("UPDATE email_event_scores SET rerank_score = ? WHERE email_id = ? AND event_id = ?");
const countRerankStmt = db.prepare("SELECT COUNT(*) as c FROM email_event_scores WHERE event_id = ? AND rerank_score IS NOT NULL");

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const events = eventsStmt.all() as Array<{ event_id: string }>;

  console.log("═".repeat(70));
  console.log(`Collecting rerank scores: ${events.length} events, top ${topN} per event`);
  console.log(`Total batches estimate: ${events.length * Math.ceil(topN / 50)} (${Math.ceil(topN / 50)} per event)`);
  console.log("═".repeat(70));
  console.log("");

  let totalScored = 0;
  let totalFails = 0;

  for (let i = 0; i < events.length; i++) {
    const eventId = events[i].event_id;

    // Skip if already done
    const existing = countRerankStmt.get(eventId) as { c: number };
    if (existing.c >= topN * 0.9) {
      console.log(`[${i + 1}/${events.length}] SKIP (${existing.c} already scored)`);
      continue;
    }

    const eventInfo = eventInfoStmt.get(eventId) as { subject: string; body_content: string };
    const query = [eventInfo.subject, eventInfo.body_content ? cleanEmailBody(eventInfo.body_content) : ""].filter(Boolean).join(" ");

    const emails = topEmailsStmt.all(eventId, topN) as Array<{
      email_id: string;
      embedding_score: number;
      subject: string;
      body_content: string;
    }>;

    console.log(`[${i + 1}/${events.length}] ${eventInfo.subject} — ${emails.length} emails`);

    const startTime = Date.now();
    let scored = 0;
    let fails = 0;
    const totalBatches = Math.ceil(emails.length / 50);

    for (let b = 0; b < emails.length; b += 50) {
      const batch = emails.slice(b, b + 50);
      const documents = batch.map((e) => `${e.subject}\n${e.body_content ? cleanEmailBody(e.body_content) : ""}`);

      try {
        const res = await rerank(query, documents);

        const update = db.transaction(() => {
          for (const r of res) {
            updateStmt.run(r.score, batch[r.index].email_id, eventId);
          }
        });
        update();

        scored += res.length;
      } catch (err) {
        fails++;
        const msg = err instanceof Error ? err.message.slice(0, 80) : String(err);
        console.log(`    batch ${Math.floor(b / 50) + 1} FAILED: ${msg}`);
      }

      const batchNum = Math.floor(b / 50) + 1;
      if (batchNum % 3 === 0 || batchNum === totalBatches) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(`    ${batchNum}/${totalBatches} batches — ${scored} scored, ${fails} fails (${elapsed}s)`);
      }
    }

    totalScored += scored;
    totalFails += fails;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`    Done: ${scored}/${emails.length} in ${elapsed}s\n`);
  }

  // Summary
  console.log("═".repeat(70));
  const total = db.prepare("SELECT COUNT(*) as c FROM email_event_scores WHERE rerank_score IS NOT NULL").get() as { c: number };
  console.log(`Total rerank scores in DB: ${total.c.toLocaleString()}`);
  console.log(`This run: ${totalScored.toLocaleString()} scored, ${totalFails} failures`);
  console.log("═".repeat(70));

  db.close();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
