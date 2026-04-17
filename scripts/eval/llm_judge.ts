/**
 * LLM-as-judge: score each email's relevance (0-10) for preparing a specific meeting.
 *
 * Uses gemini-2.5-flash-lite via the Google AI REST API (GOOGLE_AI_API_KEY in .env).
 *
 * For each event in the embedding scores file, batch the emails (20 at a time),
 * send to Gemini with the event context, and collect a score per email.
 *
 * Output: `data/mock-mailbox-large-llm-judge.json`
 *   [{ eventId, meetingSubject, emailScores: [{ emailId, score, reason? }] }, ...]
 *
 * Checkpointing: writes partial results after every batch so crashes don't lose progress.
 *
 * Usage:
 *   npx tsx scripts/eval/llm_judge.ts
 *   npx tsx scripts/eval/llm_judge.ts --limit 2 --concurrency 5
 */

import "./node_shims"; // loads .env

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require("better-sqlite3");

import * as fs from "fs";
import { cleanEmailBody } from "../../src/services/cleanEmailBody";

// ─── CLI args ────────────────────────────────────────────────────────

function getArg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const inputFile = getArg("file", "data/mock-mailbox-large-embedding-scores-full.json");
const dbPath = getArg("db", "data/mock-mailbox-large.sqlite");
const outputFile = getArg("out", "data/mock-mailbox-large-llm-judge.json");
const limit = parseInt(getArg("limit", "0"), 10);
const concurrency = parseInt(getArg("concurrency", "10"), 10);
const batchSize = parseInt(getArg("batch", "20"), 10);
const model = getArg("model", "gemini-2.5-flash-lite");

const apiKey = process.env.GOOGLE_AI_API_KEY;
if (!apiKey) {
  console.error("ERROR: GOOGLE_AI_API_KEY not set in .env");
  process.exit(1);
}

// ─── Types ───────────────────────────────────────────────────────────

interface EmailScore {
  emailId: string;
  subject: string;
  score: number;
  projectId: string | null;
  isRelevant: boolean;
  participantEmail: string;
  direction: "received" | "sent";
  receivedDateTime: string;
}

interface EventScores {
  eventId: string;
  meetingSubject: string;
  expectedProjectId: string | null;
  query: string;
  scores: EmailScore[];
}

interface JudgedEmail {
  emailId: string;
  judgeScore: number;
  reason?: string;
}

interface JudgedEvent {
  eventId: string;
  meetingSubject: string;
  emailScores: JudgedEmail[];
}

// ─── Gemini REST API ─────────────────────────────────────────────────

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

async function callGemini(systemPrompt: string, userPrompt: string, maxRetries = 3): Promise<string> {
  const body = {
    contents: [{ parts: [{ text: userPrompt }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
      maxOutputTokens: 4096,
    },
  };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const resp = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        if (resp.status === 429 || resp.status === 503) {
          // Rate limit / overloaded — exponential backoff
          const delay = 2000 * Math.pow(2, attempt);
          console.log(`[LLMJudge] ${resp.status}, retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw new Error(`Gemini error ${resp.status}: ${txt.slice(0, 500)}`);
      }
      const json = await resp.json();
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error(`Empty response: ${JSON.stringify(json).slice(0, 300)}`);
      return text;
    } catch (err) {
      if (attempt === maxRetries - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error("Max retries exceeded");
}

// ─── DB helpers ──────────────────────────────────────────────────────

const db = new Database(dbPath, { readonly: true });

const eventStmt = db.prepare(
  "SELECT id, subject, body_content, start_date_time, attendees_json FROM calendar_events WHERE id = ?"
);
const emailStmt = db.prepare(
  "SELECT body_content, from_name, from_address FROM messages WHERE id = ?"
);

function getEventContext(eventId: string): { subject: string; body: string; date: string; participants: string } {
  const row = eventStmt.get(eventId) as {
    id: string;
    subject: string;
    body_content: string;
    start_date_time: string;
    attendees_json: string;
  };
  const body = row.body_content ? cleanEmailBody(row.body_content) : "";
  const attendees = JSON.parse(row.attendees_json || "[]") as Array<{ emailAddress?: { name: string; address: string } }>;
  const participants = attendees
    .map((a) => (a.emailAddress ? `${a.emailAddress.name || a.emailAddress.address}` : ""))
    .filter(Boolean)
    .join(", ");
  return { subject: row.subject, body: body.slice(0, 2000), date: row.start_date_time, participants };
}

function getEmailDetails(emailId: string): { from: string; body: string } {
  const row = emailStmt.get(emailId) as { body_content: string; from_name: string; from_address: string } | undefined;
  if (!row) return { from: "?", body: "" };
  return {
    from: row.from_name || row.from_address || "?",
    body: row.body_content ? cleanEmailBody(row.body_content) : "",
  };
}

// ─── Prompt building ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `Tu es un assistant qui aide à préparer des réunions professionnelles.
Ton rôle : évaluer la pertinence de chaque email pour aider à PRÉPARER UNE RÉUNION SPÉCIFIQUE.

Pour chaque email, donne une note de 0 à 10 :
- 10 = essentiel, absolument à lire pour préparer cette réunion
- 7-9 = très utile, directement lié au sujet ou aux décisions à prendre
- 4-6 = lien indirect mais peut fournir du contexte utile
- 1-3 = peu pertinent, mais pas totalement hors sujet
- 0 = sans aucun rapport avec la réunion

Considère :
- Les participants de la réunion (emails échangés avec eux = potentiellement pertinents)
- Le sujet et le contexte de la réunion
- La date : un email récent sur le même sujet vaut plus qu'un vieil email
- Les actions/décisions mentionnées dans les emails

Réponds UNIQUEMENT en JSON strict (array) sans markdown :
[{"index":0,"score":7},{"index":1,"score":3}, ...]`;

function buildUserPrompt(eventCtx: { subject: string; body: string; date: string; participants: string }, emails: Array<{ subject: string; from: string; date: string; body: string }>): string {
  const emailsStr = emails
    .map((e, i) => `[${i}] De: ${e.from} | Date: ${e.date.slice(0, 10)} | Sujet: ${e.subject}\n${e.body.slice(0, 800)}`)
    .join("\n\n---\n\n");

  return `## Réunion à préparer

Sujet : ${eventCtx.subject}
Date : ${eventCtx.date.slice(0, 10)}
Participants : ${eventCtx.participants}
Description : ${eventCtx.body || "(aucune)"}

## Emails à noter

${emailsStr}

Donne une note de 0 à 10 pour chaque email (index 0 à ${emails.length - 1}).`;
}

// ─── Parse response ──────────────────────────────────────────────────

function parseScoresFromResponse(text: string, expectedCount: number): Array<{ index: number; score: number; reason?: string }> {
  // Strip markdown fences just in case
  let clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch {
    // Try to extract the array from surrounding text
    const match = clean.match(/\[[\s\S]*\]/);
    if (!match) throw new Error(`Failed to parse JSON: ${text.slice(0, 200)}`);
    parsed = JSON.parse(match[0]);
  }
  if (!Array.isArray(parsed)) throw new Error("Response is not an array");
  return parsed
    .map((item: any) => ({
      index: typeof item.index === "number" ? item.index : -1,
      score: typeof item.score === "number" ? Math.max(0, Math.min(10, item.score)) : -1,
      reason: item.reason,
    }))
    .filter((s) => s.index >= 0 && s.index < expectedCount && s.score >= 0);
}

// ─── Main ────────────────────────────────────────────────────────────

async function scoreEvent(eventScore: EventScores): Promise<JudgedEvent> {
  const eventCtx = getEventContext(eventScore.eventId);
  const allEmails = eventScore.scores;

  console.log(`[LLMJudge] ${eventScore.meetingSubject} — ${allEmails.length} emails to judge`);

  const judgedByEmailId = new Map<string, number>();

  // Split into batches
  const batches: EmailScore[][] = [];
  for (let i = 0; i < allEmails.length; i += batchSize) {
    batches.push(allEmails.slice(i, i + batchSize));
  }

  // Process batches with concurrency limit
  let completed = 0;
  const runBatch = async (batch: EmailScore[]) => {
    const emailDetails = batch.map((e) => {
      const det = getEmailDetails(e.emailId);
      return {
        subject: e.subject,
        from: det.from,
        date: e.receivedDateTime,
        body: det.body,
      };
    });
    const userPrompt = buildUserPrompt(eventCtx, emailDetails);
    try {
      const response = await callGemini(SYSTEM_PROMPT, userPrompt);
      const scores = parseScoresFromResponse(response, batch.length);
      for (const s of scores) {
        judgedByEmailId.set(batch[s.index].emailId, s.score);
      }
    } catch (err) {
      console.warn(`[LLMJudge] Batch failed: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
    }
    completed++;
    if (completed % 10 === 0 || completed === batches.length) {
      console.log(`  ${completed}/${batches.length} batches (${judgedByEmailId.size} emails scored)`);
    }
  };

  // Process batches in chunks of `concurrency`
  for (let i = 0; i < batches.length; i += concurrency) {
    const chunk = batches.slice(i, i + concurrency);
    await Promise.all(chunk.map(runBatch));
  }

  const emailScores: JudgedEmail[] = Array.from(judgedByEmailId.entries()).map(([emailId, score]) => ({ emailId, judgeScore: score }));

  return {
    eventId: eventScore.eventId,
    meetingSubject: eventScore.meetingSubject,
    emailScores,
  };
}

async function main() {
  const data: EventScores[] = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  let events = data.filter((e) => e.expectedProjectId);
  if (limit > 0) events = events.slice(0, limit);

  console.log(`LLM Judge: ${events.length} events, model=${model}, concurrency=${concurrency}, batch=${batchSize}`);
  console.log(`Output: ${outputFile}`);

  // Resume from existing output if present
  let results: JudgedEvent[] = [];
  if (fs.existsSync(outputFile)) {
    try {
      results = JSON.parse(fs.readFileSync(outputFile, "utf8"));
      console.log(`Resumed: ${results.length} events already judged`);
    } catch {
      /* ignore */
    }
  }
  const doneIds = new Set(results.map((r) => r.eventId));

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (doneIds.has(ev.eventId)) {
      console.log(`[${i + 1}/${events.length}] SKIP (already done): ${ev.meetingSubject}`);
      continue;
    }
    console.log(`\n[${i + 1}/${events.length}] ${ev.meetingSubject}`);
    const start = Date.now();
    const judged = await scoreEvent(ev);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  Done in ${elapsed}s, ${judged.emailScores.length} emails scored`);

    results.push(judged);
    // Checkpoint after each event
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
  }

  console.log(`\nDone. ${results.length} events judged. Saved to ${outputFile}`);
  db.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
