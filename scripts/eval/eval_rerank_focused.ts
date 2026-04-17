/**
 * Focused rerank evaluation: test 2-3 configs on a small sample.
 *
 * Compares embedding-only vs embedding+rerank for configurations where
 * rerank MIGHT improve recall-of-important without sacrificing avgJudge.
 *
 * Uses aggressive retry + caching to survive socket errors.
 *
 * Usage:
 *   npx tsx scripts/eval/eval_rerank_focused.ts
 *   npx tsx scripts/eval/eval_rerank_focused.ts --limit 10
 */

import "./node_shims";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require("better-sqlite3");

import * as fs from "fs";
import { rerank } from "../../src/services/rcpApiService";
import { cleanEmailBody } from "../../src/services/cleanEmailBody";

function getArg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const embFile = "data/mock-mailbox-large-embedding-scores-full.json";
const judgeFile = "data/mock-mailbox-large-llm-judge.json";
const dbPath = "data/mock-mailbox-large.sqlite";
const cacheFile = "data/rerank_cache.json";
const limit = parseInt(getArg("limit", "10"), 10);

// ─── Types ───────────────────────────────────────────────────────────

interface EmailScore {
  emailId: string;
  subject: string;
  score: number;
  receivedDateTime: string;
}
interface EventScores {
  eventId: string;
  meetingSubject: string;
  query: string;
  scores: EmailScore[];
}
interface JudgedEvent {
  eventId: string;
  emailScores: Array<{ emailId: string; judgeScore: number }>;
}

// ─── Load data ───────────────────────────────────────────────────────

const embData: EventScores[] = JSON.parse(fs.readFileSync(embFile, "utf8"));
const judgeData: JudgedEvent[] = JSON.parse(fs.readFileSync(judgeFile, "utf8"));
const judgeByEvent = new Map(judgeData.map((j) => [j.eventId, new Map(j.emailScores.map((e) => [e.emailId, e.judgeScore]))]));

// Take events with more "important" emails first (more signal to measure)
let events = embData
  .filter((e) => judgeByEvent.has(e.eventId))
  .map((e) => {
    const judged = judgeByEvent.get(e.eventId)!;
    const impCount = Array.from(judged.values()).filter((s) => s >= 7).length;
    return { ev: e, impCount };
  })
  .sort((a, b) => b.impCount - a.impCount)
  .map((x) => x.ev);

if (limit > 0) events = events.slice(0, limit);
console.log(`Evaluating ${events.length} events (sorted by #important emails)\n`);

const db = new Database(dbPath, { readonly: true });
const bodyStmt = db.prepare("SELECT body_content FROM messages WHERE id = ?");

function getCleanBody(emailId: string): string {
  const row = bodyStmt.get(emailId) as { body_content: string } | undefined;
  return row?.body_content ? cleanEmailBody(row.body_content) : "";
}

// ─── Rerank cache (survive retries) ──────────────────────────────────

interface CacheEntry {
  eventId: string;
  candidateCount: number;
  // indices sorted by relevance_score desc + their scores
  rankedIndices: number[];
  rankedScores: number[];
}
let cache: Record<string, CacheEntry> = {};
if (fs.existsSync(cacheFile)) {
  try { cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch { /* ignore */ }
}
function cacheKey(eventId: string, candidateIds: string[]): string {
  // stable key on event + candidate composition
  return `${eventId}|${candidateIds.length}|${candidateIds.slice(0, 5).join(",")}|${candidateIds[candidateIds.length - 1]}`;
}

async function rerankWithCache(eventId: string, query: string, candidates: EmailScore[], maxRetries = 5): Promise<Array<{ index: number; score: number }> | null> {
  const key = cacheKey(eventId, candidates.map((c) => c.emailId));
  if (cache[key]) {
    return cache[key].rankedIndices.map((idx, i) => ({ index: idx, score: cache[key].rankedScores[i] }));
  }

  const documents = candidates.map((c) => `${c.subject}\n${getCleanBody(c.emailId)}`);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await rerank(query, documents);
      cache[key] = {
        eventId,
        candidateCount: candidates.length,
        rankedIndices: result.map((r) => r.index),
        rankedScores: result.map((r) => r.score),
      };
      fs.writeFileSync(cacheFile, JSON.stringify(cache));
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isSocket = /fetch failed|socket|ECONNRESET|other side closed/i.test(msg);
      console.warn(`  [rerank attempt ${attempt + 1}/${maxRetries}] ${msg.slice(0, 150)}`);
      if (isSocket && attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (attempt === maxRetries - 1) return null;
    }
  }
  return null;
}

// ─── Metrics ─────────────────────────────────────────────────────────

interface Metrics {
  avgJudge: number;
  n: number;
  countImp7: number;
  recallImp7: number;
  recallImp8: number;
}

function evaluate(selected: EmailScore[], judged: Map<string, number>): Metrics {
  const selectedScores = selected.map((s) => judged.get(s.emailId) ?? 0);
  const ids = new Set(selected.map((s) => s.emailId));

  let imp7Total = 0, imp7Found = 0, imp8Total = 0, imp8Found = 0;
  for (const [id, js] of judged) {
    if (js >= 7) { imp7Total++; if (ids.has(id)) imp7Found++; }
    if (js >= 8) { imp8Total++; if (ids.has(id)) imp8Found++; }
  }

  return {
    avgJudge: selectedScores.length > 0 ? selectedScores.reduce((a, b) => a + b, 0) / selectedScores.length : 0,
    n: selected.length,
    countImp7: selectedScores.filter((s) => s >= 7).length,
    recallImp7: imp7Total > 0 ? imp7Found / imp7Total : 0,
    recallImp8: imp8Total > 0 ? imp8Found / imp8Total : 0,
  };
}

function topKByEmb(scores: EmailScore[], k: number): EmailScore[] {
  return [...scores].sort((a, b) => b.score - a.score).slice(0, k);
}

// ─── Configs ─────────────────────────────────────────────────────────

interface Config {
  name: string;
  embTopN: number;
  finalK: number;
}

const configs: Config[] = [
  { name: "emb100→rerank30", embTopN: 100, finalK: 30 },
  { name: "emb200→rerank30", embTopN: 200, finalK: 30 },
  { name: "emb300→rerank50", embTopN: 300, finalK: 50 },
];

// ─── Main ────────────────────────────────────────────────────────────

interface EventResult {
  event: string;
  embOnly: Metrics;
  rerankResults: Array<{ config: string; metrics: Metrics | null }>;
}

(async () => {
  const allResults: EventResult[] = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const judged = judgeByEvent.get(ev.eventId)!;

    console.log(`\n[${i + 1}/${events.length}] ${ev.meetingSubject}`);

    const embOnly = evaluate(topKByEmb(ev.scores, 30), judged);
    console.log(`  emb_top30 baseline: n=30 avgJudge=${embOnly.avgJudge.toFixed(2)} R@7=${(embOnly.recallImp7 * 100).toFixed(0)}% R@8=${(embOnly.recallImp8 * 100).toFixed(0)}%`);

    const rerankResults: Array<{ config: string; metrics: Metrics | null }> = [];

    for (const cfg of configs) {
      const candidates = topKByEmb(ev.scores, cfg.embTopN);
      const rerankRes = await rerankWithCache(ev.eventId, ev.query, candidates);
      if (!rerankRes) {
        console.log(`  ${cfg.name}: RERANK FAILED (all retries exhausted)`);
        rerankResults.push({ config: cfg.name, metrics: null });
        continue;
      }
      const selected = rerankRes.slice(0, cfg.finalK).map((r) => candidates[r.index]);
      const m = evaluate(selected, judged);
      rerankResults.push({ config: cfg.name, metrics: m });
      console.log(`  ${cfg.name}: n=${m.n} avgJudge=${m.avgJudge.toFixed(2)} R@7=${(m.recallImp7 * 100).toFixed(0)}% R@8=${(m.recallImp8 * 100).toFixed(0)}%`);
    }

    allResults.push({ event: ev.meetingSubject, embOnly, rerankResults });
  }

  // ─── Summary ───────────────────────────────────────────────────────

  console.log(`\n${"═".repeat(80)}`);
  console.log("SUMMARY (averages)");
  console.log("═".repeat(80));

  const avgOf = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const embMetrics = allResults.map((r) => r.embOnly);
  console.log(`emb_top30 baseline:     n=30  avgJudge=${avgOf(embMetrics.map((m) => m.avgJudge)).toFixed(2)}  R@7=${(avgOf(embMetrics.map((m) => m.recallImp7)) * 100).toFixed(1)}%  R@8=${(avgOf(embMetrics.map((m) => m.recallImp8)) * 100).toFixed(1)}%`);

  for (const cfg of configs) {
    const valid = allResults.map((r) => r.rerankResults.find((rr) => rr.config === cfg.name)?.metrics).filter(Boolean) as Metrics[];
    if (valid.length === 0) {
      console.log(`${cfg.name}: ALL FAILED`);
      continue;
    }
    console.log(`${cfg.name.padEnd(24)} n=${cfg.finalK}  avgJudge=${avgOf(valid.map((m) => m.avgJudge)).toFixed(2)}  R@7=${(avgOf(valid.map((m) => m.recallImp7)) * 100).toFixed(1)}%  R@8=${(avgOf(valid.map((m) => m.recallImp8)) * 100).toFixed(1)}%  (${valid.length}/${allResults.length} successful)`);
  }

  db.close();
})();
