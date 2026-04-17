import { cleanEmailBody } from "../../src/services/cleanEmailBody";
import * as fs from "fs";

const input = process.argv[2] || "data/emails-export-500.json";
const output = input.replace(".json", "-cleaned.json");

const emails = JSON.parse(fs.readFileSync(input, "utf8"));
for (const e of emails) {
  if (e.body?.content) {
    e.body.contentCleaned = cleanEmailBody(e.body.content);
  }
}
fs.writeFileSync(output, JSON.stringify(emails, null, 2));
console.log(`${emails.length} emails → ${output}`);
