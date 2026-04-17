/**
 * Test cleanEmailBody on real exported emails.
 *
 * Usage:
 *   npx tsx scripts/eval/test_clean_body_real.ts [--file path] [--limit N] [--replies-only] [--stats] [--show-full] [--deciles]
 */

import { cleanEmailBody } from "../../src/services/cleanEmailBody";

interface Email {
  id: string;
  subject: string;
  body?: { contentType: string; content: string };
  bodyPreview?: string;
  receivedDateTime?: string;
}

function getArg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const filePath = getArg("file", "data/emails-export-500.json");
const limit = parseInt(getArg("limit", "500"), 10);
const repliesOnly = hasFlag("replies-only");
const statsOnly = hasFlag("stats");
const showFull = hasFlag("show-full");
const showDeciles = hasFlag("deciles");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const emails: Email[] = require(`../../${filePath}`);

const toProcess = emails
  .filter((e) => e.body?.content && e.body.content.length > 50)
  .slice(0, limit);

// ─── Process ───────────────────────────────────────────────────────

interface Result {
  subject: string;
  originalLen: number;
  cleanedLen: number;
  reductionPct: number;
  contentType: string;
  hadChain: boolean;
}

const results: Result[] = [];

for (const email of toProcess) {
  const original = email.body!.content;
  const cleaned = cleanEmailBody(original);
  const reductionPct = (1 - cleaned.length / original.length) * 100;
  const hadChain = reductionPct > 5;

  if (repliesOnly && !hadChain) continue;

  results.push({
    subject: email.subject || "(no subject)",
    originalLen: original.length,
    cleanedLen: cleaned.length,
    reductionPct,
    contentType: email.body!.contentType,
    hadChain,
  });

  if (!statsOnly) {
    console.log("═".repeat(80));
    console.log(`Subject: ${email.subject}`);
    console.log(`Type: ${email.body!.contentType} | Original: ${original.length} → Cleaned: ${cleaned.length} (${reductionPct.toFixed(1)}% reduction)`);
    console.log(`Had reply chain: ${hadChain ? "YES" : "no"}`);

    console.log("\n--- ORIGINAL (first 1000 chars) ---");
    console.log(showFull ? original : original.slice(0, 1000));
    if (!showFull && original.length > 1000) console.log(`\n... [${original.length - 1000} more chars]`);

    console.log("\n--- CLEANED (first 1500 chars) ---");
    console.log(cleaned.slice(0, 1500));
    if (cleaned.length > 1500) console.log(`\n... [${cleaned.length - 1500} more chars]`);
    console.log("");
  }
}

// ─── Stats ─────────────────────────────────────────────────────────

const withChains = results.filter((r) => r.hadChain);

console.log("═".repeat(80));
console.log("STATS");
console.log(`Emails processed: ${results.length}`);
console.log(`Emails with reply chains: ${withChains.length}/${results.length}`);
console.log(`Total original chars: ${results.reduce((s, r) => s + r.originalLen, 0).toLocaleString()}`);
console.log(`Total cleaned chars: ${results.reduce((s, r) => s + r.cleanedLen, 0).toLocaleString()}`);
if (results.length > 0) {
  console.log(`Overall reduction: ${((1 - results.reduce((s, r) => s + r.cleanedLen, 0) / results.reduce((s, r) => s + r.originalLen, 0)) * 100).toFixed(1)}%`);
}
if (withChains.length > 0) {
  console.log(`Avg reduction (emails with chains): ${(withChains.reduce((s, r) => s + r.reductionPct, 0) / withChains.length).toFixed(1)}%`);
}

// ─── Deciles ───────────────────────────────────────────────────────

if (showDeciles) {
  console.log("\n--- Cleaned body length deciles ---");
  const sorted = results.map((r) => r.cleanedLen).sort((a, b) => a - b);
  for (let d = 0; d <= 10; d++) {
    const idx = Math.min(Math.floor((d / 10) * sorted.length), sorted.length - 1);
    console.log(`  ${(d * 10).toString().padStart(3)}%: ${sorted[idx].toLocaleString()} chars`);
  }
  console.log(`  Mean: ${Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length).toLocaleString()} chars`);

  console.log("\n--- Original body length deciles ---");
  const sortedOrig = results.map((r) => r.originalLen).sort((a, b) => a - b);
  for (let d = 0; d <= 10; d++) {
    const idx = Math.min(Math.floor((d / 10) * sortedOrig.length), sortedOrig.length - 1);
    console.log(`  ${(d * 10).toString().padStart(3)}%: ${sortedOrig[idx].toLocaleString()} chars`);
  }
  console.log(`  Mean: ${Math.round(sortedOrig.reduce((a, b) => a + b, 0) / sortedOrig.length).toLocaleString()} chars`);

  console.log("\n--- Reduction % deciles (emails with chains only) ---");
  if (withChains.length > 0) {
    const sortedRed = withChains.map((r) => r.reductionPct).sort((a, b) => a - b);
    for (let d = 0; d <= 10; d++) {
      const idx = Math.min(Math.floor((d / 10) * sortedRed.length), sortedRed.length - 1);
      console.log(`  ${(d * 10).toString().padStart(3)}%: ${sortedRed[idx].toFixed(1)}%`);
    }
  }
}
