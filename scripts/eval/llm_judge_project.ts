/**
 * LLM Judge — score each PROJECT email for relevance to its own project.
 *
 * Only scores the 3688 emails with project_id (NOT noise).
 * Uses project title + description as context (from `projects` table).
 *
 * Output: data/mock-mailbox-large-project-relevance.json
 *
 * Usage:
 *   npx tsx scripts/eval/llm_judge_project.ts
 *   npx tsx scripts/eval/llm_judge_project.ts --limit 3  (limit # projects)
 */

import "./node_shims";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require("better-sqlite3");

import * as fs from "fs";
import { cleanEmailBody } from "../../src/services/cleanEmailBody";

function getArg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const dbPath = getArg("db", "data/mock-mailbox-large.sqlite");
const outputFile = getArg("out", "data/mock-mailbox-large-project-relevance-v2.json");
const limit = parseInt(getArg("limit", "0"), 10);
const concurrency = parseInt(getArg("concurrency", "10"), 10);
const batchSize = 30;
const model = getArg("model", "gemini-2.5-flash-lite");

const apiKey = process.env.GOOGLE_AI_API_KEY;
if (!apiKey) {
  console.error("ERROR: GOOGLE_AI_API_KEY not set in .env");
  process.exit(1);
}

// ─── Gemini API ──────────────────────────────────────────────────────

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
          const delay = 2000 * Math.pow(2, attempt);
          console.log(`  [Gemini] ${resp.status}, retrying in ${delay}ms...`);
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

// ─── DB ──────────────────────────────────────────────────────────────

const db = new Database(dbPath, { readonly: true });

interface ProjectRow { id: string; title: string; description: string }
interface EmailRow { id: string; subject: string; body_content: string; from_name: string; from_address: string; received_date_time: string; project_id: string }

let projects = db.prepare("SELECT id, title, description FROM projects").all() as ProjectRow[];
if (limit > 0) projects = projects.slice(0, limit);

const emailsByProject = new Map<string, EmailRow[]>();
for (const p of projects) {
  const emails = db.prepare(
    "SELECT id, subject, body_content, from_name, from_address, received_date_time, project_id FROM messages WHERE project_id = ? ORDER BY received_date_time DESC"
  ).all(p.id) as EmailRow[];
  emailsByProject.set(p.id, emails);
}

const totalEmails = Array.from(emailsByProject.values()).reduce((s, e) => s + e.length, 0);
console.log(`${projects.length} projects, ${totalEmails} emails to score\n`);

// ─── Prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Bonjour Gemini, comme tu es toujours un allié de valeur, je demande tes services d'expert pour évaluer des emails.

CONTEXTE : On développe une pipeline RAG de préparation de réunions. Avant une réunion, le système récupère automatiquement les emails les plus pertinents échangés avec les participants, puis les envoie à un LLM pour générer un briefing de préparation. Ta note détermine la "ground truth" : quels emails le système DEVRAIT sélectionner pour produire un briefing utile.

CRITÈRE : L'email apporte-t-il du contenu exploitable par un LLM pour rédiger un briefing de préparation de réunion sur ce projet ?

Échelle 0-10 :

- 9-10 : Indispensable. Contient des décisions, résultats, livrables, problèmes critiques ou positions clés des participants. Le briefing serait incomplet sans.
  Exemple 9 : "Les tests de charge montrent que l'algorithme v2 réduit la latence de 40%. Je recommande de passer en production avant le 15 mars."
  Exemple 10 : "Après discussion avec le doyen, le budget est réduit de 30%. Il faut couper le module NLP ou reporter à septembre. Décision à prendre vendredi."

- 7-8 : Très utile. Apporte du contexte technique, des avancées concrètes, des questions ouvertes ou des engagements pris.
  Exemple 7 : "J'ai commencé l'intégration du module de tokenization multilingue. Premiers résultats prometteurs sur le français et l'allemand, reste à tester l'italien."
  Exemple 8 : "Le partenariat avec Politecnico Milano est confirmé. Ils nous envoient 3 datasets annotés d'ici fin mars. J'ai signé le NDA."

- 5-6 : Contexte secondaire. Infos de coordination ou logistique qui enrichissent le briefing sans être essentielles.
  Exemple 5 : "J'ai réservé la salle BC 410 pour la démo du 20 mars. Merci de confirmer votre présence."
  Exemple 6 : "Le budget restant pour le cluster GPU est de 12'000 CHF. Il faudra arbitrer entre les deux expériences prévues."

- 3-4 : Faible valeur. Accusés de réception, relances sans contenu, propositions de créneaux.
  Exemple 3 : "OK pour mardi, je serai là."
  Exemple 4 : "Bien reçu, je regarde et je te reviens. On en parle à la réunion de jeudi ?"

- 1-2 : Quasi inutile. Mentionne le projet mais n'apporte rien au briefing.
- 0 : Aucun rapport avec le projet.

IMPORTANT : Un email qui dit juste "on se voit mardi pour en discuter" = 3, pas 7. Seul le CONTENU informatif compte, pas la mention du projet.

Ton travail est précieux pour calibrer notre système — prends le temps de bien différencier les emails qui apportent du contenu informatif de ceux qui ne font que mentionner le projet sans rien dire de substantiel.

Réponds UNIQUEMENT en JSON strict :
[{"index":0,"score":7},{"index":1,"score":3}, ...]`;

function buildUserPrompt(project: ProjectRow, emails: EmailRow[]): string {
  const emailsStr = emails
    .map((e, i) => {
      const from = e.from_name || e.from_address || "?";
      const body = e.body_content ? cleanEmailBody(e.body_content) : "";
      return `[${i}] De: ${from} | Date: ${e.received_date_time.slice(0, 10)} | Sujet: ${e.subject}\n${body.slice(0, 1000)}`;
    })
    .join("\n\n---\n\n");

  return `## Projet
Titre : ${project.title}
Description : ${project.description}

## Emails à noter

${emailsStr}

Note chaque email de 0 à 10 selon sa valeur pour générer un briefing de réunion.`;
}

function parseScores(text: string, expectedCount: number): Array<{ index: number; score: number }> {
  let clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch {
    const match = clean.match(/\[[\s\S]*\]/);
    if (!match) throw new Error(`Failed to parse: ${text.slice(0, 200)}`);
    parsed = JSON.parse(match[0]);
  }
  if (!Array.isArray(parsed)) throw new Error("Not an array");
  return (parsed as Array<{ index: number; score: number }>)
    .filter((s) => typeof s.index === "number" && typeof s.score === "number" && s.index >= 0 && s.index < expectedCount)
    .map((s) => ({ index: s.index, score: Math.max(0, Math.min(10, s.score)) }));
}

// ─── Main ────────────────────────────────────────────────────────────

interface ScoredEmail {
  emailId: string;
  projectId: string;
  scores: number[];       // one per pass
  mean: number;
  variance: number;
}

const numPasses = parseInt(getArg("passes", "5"), 10);

async function runOnePass(passIndex: number): Promise<Map<string, number>> {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`PASS ${passIndex + 1}/${numPasses}`);
  console.log("═".repeat(60));

  const allScored = new Map<string, number>();

  for (let pi = 0; pi < projects.length; pi++) {
    const project = projects[pi];
    const emails = emailsByProject.get(project.id)!;
    console.log(`  [${pi + 1}/${projects.length}] ${project.title} — ${emails.length} emails`);

    const batches: EmailRow[][] = [];
    for (let i = 0; i < emails.length; i += batchSize) {
      batches.push(emails.slice(i, i + batchSize));
    }

    let completed = 0;
    const runBatch = async (batch: EmailRow[]) => {
      const prompt = buildUserPrompt(project, batch);
      try {
        const response = await callGemini(SYSTEM_PROMPT, prompt);
        const scores = parseScores(response, batch.length);
        for (const s of scores) {
          allScored.set(batch[s.index].id, s.score);
        }
      } catch (err) {
        console.warn(`    Batch failed: ${err instanceof Error ? err.message.slice(0, 150) : err}`);
      }
      completed++;
      if (completed % 5 === 0 || completed === batches.length) {
        console.log(`    ${completed}/${batches.length} batches`);
      }
    };

    for (let i = 0; i < batches.length; i += concurrency) {
      await Promise.all(batches.slice(i, i + concurrency).map(runBatch));
    }
  }

  console.log(`  Pass ${passIndex + 1} done: ${allScored.size} emails scored`);
  return allScored;
}

async function main() {
  // Load existing v2 run 1 if present (to avoid re-running pass 1)
  const existingV2File = "data/mock-mailbox-large-project-relevance-v2.json";
  let existingPass1 = new Map<string, number>();
  if (fs.existsSync(existingV2File)) {
    const data = JSON.parse(fs.readFileSync(existingV2File, "utf8")) as Array<{ emailId: string; relevanceScore: number }>;
    for (const r of data) existingPass1.set(r.emailId, r.relevanceScore);
    console.log(`Loaded ${existingPass1.size} scores from existing v2 run (will use as pass 1)\n`);
  }

  const passes: Map<string, number>[] = [];

  // Pass 1 = existing v2 if available
  if (existingPass1.size > 0) {
    passes.push(existingPass1);
    console.log("Pass 1: reusing existing v2 scores");
  }

  // Run remaining passes
  const remaining = numPasses - passes.length;
  for (let i = 0; i < remaining; i++) {
    const passScores = await runOnePass(passes.length);
    passes.push(passScores);

    // Checkpoint after each pass
    const partial = buildResults(passes);
    fs.writeFileSync(outputFile, JSON.stringify(partial, null, 2));
    console.log(`  Checkpoint saved (${passes.length}/${numPasses} passes)`);
  }

  const results = buildResults(passes);
  fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));

  // Stats
  console.log(`\n${"═".repeat(60)}`);
  console.log(`FINAL: ${results.length} emails, ${passes.length} passes`);

  console.log("\nDistribution (mean score rounded):");
  const hist = new Map<number, number>();
  for (const r of results) {
    const bucket = Math.round(r.mean);
    hist.set(bucket, (hist.get(bucket) || 0) + 1);
  }
  for (let i = 0; i <= 10; i++) {
    const n = hist.get(i) || 0;
    console.log(`  ${String(i).padEnd(3)}: ${String(n).padStart(5)} (${((n / results.length) * 100).toFixed(1).padStart(5)}%)`);
  }

  const variances = results.map((r) => r.variance);
  const avgVar = variances.reduce((a, b) => a + b, 0) / variances.length;
  const maxVar = Math.max(...variances);
  console.log(`\nVariance: avg=${avgVar.toFixed(3)}, max=${maxVar.toFixed(3)}, stddev avg=${Math.sqrt(avgVar).toFixed(2)}`);

  // High-variance emails
  const highVar = results.filter((r) => r.variance >= 2).sort((a, b) => b.variance - a.variance);
  if (highVar.length > 0) {
    console.log(`\nHigh variance (≥2.0): ${highVar.length} emails`);
    for (const r of highVar.slice(0, 10)) {
      console.log(`  var=${r.variance.toFixed(2)} scores=[${r.scores.join(",")}] mean=${r.mean.toFixed(1)} ${r.emailId.slice(0, 8)}...`);
    }
  }

  db.close();
}

function buildResults(passes: Map<string, number>[]): ScoredEmail[] {
  // Collect all email IDs
  const allIds = new Set<string>();
  for (const pass of passes) for (const id of pass.keys()) allIds.add(id);

  // Build per-email with project lookup
  const emailProject = new Map<string, string>();
  for (const [pid, emails] of emailsByProject) {
    for (const e of emails) emailProject.set(e.id, pid);
  }

  const results: ScoredEmail[] = [];
  for (const id of allIds) {
    const scores = passes.map((p) => p.get(id)).filter((s): s is number => s !== undefined);
    if (scores.length === 0) continue;
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.length > 1
      ? scores.reduce((s, v) => s + (v - mean) ** 2, 0) / (scores.length - 1)
      : 0;
    results.push({
      emailId: id,
      projectId: emailProject.get(id) || "?",
      scores,
      mean: Math.round(mean * 100) / 100,
      variance: Math.round(variance * 1000) / 1000,
    });
  }
  return results;
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
