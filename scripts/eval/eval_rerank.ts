/**
 * Evaluate the impact of cross-encoder reranking (BAAI/bge-reranker-v2-m3).
 *
 * For each event: compare two strategies at the same final K:
 *   (a) Top-K from embedding only
 *   (b) Top-K embedding-N → rerank → top-K
 *
 * Reads the embedding scores file produced by collect_scores.ts (no re-embedding).
 * Reads the SQLite DB to fetch full body for the candidates (to feed to reranker).
 *
 * Usage:
 *   npx tsx scripts/eval/eval_rerank.ts --configs "200,50,20;500,100,30;500,200,50"
 */

import { rcpUrl, rcpKey } from "./node_shims";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require("better-sqlite3");

import * as fs from "fs";
import { rerank } from "../../src/services/rcpApiService";
import { cleanEmailBody } from "../../src/services/cleanEmailBody";

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

function getArg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const inputFile = getArg("file", "data/mock-mailbox-large-embedding-scores-full.json");
const dbPath = getArg("db", "data/mock-mailbox-large.sqlite");
const limit = parseInt(getArg("limit", "0"), 10);
const configsArg = getArg("configs", "200,50,20;500,100,30;500,200,50");

interface Config {
  maxN: number;
  embeddingTopK: number;
  rerankTopK: number;
}
const configs: Config[] = configsArg.split(";").map((c) => {
  const [maxN, e, r] = c.split(",").map((n) => parseInt(n, 10));
  return { maxN, embeddingTopK: e, rerankTopK: r };
});

if (!rcpKey) {
  console.error("ERROR: RCP_API_KEY not set in .env");
  process.exit(1);
}

console.log(`Loaded configs: ${configs.map((c) => `(${c.maxN},${c.embeddingTopK},${c.rerankTopK})`).join(" ")}`);
console.log(`RCP API: ${rcpUrl}`);

const data: EventScores[] = JSON.parse(fs.readFileSync(inputFile, "utf8"));
let events = data.filter((e) => e.expectedProjectId);
if (limit > 0) events = events.slice(0, limit);
console.log(`Evaluating on ${events.length} events.\n`);

const db = new Database(dbPath, { readonly: true });

// Cache total relevant emails per project
const totalByProject = new Map<string, number>();
for (const e of events) {
  if (!totalByProject.has(e.expectedProjectId!)) {
    const row = db.prepare("SELECT COUNT(*) as c FROM messages WHERE project_id = ?").get(e.expectedProjectId) as { c: number };
    totalByProject.set(e.expectedProjectId!, row.c);
  }
}

// Fetch full body for an email id from DB and clean it
const bodyStmt = db.prepare("SELECT body_content FROM messages WHERE id = ?");
function getCleanBody(emailId: string): string {
  const row = bodyStmt.get(emailId) as { body_content: string } | undefined;
  if (!row?.body_content) return "";
  return cleanEmailBody(row.body_content);
}

// ─── Helpers ─────────────────────────────────────────────────────────

function applyCap(scores: EmailScore[], maxN: number): EmailScore[] {
  const groups = new Map<string, EmailScore[]>();
  for (const s of scores) {
    const key = `${s.participantEmail}|${s.direction}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  const kept: EmailScore[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime());
    kept.push(...group.slice(0, maxN));
  }
  return kept;
}

function topKByScore(scores: EmailScore[], k: number): EmailScore[] {
  return [...scores].sort((a, b) => b.score - a.score).slice(0, k);
}

function metrics(selected: EmailScore[], totalRelevant: number) {
  const tp = selected.filter((s) => s.isRelevant).length;
  const fp = selected.length - tp;
  const p = selected.length > 0 ? tp / selected.length : 0;
  const r = totalRelevant > 0 ? tp / totalRelevant : 0;
  const f1 = p + r > 0 ? (2 * p * r) / (p + r) : 0;
  return { p, r, f1, tp, fp };
}

// ─── Main ────────────────────────────────────────────────────────────

interface ConfigResult {
  config: Config;
  embeddingOnly: { p: number; r: number; f1: number };
  withRerank: { p: number; r: number; f1: number };
}

const allResults: ConfigResult[] = [];

(async () => {
  for (const cfg of configs) {
    console.log(`\n${"═".repeat(70)}`);
    console.log(`Config: maxN=${cfg.maxN}  embeddingTopK=${cfg.embeddingTopK}  rerankTopK=${cfg.rerankTopK}`);
    console.log("═".repeat(70));

    const embOnly: Array<{ p: number; r: number; f1: number }> = [];
    const reranked: Array<{ p: number; r: number; f1: number }> = [];

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const totalRelevant = totalByProject.get(e.expectedProjectId!)!;

      // Apply cap
      const capped = applyCap(e.scores, cfg.maxN);

      // (a) Embedding-only: top rerankTopK from cap
      const embTop = topKByScore(capped, cfg.rerankTopK);
      const embM = metrics(embTop, totalRelevant);

      // (b) With rerank: top embeddingTopK → rerank → top rerankTopK
      const candidates = topKByScore(capped, cfg.embeddingTopK);
      const documents = candidates.map((c) => `${c.subject}\n${getCleanBody(c.emailId)}`);

      let rerankM = embM;
      try {
        const rerankRes = await rerank(e.query || e.meetingSubject, documents);
        const rerankSelected = rerankRes
          .slice(0, cfg.rerankTopK)
          .map((r) => candidates[r.index]);
        rerankM = metrics(rerankSelected, totalRelevant);
      } catch (err) {
        console.warn(`  [${i + 1}/${events.length}] Rerank failed: ${err instanceof Error ? err.message : err}`);
      }

      embOnly.push(embM);
      reranked.push(rerankM);

      console.log(
        `  [${i + 1}/${events.length}] ${e.meetingSubject.slice(0, 50).padEnd(50)} ` +
          `Emb: P=${(embM.p * 100).toFixed(0)}% R=${(embM.r * 100).toFixed(0)}% F1=${(embM.f1 * 100).toFixed(0)}%  ` +
          `Rerank: P=${(rerankM.p * 100).toFixed(0)}% R=${(rerankM.r * 100).toFixed(0)}% F1=${(rerankM.f1 * 100).toFixed(0)}%`
      );
    }

    const avgEmb = {
      p: embOnly.reduce((s, m) => s + m.p, 0) / embOnly.length,
      r: embOnly.reduce((s, m) => s + m.r, 0) / embOnly.length,
      f1: embOnly.reduce((s, m) => s + m.f1, 0) / embOnly.length,
    };
    const avgRerank = {
      p: reranked.reduce((s, m) => s + m.p, 0) / reranked.length,
      r: reranked.reduce((s, m) => s + m.r, 0) / reranked.length,
      f1: reranked.reduce((s, m) => s + m.f1, 0) / reranked.length,
    };

    console.log("─".repeat(70));
    console.log(`AVG embedding-only:  P=${(avgEmb.p * 100).toFixed(1)}%  R=${(avgEmb.r * 100).toFixed(1)}%  F1=${(avgEmb.f1 * 100).toFixed(1)}%`);
    console.log(`AVG with rerank:     P=${(avgRerank.p * 100).toFixed(1)}%  R=${(avgRerank.r * 100).toFixed(1)}%  F1=${(avgRerank.f1 * 100).toFixed(1)}%`);
    console.log(`Δ F1 from rerank:    ${((avgRerank.f1 - avgEmb.f1) * 100).toFixed(1)} pts`);

    allResults.push({ config: cfg, embeddingOnly: avgEmb, withRerank: avgRerank });
  }

  // Final summary
  console.log(`\n${"═".repeat(70)}`);
  console.log("FINAL SUMMARY");
  console.log("═".repeat(70));
  console.log(`${"config".padEnd(20)}${"emb F1".padEnd(12)}${"rerank F1".padEnd(14)}${"Δ F1"}`);
  console.log("─".repeat(70));
  for (const r of allResults) {
    const cfgStr = `(${r.config.maxN},${r.config.embeddingTopK},${r.config.rerankTopK})`;
    console.log(
      `${cfgStr.padEnd(20)}${(r.embeddingOnly.f1 * 100).toFixed(1).padEnd(10)}%  ` +
      `${(r.withRerank.f1 * 100).toFixed(1).padEnd(12)}%  ` +
      `${((r.withRerank.f1 - r.embeddingOnly.f1) * 100).toFixed(1)} pts`
    );
  }

  db.close();
})();
