/**
 * Evaluate retrieval strategies using LLM-judge scores as ground truth.
 *
 * Metrics: nDCG@K, avg judge score of selected, recall of "important" (score >= 7) emails.
 *
 * Strategies compared:
 *   (1) Baseline embedding-only: top-K by embedding score
 *   (2) Embedding + cross-encoder rerank: top-K after reranker
 *   (3) Hybrid recent/historical:
 *       - Rerank top N candidates → avg score of top 10
 *       - Keep all recent (<=6 months) with score >= 0.5 * avgTop10
 *       - Keep top 10 historical (>6 months) by rerank score
 *
 * Usage:
 *   npx tsx scripts/eval/eval_hybrid.ts
 *   npx tsx scripts/eval/eval_hybrid.ts --limit 5
 */

import "./node_shims";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require("better-sqlite3");

import * as fs from "fs";
import { rerank } from "../../src/services/rcpApiService";
import { cleanEmailBody } from "../../src/services/cleanEmailBody";

// ─── CLI ─────────────────────────────────────────────────────────────

function getArg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const embFile = getArg("emb", "data/mock-mailbox-large-embedding-scores-full.json");
const judgeFile = getArg("judge", "data/mock-mailbox-large-llm-judge.json");
const dbPath = getArg("db", "data/mock-mailbox-large.sqlite");
const limit = parseInt(getArg("limit", "0"), 10);
const recentMonths = parseInt(getArg("recent", "6"), 10);

// ─── Types ───────────────────────────────────────────────────────────

interface EmailScore {
  emailId: string;
  subject: string;
  score: number;
  participantEmail: string;
  direction: "received" | "sent";
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

// Only consider events that have both embedding and judge data
let events = embData.filter((e) => judgeByEvent.has(e.eventId));
if (limit > 0) events = events.slice(0, limit);

console.log(`Loaded ${events.length} events with both embedding + judge data.\n`);

const db = new Database(dbPath, { readonly: true });
const eventDateStmt = db.prepare("SELECT start_date_time FROM calendar_events WHERE id = ?");
const bodyStmt = db.prepare("SELECT body_content FROM messages WHERE id = ?");

function getEventDate(eventId: string): Date {
  const row = eventDateStmt.get(eventId) as { start_date_time: string };
  return new Date(row.start_date_time);
}

function getCleanBody(emailId: string): string {
  const row = bodyStmt.get(emailId) as { body_content: string } | undefined;
  return row?.body_content ? cleanEmailBody(row.body_content) : "";
}

// ─── Metrics ─────────────────────────────────────────────────────────

function dcg(scores: number[]): number {
  return scores.reduce((sum, s, i) => sum + (Math.pow(2, s) - 1) / Math.log2(i + 2), 0);
}

function ndcg(selectedScores: number[], idealSortedScores: number[], k: number): number {
  const actual = dcg(selectedScores.slice(0, k));
  const ideal = dcg(idealSortedScores.slice(0, k));
  return ideal > 0 ? actual / ideal : 0;
}

function avgScore(scores: number[]): number {
  return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
}

// "Important" emails = judge score >= 7
function recallImportant(selectedIds: Set<string>, allJudged: Map<string, number>, threshold = 7): number {
  let total = 0, found = 0;
  for (const [id, s] of allJudged) {
    if (s >= threshold) {
      total++;
      if (selectedIds.has(id)) found++;
    }
  }
  return total > 0 ? found / total : 0;
}

// ─── Strategies ──────────────────────────────────────────────────────

function strategyEmbeddingTopK(scores: EmailScore[], k: number): EmailScore[] {
  return [...scores].sort((a, b) => b.score - a.score).slice(0, k);
}

async function strategyEmbedAndRerank(
  scores: EmailScore[],
  query: string,
  embTopN: number,
  finalK: number
): Promise<EmailScore[]> {
  const candidates = strategyEmbeddingTopK(scores, embTopN);
  const documents = candidates.map((c) => `${c.subject}\n${getCleanBody(c.emailId)}`);
  try {
    const rerankRes = await rerank(query, documents);
    return rerankRes.slice(0, finalK).map((r) => candidates[r.index]);
  } catch (err) {
    console.warn("Rerank failed, falling back to embedding:", err);
    return candidates.slice(0, finalK);
  }
}

async function strategyHybrid(
  scores: EmailScore[],
  query: string,
  eventDate: Date,
  topNCandidates: number,
  topNHistorical: number,
  thresholdRatio: number,
  recentMonths: number
): Promise<EmailScore[]> {
  const candidates = strategyEmbeddingTopK(scores, topNCandidates);
  const documents = candidates.map((c) => `${c.subject}\n${getCleanBody(c.emailId)}`);

  let rerankScores: Array<{ index: number; score: number }>;
  try {
    rerankScores = await rerank(query, documents);
  } catch (err) {
    console.warn("Rerank failed in hybrid, returning embedding top-K:", err);
    return candidates.slice(0, topNCandidates);
  }

  const cutoff = new Date(eventDate);
  cutoff.setMonth(cutoff.getMonth() - recentMonths);

  // Attach rerank scores to candidates
  const scored = rerankScores.map((r) => ({
    email: candidates[r.index],
    rerankScore: r.score,
    date: new Date(candidates[r.index].receivedDateTime),
  }));
  scored.sort((a, b) => b.rerankScore - a.rerankScore);

  // Compute avg of top 10 rerank scores
  const avgTop10 = avgScore(scored.slice(0, 10).map((s) => s.rerankScore));
  const threshold = avgTop10 * thresholdRatio;

  // Recent emails above threshold
  const recentSelected = scored.filter((s) => s.date >= cutoff && s.rerankScore >= threshold);

  // Top-N historical (older than cutoff)
  const historical = scored.filter((s) => s.date < cutoff).slice(0, topNHistorical);

  const selected = [...recentSelected, ...historical];

  // Dedup (if an email is in both buckets, only keep once)
  const seen = new Set<string>();
  const deduped: EmailScore[] = [];
  for (const s of selected) {
    if (!seen.has(s.email.emailId)) {
      seen.add(s.email.emailId);
      deduped.push(s.email);
    }
  }
  return deduped;
}

// ─── Main ────────────────────────────────────────────────────────────

interface Result {
  strategy: string;
  event: string;
  selectedCount: number;
  ndcg10: number;
  ndcg30: number;
  avgJudgeScore: number;
  recallImportant: number;
  avgImportantOfSelected: number;
}

async function evaluate(strategyName: string, selected: EmailScore[], judgedMap: Map<string, number>, idealSortedScores: number[]): Promise<Omit<Result, "strategy" | "event">> {
  const selectedIds = new Set(selected.map((s) => s.emailId));
  const selectedScores = selected.map((s) => judgedMap.get(s.emailId) ?? 0);
  const important = selectedScores.filter((s) => s >= 7);

  return {
    selectedCount: selected.length,
    ndcg10: ndcg(selectedScores, idealSortedScores, 10),
    ndcg30: ndcg(selectedScores, idealSortedScores, 30),
    avgJudgeScore: avgScore(selectedScores),
    recallImportant: recallImportant(selectedIds, judgedMap),
    avgImportantOfSelected: selected.length > 0 ? important.length / selected.length : 0,
  };
}

(async () => {
  const allResults: Result[] = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    console.log(`\n[${i + 1}/${events.length}] ${ev.meetingSubject}`);

    const judgedMap = judgeByEvent.get(ev.eventId)!;
    const idealSortedScores = [...judgedMap.values()].sort((a, b) => b - a);
    const eventDate = getEventDate(ev.eventId);

    // Strategy 1: embedding top 20
    {
      const selected = strategyEmbeddingTopK(ev.scores, 20);
      const m = await evaluate("emb_top20", selected, judgedMap, idealSortedScores);
      allResults.push({ strategy: "emb_top20", event: ev.meetingSubject, ...m });
      console.log(`  emb_top20:       nDCG@10=${m.ndcg10.toFixed(3)} nDCG@30=${m.ndcg30.toFixed(3)} avgJudge=${m.avgJudgeScore.toFixed(2)} recallImp=${(m.recallImportant * 100).toFixed(0)}%`);
    }

    // Strategy 2: embedding top 50 → rerank top 20
    {
      const selected = await strategyEmbedAndRerank(ev.scores, ev.query, 50, 20);
      const m = await evaluate("emb50_rerank20", selected, judgedMap, idealSortedScores);
      allResults.push({ strategy: "emb50_rerank20", event: ev.meetingSubject, ...m });
      console.log(`  emb50_rerank20:  nDCG@10=${m.ndcg10.toFixed(3)} nDCG@30=${m.ndcg30.toFixed(3)} avgJudge=${m.avgJudgeScore.toFixed(2)} recallImp=${(m.recallImportant * 100).toFixed(0)}%`);
    }

    // Strategy 3: embedding top 200 → rerank top 30
    {
      const selected = await strategyEmbedAndRerank(ev.scores, ev.query, 200, 30);
      const m = await evaluate("emb200_rerank30", selected, judgedMap, idealSortedScores);
      allResults.push({ strategy: "emb200_rerank30", event: ev.meetingSubject, ...m });
      console.log(`  emb200_rerank30: nDCG@10=${m.ndcg10.toFixed(3)} nDCG@30=${m.ndcg30.toFixed(3)} avgJudge=${m.avgJudgeScore.toFixed(2)} recallImp=${(m.recallImportant * 100).toFixed(0)}%`);
    }

    // Strategy 4: hybrid recent/historical (200 candidates, 50% threshold, 6 months)
    {
      const selected = await strategyHybrid(ev.scores, ev.query, eventDate, 200, 10, 0.5, recentMonths);
      const m = await evaluate("hybrid_200_50pct_6mo", selected, judgedMap, idealSortedScores);
      allResults.push({ strategy: "hybrid_200_50pct_6mo", event: ev.meetingSubject, ...m });
      console.log(`  hybrid_200/50%/6mo (n=${selected.length}): nDCG@10=${m.ndcg10.toFixed(3)} nDCG@30=${m.ndcg30.toFixed(3)} avgJudge=${m.avgJudgeScore.toFixed(2)} recallImp=${(m.recallImportant * 100).toFixed(0)}%`);
    }

    // Strategy 5: hybrid with wider candidates (500)
    {
      const selected = await strategyHybrid(ev.scores, ev.query, eventDate, 500, 10, 0.5, recentMonths);
      const m = await evaluate("hybrid_500_50pct_6mo", selected, judgedMap, idealSortedScores);
      allResults.push({ strategy: "hybrid_500_50pct_6mo", event: ev.meetingSubject, ...m });
      console.log(`  hybrid_500/50%/6mo (n=${selected.length}): nDCG@10=${m.ndcg10.toFixed(3)} nDCG@30=${m.ndcg30.toFixed(3)} avgJudge=${m.avgJudgeScore.toFixed(2)} recallImp=${(m.recallImportant * 100).toFixed(0)}%`);
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(80)}`);
  console.log("SUMMARY (averages over events)");
  console.log("═".repeat(80));

  const strategies = Array.from(new Set(allResults.map((r) => r.strategy)));
  console.log(`${"strategy".padEnd(28)}${"n".padEnd(6)}${"nDCG@10".padEnd(10)}${"nDCG@30".padEnd(10)}${"avgJudge".padEnd(11)}${"recallImp"}`);
  console.log("─".repeat(80));
  for (const s of strategies) {
    const rs = allResults.filter((r) => r.strategy === s);
    const avgN = rs.reduce((a, b) => a + b.selectedCount, 0) / rs.length;
    const avg10 = rs.reduce((a, b) => a + b.ndcg10, 0) / rs.length;
    const avg30 = rs.reduce((a, b) => a + b.ndcg30, 0) / rs.length;
    const avgJ = rs.reduce((a, b) => a + b.avgJudgeScore, 0) / rs.length;
    const avgR = rs.reduce((a, b) => a + b.recallImportant, 0) / rs.length;
    console.log(`${s.padEnd(28)}${avgN.toFixed(0).padEnd(6)}${avg10.toFixed(3).padEnd(10)}${avg30.toFixed(3).padEnd(10)}${avgJ.toFixed(2).padEnd(11)}${(avgR * 100).toFixed(1)}%`);
  }

  const outPath = "data/eval_hybrid_results.json";
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));
  console.log(`\nFull results saved to ${outPath}`);

  db.close();
})();
