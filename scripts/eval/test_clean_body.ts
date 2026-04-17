/**
 * Test script for cleanEmailBody function.
 *
 * Reads emails from the mock SQLite database, runs them through cleanEmailBody,
 * and outputs before/after comparisons for manual inspection.
 *
 * Usage:
 *   npx tsx scripts/eval/test_clean_body.ts [--db path] [--limit N] [--id EMAIL_ID] [--replies-only] [--show-full]
 *
 * Options:
 *   --db          Path to SQLite database (default: data/mock-mailbox-large.sqlite)
 *   --limit N     Number of emails to process (default: 20)
 *   --id ID       Process a specific email by ID
 *   --replies-only Only show emails that have reply chains (Re: in subject)
 *   --show-full   Show the full original body (not truncated)
 *   --stats       Show aggregate stats only (no individual emails)
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require("better-sqlite3");

import { cleanEmailBody } from "../../src/services/cleanEmailBody";

// ─── Parse CLI args ────────────────────────────────────────────────

function getArg(name: string, defaultValue: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : defaultValue;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const dbPath = getArg("db", "data/mock-mailbox-large.sqlite");
const limit = parseInt(getArg("limit", "20"), 10);
const specificId = getArg("id", "");
const repliesOnly = hasFlag("replies-only");
const showFull = hasFlag("show-full");
const statsOnly = hasFlag("stats");

// ─── Main ──────────────────────────────────────────────────────────

interface Row {
  id: string;
  subject: string;
  body_content: string;
  body_content_type: string;
  body_preview: string;
  conversation_id: string;
}

const db = new Database(dbPath, { readonly: true });

let rows: Row[];

if (specificId) {
  rows = db.prepare("SELECT id, subject, body_content, body_content_type, body_preview, conversation_id FROM messages WHERE id = ?").all(specificId) as Row[];
} else {
  const whereClause = repliesOnly ? "WHERE subject LIKE 'Re:%' AND length(body_content) > 500" : "WHERE body_content IS NOT NULL AND length(body_content) > 100";
  rows = db.prepare(`SELECT id, subject, body_content, body_content_type, body_preview, conversation_id FROM messages ${whereClause} ORDER BY RANDOM() LIMIT ?`).all(limit) as Row[];
}

// ─── Process and display ───────────────────────────────────────────

let totalOriginal = 0;
let totalCleaned = 0;
let totalWithReplyChain = 0;
let totalReductionPercent = 0;

for (const row of rows) {
  const original = row.body_content;
  const cleaned = cleanEmailBody(original);

  totalOriginal += original.length;
  totalCleaned += cleaned.length;

  const hadReplyChain = cleaned.length < original.length * 0.95; // >5% reduction = had reply chain
  if (hadReplyChain) totalWithReplyChain++;

  const reductionPct = ((1 - cleaned.length / original.length) * 100).toFixed(1);
  if (hadReplyChain) totalReductionPercent += parseFloat(reductionPct);

  if (!statsOnly) {
    console.log("═".repeat(80));
    console.log(`ID: ${row.id}`);
    console.log(`Subject: ${row.subject}`);
    console.log(`Original: ${original.length} chars → Cleaned: ${cleaned.length} chars (${reductionPct}% reduction)`);
    console.log(`Had reply chain: ${hadReplyChain ? "YES" : "no"}`);

    console.log("\n--- ORIGINAL (first 1500 chars) ---");
    console.log(showFull ? original : original.slice(0, 1500));
    if (!showFull && original.length > 1500) console.log(`\n... [${original.length - 1500} more chars]`);

    console.log("\n--- CLEANED ---");
    console.log(cleaned);
    console.log("");
  }
}

// ─── Stats ─────────────────────────────────────────────────────────

console.log("═".repeat(80));
console.log("STATS");
console.log(`Emails processed: ${rows.length}`);
console.log(`Emails with reply chains detected: ${totalWithReplyChain}/${rows.length} (${((totalWithReplyChain / rows.length) * 100).toFixed(0)}%)`);
console.log(`Total original chars: ${totalOriginal.toLocaleString()}`);
console.log(`Total cleaned chars: ${totalCleaned.toLocaleString()}`);
console.log(`Overall reduction: ${((1 - totalCleaned / totalOriginal) * 100).toFixed(1)}%`);
if (totalWithReplyChain > 0) {
  console.log(`Avg reduction (emails with chains): ${(totalReductionPercent / totalWithReplyChain).toFixed(1)}%`);
}

db.close();
