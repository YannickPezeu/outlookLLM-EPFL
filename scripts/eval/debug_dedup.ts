import { cleanEmailBody } from "../../src/services/cleanEmailBody";
const Database = require("better-sqlite3");
const db = new Database("data/mock-mailbox-large.sqlite", { readonly: true });

// Find conversations where dedup failed: 2 emails, both kept
// These are conversations where neither email's cleanBody appears in the other's full body
const convRows = db.prepare(`
  SELECT conversation_id, COUNT(*) as c
  FROM messages
  GROUP BY conversation_id
  HAVING c = 2
`).all() as Array<{ conversation_id: string; c: number }>;

let checked = 0;
let shown = 0;

for (const conv of convRows) {
  if (shown >= 5) break;

  const emails = db.prepare(
    "SELECT id, subject, body_content, received_date_time FROM messages WHERE conversation_id = ? ORDER BY received_date_time"
  ).all(conv.conversation_id) as Array<{ id: string; subject: string; body_content: string; received_date_time: string }>;

  if (emails.length !== 2) continue;

  const [e1, e2] = emails;
  const clean1 = cleanEmailBody(e1.body_content);
  const clean2 = cleanEmailBody(e2.body_content);
  const snippet1 = clean1.slice(0, 100).trim();
  const snippet2 = clean2.slice(0, 100).trim();

  // Check both directions
  const e1InE2 = e2.body_content.includes(snippet1.slice(0, 50));
  const e2InE1 = e1.body_content.includes(snippet2.slice(0, 50));

  if (e1InE2 || e2InE1) continue; // dedup would work, skip

  // This is a FAILED dedup case
  shown++;
  console.log("═".repeat(80));
  console.log(`FAILED DEDUP: ${e1.subject.slice(0, 70)}`);
  console.log("");

  console.log(`Email 1 [${e1.received_date_time.slice(0, 16)}]:`);
  console.log(`  body length: ${e1.body_content.length}, cleanBody: ${clean1.length}`);
  console.log(`  snippet: ${JSON.stringify(snippet1)}`);
  console.log(`  cleanBody:\n${clean1.slice(0, 400)}`);
  console.log("");

  console.log(`Email 2 [${e2.received_date_time.slice(0, 16)}]:`);
  console.log(`  body length: ${e2.body_content.length}, cleanBody: ${clean2.length}`);
  console.log(`  snippet: ${JSON.stringify(snippet2)}`);
  console.log(`  cleanBody:\n${clean2.slice(0, 400)}`);
  console.log("");

  // What does email2 look like after the separator?
  const sep = e2.body_content.indexOf("________________________________");
  if (sep > 0) {
    console.log(`Email 2 has separator at char ${sep}. After separator:`);
    console.log(e2.body_content.slice(sep, sep + 300));
  } else {
    console.log("Email 2 has NO separator (not a reply with quoted content)");
    console.log("Email 2 full body (first 500):");
    console.log(e2.body_content.slice(0, 500));
  }
  console.log("");

  // Same for email1
  const sep1 = e1.body_content.indexOf("________________________________");
  if (sep1 > 0) {
    console.log(`Email 1 has separator at char ${sep1}. After separator:`);
    console.log(e1.body_content.slice(sep1, sep1 + 300));
  } else {
    console.log("Email 1 has NO separator");
  }
  console.log("");
}

console.log(`Checked ${convRows.length} 2-email conversations, showed ${shown} failed cases`);
db.close();
