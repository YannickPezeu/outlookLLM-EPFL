/**
 * Collect embedding similarity scores for all emails across all events,
 * tagging each score with whether the email belongs to the event's project.
 *
 * Output: JSON file with per-event score distributions for visualization.
 *
 * Usage:
 *   npx tsx scripts/eval/collect_scores.ts --db data/mock-mailbox-large.sqlite
 *   npx tsx scripts/eval/collect_scores.ts --db data/mock-mailbox-large.sqlite --limit 5 -v
 */

import { rcpUrl, rcpKey } from "./node_shims";

import * as fs from "fs";
import { SqliteMailDataSource } from "../../src/services/sqliteMailDataSource";
import { batchEmbed, rankBySimilarity } from "../../src/services/embeddingService";
import { cleanEmailBody } from "../../src/services/cleanEmailBody";
import type { LightEmail } from "../../src/services/mailTypes";

// ─── Conversation dedup ──────────────────────────────────────────────

function computeRedundantIds(ds: SqliteMailDataSource): Set<string> {
  const dbRef = (ds as any).db;
  const convRows = dbRef.prepare(
    "SELECT conversation_id FROM messages GROUP BY conversation_id HAVING COUNT(*) > 1"
  ).all() as Array<{ conversation_id: string }>;

  const redundant = new Set<string>();

  for (const { conversation_id } of convRows) {
    const emails = dbRef.prepare(
      "SELECT id, body_content FROM messages WHERE conversation_id = ? ORDER BY received_date_time"
    ).all(conversation_id) as Array<{ id: string; body_content: string }>;

    for (let i = 0; i < emails.length; i++) {
      const snippet = cleanEmailBody(emails[i].body_content).slice(0, 100).trim();
      if (snippet.length < 20) continue;

      for (let j = 0; j < emails.length; j++) {
        if (i === j) continue;
        if (emails[j].body_content.length <= emails[i].body_content.length * 0.8) continue;
        if (emails[j].body_content.includes(snippet)) {
          redundant.add(emails[i].id);
          break;
        }
      }
    }
  }

  return redundant;
}

// ── CLI args ────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let dbPath = "data/mock-mailbox-large.sqlite";
  let limit: number | undefined;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db" && args[i + 1]) dbPath = args[++i];
    else if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[++i], 10);
    else if (args[i] === "-v" || args[i] === "--verbose") verbose = true;
  }

  return { dbPath, limit, verbose };
}

// ── Types ───────────────────────────────────────────────────────────

interface EmailScore {
  emailId: string;
  subject: string;
  score: number;
  projectId: string | null;
  isRelevant: boolean;
  // Per-event metadata for offline sweep simulation:
  participantEmail: string;     // which participant's collection produced this email
  direction: "received" | "sent"; // received from participant, or sent to participant
  receivedDateTime: string;
}

interface EventScores {
  eventId: string;
  meetingSubject: string;
  expectedProjectId: string | null;
  query: string;
  participantCount: number;
  totalEmails: number;
  relevantCount: number;
  irrelevantCount: number;
  scores: EmailScore[];
}

// ── Main ────────────────────────────────────────────────────────────

async function collectForEvent(
  ds: SqliteMailDataSource,
  eventId: string,
  verbose: boolean,
  redundantIds: Set<string>
): Promise<EventScores> {
  const event = await ds.getCalendarEvent(eventId);
  const expectedProjectId = ds.getEventProjectId(eventId);

  const participants = (event.attendees || [])
    .filter((a) => a.type !== "resource")
    .map((a) => ({
      name: a.emailAddress.name || a.emailAddress.address,
      email: a.emailAddress.address.toLowerCase(),
    }));

  // Use cleanEmailBody on event body for consistency with the actual pipeline
  const eventBody = event.body?.content ? cleanEmailBody(event.body.content) : event.bodyPreview;
  const query = [event.subject, eventBody].filter(Boolean).join(" ");

  if (verbose) {
    console.log(`  Query: "${query.slice(0, 80)}..."`);
    console.log(`  Expected project: ${expectedProjectId}`);
    console.log(`  Participants: ${participants.length}`);
  }

  // Collect all emails for all participants. We dedupe globally (same as pipeline Phase 2)
  // but tag each email with the FIRST participant whose collection found it, plus direction.
  const allEmails: Array<{ email: LightEmail; participantEmail: string; direction: "received" | "sent" }> = [];
  const seenIds = new Set<string>();

  for (const p of participants) {
    const emails = await ds.collectEmailsWithParticipant(p.email);
    for (const email of emails) {
      if (!seenIds.has(email.id)) {
        seenIds.add(email.id);
        const direction: "received" | "sent" =
          email.from?.emailAddress?.address?.toLowerCase() === p.email.toLowerCase()
            ? "received"
            : "sent";
        allEmails.push({ email, participantEmail: p.email, direction });
      }
    }
  }

  // Filter out redundant conversation emails
  const beforeDedup = allEmails.length;
  const filtered = allEmails.filter(({ email }) => !redundantIds.has(email.id));
  const dedupRemoved = beforeDedup - filtered.length;

  if (filtered.length === 0) {
    return {
      eventId,
      meetingSubject: event.subject,
      expectedProjectId,
      query,
      participantCount: participants.length,
      totalEmails: 0,
      relevantCount: 0,
      irrelevantCount: 0,
      scores: [],
    };
  }

  if (verbose) {
    console.log(`  Emails collected: ${beforeDedup} → ${filtered.length} after dedup (-${dedupRemoved})`);
    console.log(`  Embedding...`);
  }

  // Embed query + all emails using subject + bodyPreview (no cleanBody for embedding)
  const emailTexts = filtered.map(({ email }) => `${email.subject} ${email.bodyPreview}`);
  const allTexts = [query, ...emailTexts];
  const embeddings = await batchEmbed(allTexts);
  const queryEmbedding = embeddings[0];
  const emailEmbeddings = embeddings.slice(1);

  // Rank by cosine similarity
  const ranked = rankBySimilarity(queryEmbedding, emailEmbeddings);

  // Build scored list with ground truth
  const scores: EmailScore[] = ranked.map(({ index, score }) => {
    const item = filtered[index];
    const emailProjectId = ds.getEmailProjectId(item.email.id);
    return {
      emailId: item.email.id,
      subject: item.email.subject,
      score,
      projectId: emailProjectId,
      isRelevant: emailProjectId === expectedProjectId && expectedProjectId !== null,
      participantEmail: item.participantEmail,
      direction: item.direction,
      receivedDateTime: item.email.receivedDateTime,
    };
  });

  const relevantCount = scores.filter((s) => s.isRelevant).length;
  const irrelevantCount = scores.length - relevantCount;

  if (verbose) {
    console.log(`  Relevant: ${relevantCount}, Irrelevant: ${irrelevantCount}`);
    console.log(`  Top 5 scores: ${scores.slice(0, 5).map((s) => `${s.score.toFixed(3)}${s.isRelevant ? "✓" : "✗"}`).join(", ")}`);
  }

  return {
    eventId,
    meetingSubject: event.subject,
    expectedProjectId,
    query,
    participantCount: participants.length,
    totalEmails: allEmails.length,
    relevantCount,
    irrelevantCount,
    scores,
  };
}

async function main() {
  const { dbPath, limit, verbose } = parseArgs();

  console.log(`\n=== Embedding Score Collection ===`);
  console.log(`Database: ${dbPath}`);
  console.log(`RCP API: ${rcpUrl}\n`);

  if (!rcpKey) {
    console.error("ERROR: RCP_API_KEY not set. Add it to .env");
    process.exit(1);
  }

  const ds = new SqliteMailDataSource(dbPath);

  console.log("Computing conversation dedup...");
  const redundantIds = computeRedundantIds(ds);
  console.log(`${redundantIds.size} redundant emails will be skipped\n`);

  const events = ds.listCalendarEvents();
  let eventIds = events.map((e) => e.id);
  if (limit) eventIds = eventIds.slice(0, limit);

  console.log(`Processing ${eventIds.length} events...\n`);

  const allResults: EventScores[] = [];

  for (let i = 0; i < eventIds.length; i++) {
    console.log(`[${i + 1}/${eventIds.length}] Processing...`);
    try {
      const result = await collectForEvent(ds, eventIds[i], verbose, redundantIds);
      allResults.push(result);
      console.log(
        `  ${result.meetingSubject} — ` +
        `${result.totalEmails} emails, ${result.relevantCount} relevant, ` +
        `project: ${result.expectedProjectId || "N/A"}`
      );
    } catch (err: any) {
      console.error(`  ERROR: ${err.message}`);
      if (verbose) console.error(err.stack);
    }
  }

  // Save results to JSON (legacy)
  const outPath = dbPath.replace(".sqlite", "-embedding-scores-full.json");
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));
  console.log(`\nScores saved to: ${outPath}`);

  // Also update DB table email_event_scores
  console.log("Updating email_event_scores in DB...");
  const dbWrite = require("better-sqlite3")(dbPath);
  dbWrite.exec(`CREATE TABLE IF NOT EXISTS email_event_scores (
    email_id TEXT NOT NULL, event_id TEXT NOT NULL, embedding_score REAL, rerank_score REAL,
    PRIMARY KEY (email_id, event_id)
  )`);
  const upsert = dbWrite.prepare("INSERT OR REPLACE INTO email_event_scores (email_id, event_id, embedding_score) VALUES (?, ?, ?)");
  const insertAll = dbWrite.transaction(() => {
    let count = 0;
    for (const ev of allResults) {
      for (const s of ev.scores) {
        upsert.run(s.emailId, ev.eventId, s.score);
        count++;
      }
    }
    return count;
  });
  const dbCount = insertAll();
  dbWrite.close();
  console.log(`Updated ${dbCount} rows in email_event_scores`);

  // Quick aggregate stats
  const withProject = allResults.filter((r) => r.expectedProjectId);
  if (withProject.length > 0) {
    const allRelevantScores = withProject.flatMap((r) => r.scores.filter((s) => s.isRelevant).map((s) => s.score));
    const allIrrelevantScores = withProject.flatMap((r) => r.scores.filter((s) => !s.isRelevant).map((s) => s.score));

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const median = (arr: number[]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    console.log(`\n--- Aggregate Stats (${withProject.length} events with ground truth) ---`);
    console.log(`Relevant scores:   n=${allRelevantScores.length}, avg=${avg(allRelevantScores).toFixed(4)}, median=${median(allRelevantScores).toFixed(4)}`);
    console.log(`Irrelevant scores:  n=${allIrrelevantScores.length}, avg=${avg(allIrrelevantScores).toFixed(4)}, median=${median(allIrrelevantScores).toFixed(4)}`);
  }

  ds.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
