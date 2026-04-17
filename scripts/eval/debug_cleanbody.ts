import { cleanEmailBody } from "../../src/services/cleanEmailBody";
import * as fs from "fs";
const Database = require("better-sqlite3");
const db = new Database("data/mock-mailbox-large.sqlite", { readonly: true });

// Top 30 longest body_content
const rows = db.prepare("SELECT id, subject, body_content FROM messages WHERE body_content IS NOT NULL ORDER BY length(body_content) DESC LIMIT 30").all() as any[];

const results = rows.map((r: any) => {
  const clean = cleanEmailBody(r.body_content);
  return {
    id: r.id,
    subject: r.subject.slice(0, 80),
    origLen: r.body_content.length,
    cleanLen: clean.length,
    cleanEstTokens: Math.ceil(clean.length / 3),
    cleanExcerpt: clean.slice(0, 300),
  };
});

fs.writeFileSync("data/cleanbody_debug.json", JSON.stringify(results, null, 2));
console.log("Top 30 written to data/cleanbody_debug.json");
console.log("Top 10 cleanBody lengths:", results.slice(0, 10).map(r => `${r.cleanLen} (${r.cleanEstTokens}tok)`).join(", "));

// Full distribution
const allRows = db.prepare("SELECT body_content FROM messages WHERE body_content IS NOT NULL").all() as any[];
let over8k = 0, over20k = 0, over40k = 0, over100k = 0;
for (const r of allRows) {
  const cl = cleanEmailBody(r.body_content).length;
  if (cl > 8000) over8k++;
  if (cl > 20000) over20k++;
  if (cl > 40000) over40k++;
  if (cl > 100000) over100k++;
}
console.log(`\nAll ${allRows.length} emails:`);
console.log(`  cleanBody > 8k chars: ${over8k}`);
console.log(`  cleanBody > 20k chars: ${over20k}`);
console.log(`  cleanBody > 40k chars: ${over40k}`);
console.log(`  cleanBody > 100k chars: ${over100k}`);

db.close();
