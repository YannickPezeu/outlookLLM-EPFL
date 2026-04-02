/**
 * Evaluation script: runs the meeting prep pipeline against the SQLite mock DB
 * and measures precision/recall using ground-truth project_id tags.
 *
 * Usage:
 *   npx tsx scripts/eval/run_pipeline.ts --db data/mock-mailbox-large.sqlite
 *   npx tsx scripts/eval/run_pipeline.ts --db data/mock-mailbox-large.sqlite --event <eventId>
 *   npx tsx scripts/eval/run_pipeline.ts --db data/mock-mailbox-large.sqlite --limit 3 -v
 *
 * This script imports the SAME meetingPrepService code used by the add-in,
 * but injects SqliteMailDataSource instead of GraphMailDataSource.
 */

// Shims MUST be imported first (sets up window, localStorage, .env)
import { rcpUrl, rcpKey } from "./node_shims";

import * as fs from "fs";
import { SqliteMailDataSource } from "../../src/services/sqliteMailDataSource";
import { prepareMeeting, PipelineProgress } from "../../src/services/meetingPrepService";

// ── CLI args ────────────────────────────────────────────────────────

function parseArgs(): { dbPath: string; eventId?: string; verbose: boolean; limit?: number } {
  const args = process.argv.slice(2);
  let dbPath = "data/mock-mailbox-large.sqlite";
  let eventId: string | undefined;
  let verbose = false;
  let limit: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db" && args[i + 1]) dbPath = args[++i];
    else if (args[i] === "--event" && args[i + 1]) eventId = args[++i];
    else if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[++i], 10);
    else if (args[i] === "--verbose" || args[i] === "-v") verbose = true;
  }

  return { dbPath, eventId, verbose, limit };
}

// ── Evaluation metrics ──────────────────────────────────────────────

interface EvalResult {
  eventId: string;
  meetingSubject: string;
  projectId: string | null;
  participantCount: number;
  totalEmailsCollected: number;
  emailsSelected: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
}

function computeMetrics(
  selectedIds: string[],
  ds: SqliteMailDataSource,
  expectedProjectId: string | null
): { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number } {
  if (!expectedProjectId) {
    return { tp: 0, fp: 0, fn: 0, precision: 0, recall: 0, f1: 0 };
  }

  let tp = 0;
  let fp = 0;

  for (const id of selectedIds) {
    const pid = ds.getEmailProjectId(id);
    if (pid === expectedProjectId) {
      tp++;
    } else {
      fp++;
    }
  }

  // Count total relevant emails in the DB for this project
  const totalRelevant = (ds as any).db
    .prepare("SELECT COUNT(*) as c FROM messages WHERE project_id = ?")
    .get(expectedProjectId).c as number;

  const fn = totalRelevant - tp;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = totalRelevant > 0 ? tp / totalRelevant : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { tp, fp, fn, precision, recall, f1 };
}

// ── Main ────────────────────────────────────────────────────────────

async function evaluateEvent(
  ds: SqliteMailDataSource,
  eventId: string,
  verbose: boolean
): Promise<EvalResult> {
  const expectedProjectId = ds.getEventProjectId(eventId);

  let totalCollected = 0;
  const selectedEmailIds: string[] = [];

  const result = await prepareMeeting(
    ds,
    eventId,
    (prog: PipelineProgress) => {
      if (verbose) {
        console.log(`  [${prog.phase}] ${prog.percent}% -- ${prog.message}`);
      }
      const match = prog.message.match(/(\d+) emails collectés/);
      if (match) totalCollected = parseInt(match[1], 10);
    },
    (_chunk: string) => {
      // Discard streaming text for eval
    }
  );

  for (const b of result.participantBriefings) {
    selectedEmailIds.push(...b.relevantEmailIds);
  }

  const metrics = computeMetrics(selectedEmailIds, ds, expectedProjectId);

  return {
    eventId,
    meetingSubject: result.event.subject,
    projectId: expectedProjectId,
    participantCount: result.participants.length,
    totalEmailsCollected: totalCollected,
    emailsSelected: selectedEmailIds.length,
    truePositives: metrics.tp,
    falsePositives: metrics.fp,
    falseNegatives: metrics.fn,
    precision: metrics.precision,
    recall: metrics.recall,
    f1: metrics.f1,
  };
}

async function main() {
  const { dbPath, eventId, verbose, limit } = parseArgs();

  console.log(`\n=== Meeting Prep Pipeline Evaluation ===`);
  console.log(`Database: ${dbPath}`);
  console.log(`RCP API: ${rcpUrl}\n`);

  if (!rcpKey) {
    console.error("ERROR: RCP_API_KEY not set. Add it to .env or set the environment variable.");
    process.exit(1);
  }

  const ds = new SqliteMailDataSource(dbPath);

  let eventIds: string[];
  if (eventId) {
    eventIds = [eventId];
  } else {
    const events = ds.listCalendarEvents();
    eventIds = events.map((e) => e.id);
    if (limit) eventIds = eventIds.slice(0, limit);
    console.log(`Found ${eventIds.length} calendar events to evaluate.\n`);
  }

  const results: EvalResult[] = [];

  for (let i = 0; i < eventIds.length; i++) {
    const eid = eventIds[i];
    console.log(`\n--- [${i + 1}/${eventIds.length}] ---`);

    try {
      const result = await evaluateEvent(ds, eid, verbose);
      results.push(result);

      console.log(`  Meeting:      ${result.meetingSubject}`);
      console.log(`  Project:      ${result.projectId}`);
      console.log(`  Participants: ${result.participantCount}`);
      console.log(`  Emails selected: ${result.emailsSelected}`);
      console.log(
        `  Precision: ${(result.precision * 100).toFixed(1)}%  ` +
          `Recall: ${(result.recall * 100).toFixed(1)}%  ` +
          `F1: ${(result.f1 * 100).toFixed(1)}%`
      );
      console.log(
        `  TP: ${result.truePositives}  FP: ${result.falsePositives}  FN: ${result.falseNegatives}`
      );
    } catch (err: any) {
      console.error(`  ERROR: ${err.message}`);
      if (verbose) console.error(err.stack);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────
  if (results.length > 0) {
    const avgPrecision = results.reduce((s, r) => s + r.precision, 0) / results.length;
    const avgRecall = results.reduce((s, r) => s + r.recall, 0) / results.length;
    const avgF1 = results.reduce((s, r) => s + r.f1, 0) / results.length;

    console.log(`\n${"=".repeat(60)}`);
    console.log(`SUMMARY (${results.length} meetings evaluated)`);
    console.log(`${"=".repeat(60)}`);
    console.log(`  Avg Precision: ${(avgPrecision * 100).toFixed(1)}%`);
    console.log(`  Avg Recall:    ${(avgRecall * 100).toFixed(1)}%`);
    console.log(`  Avg F1:        ${(avgF1 * 100).toFixed(1)}%`);

    // Save detailed results to JSON
    const outPath = dbPath.replace(".sqlite", "-eval-results.json");
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`\nDetailed results saved to: ${outPath}`);
  }

  ds.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
