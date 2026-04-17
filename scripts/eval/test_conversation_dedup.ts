/**
 * Test conversation deduplication: for each thread, check if the latest reply
 * contains the older emails' content, and remove redundant ones.
 *
 * Logic:
 * 1. Group emails by conversation_id
 * 2. Sort by date DESC (latest first)
 * 3. For each older email, check if first 100 chars of its cleanBody appear
 *    (fuzzy) in the latest email's FULL body (before cleaning)
 * 4. If found → redundant (skip for embedding)
 * 5. If not → keep
 *
 * Usage:
 *   npx tsx scripts/eval/test_conversation_dedup.ts
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require("better-sqlite3");

import { cleanEmailBody } from "../../src/services/cleanEmailBody";
import { distance } from "fastest-levenshtein";

const db = new Database("data/mock-mailbox-large.sqlite", { readonly: true });

interface Email {
  id: string;
  subject: string;
  body_content: string;
  received_date_time: string;
  conversation_id: string;
  project_id: string | null;
}

// Load all multi-email conversations
const conversations = new Map<string, Email[]>();

const rows = db.prepare(`
  SELECT m.id, m.subject, m.body_content, m.received_date_time, m.conversation_id, m.project_id
  FROM messages m
  WHERE m.conversation_id IN (
    SELECT conversation_id FROM messages GROUP BY conversation_id HAVING COUNT(*) > 1
  )
  ORDER BY m.conversation_id, m.received_date_time DESC
`).all() as Email[];

for (const r of rows) {
  if (!conversations.has(r.conversation_id)) conversations.set(r.conversation_id, []);
  conversations.get(r.conversation_id)!.push(r);
}

console.log(`Multi-email conversations: ${conversations.size}`);
console.log(`Emails in conversations: ${rows.length}`);

// ─── Fuzzy containment check ─────────────────────────────────────────

function fuzzyContains(haystack: string, needle: string, maxDistance = 10): boolean {
  if (needle.length < 20) return false;
  // Try exact match first (fast, works for plain text)
  if (haystack.includes(needle)) return true;
  // Fallback: fuzzy sliding window (for HTML where formatting differs slightly)
  const nLen = needle.length;
  for (let i = 0; i <= haystack.length - nLen; i += 5) {
    const window = haystack.slice(i, i + nLen);
    const dist = distance(needle, window);
    if (dist <= maxDistance) return true;
  }
  return false;
}

// ─── Process conversations ───────────────────────────────────────────

let totalEmails = 0;
let redundant = 0;
let kept = 0;
let latestKept = 0;

const examples: Array<{
  conversationId: string;
  subject: string;
  total: number;
  keptCount: number;
  redundantCount: number;
  details: string[];
}> = [];

for (const [convId, emails] of conversations) {
  // For each email, check if its cleanBody is contained in ANY other (longer) email's full body
  const redundantIds = new Set<string>();
  const details: string[] = [];

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    const emailClean = cleanEmailBody(email.body_content);
    const snippet = emailClean.slice(0, 100).trim();

    if (snippet.length < 20) continue; // too short to match

    // Check against all OTHER emails in the thread
    let foundIn: string | null = null;
    for (let j = 0; j < emails.length; j++) {
      if (i === j) continue;
      const other = emails[j];
      // Only check against emails with longer body (likely contains quotes)
      if (other.body_content.length <= email.body_content.length * 0.8) continue;

      if (fuzzyContains(other.body_content, snippet)) {
        foundIn = other.id;
        break;
      }
    }

    if (foundIn) {
      redundantIds.add(email.id);
      details.push(`  REDUNDANT: ${email.subject.slice(0, 50)} [${email.received_date_time.slice(0, 10)}] (${emailClean.length} chars) — found in ${foundIn.slice(0, 8)}...`);
    } else {
      details.push(`  KEEP: ${email.subject.slice(0, 50)} [${email.received_date_time.slice(0, 10)}] (${emailClean.length} chars)`);
    }
  }

  const keptCount = emails.length - redundantIds.size;
  totalEmails += emails.length;
  redundant += redundantIds.size;
  kept += keptCount;

  if (examples.length < 10) {
    examples.push({
      conversationId: convId.slice(0, 20),
      subject: emails[0].subject.slice(0, 60),
      total: emails.length,
      keptCount,
      redundantCount: redundantIds.size,
      details,
    });
  }
}

// Also count single-email conversations
const singleCount = db.prepare("SELECT COUNT(*) as c FROM (SELECT conversation_id FROM messages GROUP BY conversation_id HAVING COUNT(*) = 1)").get() as { c: number };

console.log("\n═".repeat(70));
console.log("RESULTS");
console.log("═".repeat(70));
console.log(`Conversations with >1 email: ${conversations.size}`);
console.log(`Emails in those conversations: ${totalEmails}`);
console.log(`  Kept (latest or unique content): ${kept}`);
console.log(`  Redundant (contained in latest): ${redundant}`);
console.log(`  Redundancy rate: ${(redundant / totalEmails * 100).toFixed(1)}%`);
console.log(`\nSingle-email conversations: ${singleCount.c}`);
console.log(`\nTotal for embedding BEFORE dedup: ${singleCount.c + totalEmails}`);
console.log(`Total for embedding AFTER dedup: ${singleCount.c + kept}`);
console.log(`Reduction: ${redundant} emails removed (${(redundant / (singleCount.c + totalEmails) * 100).toFixed(1)}%)`);

console.log("\n═".repeat(70));
console.log("EXAMPLES (first 10 conversations)");
console.log("═".repeat(70));
for (const ex of examples) {
  console.log(`\n[${ex.subject}] — ${ex.total} emails → ${ex.keptCount} kept, ${ex.redundantCount} redundant`);
  for (const d of ex.details) console.log(`  ${d}`);
}

db.close();
