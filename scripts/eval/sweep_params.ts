/**
 * Offline hyperparameter sweep using the embedding scores collected by collect_scores.ts.
 *
 * Reads `data/mock-mailbox-large-embedding-scores-full.json` (no API calls).
 * Computes precision/recall/F1 for various combinations of:
 *   - maxEmailsPerParticipant (cap on collection per participant per direction)
 *   - embeddingTopK (how many to keep after semantic ranking)
 *
 * Also computes the absolute ceiling recall (without any cap or topK).
 *
 * Usage:
 *   npx tsx scripts/eval/sweep_params.ts
 *   npx tsx scripts/eval/sweep_params.ts --file data/mock-mailbox-large-embedding-scores-full.json
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require("better-sqlite3");

import * as fs from "fs";

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
  totalEmails: number;
  relevantCount: number;
  scores: EmailScore[];
}

function getArg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const inputFile = getArg("file", "data/mock-mailbox-large-embedding-scores-full.json");
const dbPath = getArg("db", "data/mock-mailbox-large.sqlite");

const data: EventScores[] = JSON.parse(fs.readFileSync(inputFile, "utf8"));
const eventsWithProject = data.filter((e) => e.expectedProjectId);

console.log(`Loaded ${data.length} events (${eventsWithProject.length} with ground-truth project).\n`);

// ─── Get total relevant count per project (for ceiling recall calc) ──

const db = new Database(dbPath, { readonly: true });
const totalByProject = new Map<string, number>();
for (const e of eventsWithProject) {
  if (!totalByProject.has(e.expectedProjectId!)) {
    const row = db.prepare("SELECT COUNT(*) as c FROM messages WHERE project_id = ?").get(e.expectedProjectId) as { c: number };
    totalByProject.set(e.expectedProjectId!, row.c);
  }
}
db.close();

// ─── Helpers ─────────────────────────────────────────────────────────

function applyCap(scores: EmailScore[], maxN: number): EmailScore[] {
  // Group by (participantEmail, direction), keep top N most recent per group
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
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  return sorted.slice(0, k);
}

function metrics(selected: EmailScore[], totalRelevantInProject: number): { p: number; r: number; f1: number; tp: number; fp: number } {
  const tp = selected.filter((s) => s.isRelevant).length;
  const fp = selected.length - tp;
  const p = selected.length > 0 ? tp / selected.length : 0;
  const r = totalRelevantInProject > 0 ? tp / totalRelevantInProject : 0;
  const f1 = p + r > 0 ? (2 * p * r) / (p + r) : 0;
  return { p, r, f1, tp, fp };
}

function avgMetrics(perEvent: Array<{ p: number; r: number; f1: number }>): { p: number; r: number; f1: number } {
  const n = perEvent.length;
  return {
    p: perEvent.reduce((s, m) => s + m.p, 0) / n,
    r: perEvent.reduce((s, m) => s + m.r, 0) / n,
    f1: perEvent.reduce((s, m) => s + m.f1, 0) / n,
  };
}

// ─── Sweep 1: Ceiling recall (no cap, no topK) ───────────────────────

console.log("═".repeat(70));
console.log("SWEEP 1 — Ceiling recall (all collected emails count as 'selected')");
console.log("═".repeat(70));

const ceilingPerEvent = eventsWithProject.map((e) => {
  const totalProject = totalByProject.get(e.expectedProjectId!)!;
  return { ...metrics(e.scores, totalProject), event: e.meetingSubject, totalProject, collected: e.scores.length };
});

const avgCeiling = avgMetrics(ceilingPerEvent);
console.log(`Avg ceiling recall: ${(avgCeiling.r * 100).toFixed(1)}% (over ${ceilingPerEvent.length} events)`);
console.log(`  → ${(100 - avgCeiling.r * 100).toFixed(1)}% of project emails are unreachable via participant search`);
console.log("");
console.log("Per event:");
for (const m of ceilingPerEvent) {
  console.log(`  ${m.r * 100 >= 95 ? "✓" : m.r * 100 >= 70 ? "~" : "✗"} R=${(m.r * 100).toFixed(0)}% (${m.tp}/${m.totalProject})  ${m.event.slice(0, 60)}`);
}

// ─── Sweep 2: Effect of maxEmailsPerParticipant on ceiling ───────────

console.log("");
console.log("═".repeat(70));
console.log("SWEEP 2 — Effect of maxEmailsPerParticipant on ceiling recall");
console.log("═".repeat(70));

const maxNValues = [50, 100, 200, 300, 500, 1000, 99999];
console.log(`\n${"maxN".padEnd(8)}${"avg recall".padEnd(14)}${"avg P".padEnd(10)}${"emails kept (avg)"}`);
console.log("─".repeat(70));
for (const maxN of maxNValues) {
  const perEvent = eventsWithProject.map((e) => {
    const capped = applyCap(e.scores, maxN);
    const totalProject = totalByProject.get(e.expectedProjectId!)!;
    return { ...metrics(capped, totalProject), kept: capped.length };
  });
  const avg = avgMetrics(perEvent);
  const avgKept = perEvent.reduce((s, m) => s + m.kept, 0) / perEvent.length;
  console.log(`${(maxN === 99999 ? "∞" : String(maxN)).padEnd(8)}${(avg.r * 100).toFixed(1).padEnd(8)}%     ${(avg.p * 100).toFixed(1).padEnd(6)}%   ${avgKept.toFixed(0)}`);
}

// ─── Sweep 3: Effect of embeddingTopK (with cap maxN) ────────────────

console.log("");
console.log("═".repeat(70));
console.log("SWEEP 3 — Effect of embeddingTopK at various maxN");
console.log("═".repeat(70));

const sweepMaxN = [100, 200, 500];
const sweepTopK = [10, 20, 30, 50, 100, 200];

console.log(`\n${"maxN".padEnd(8)}${"topK".padEnd(8)}${"avg P".padEnd(10)}${"avg R".padEnd(10)}${"avg F1"}`);
console.log("─".repeat(70));
for (const maxN of sweepMaxN) {
  for (const topK of sweepTopK) {
    const perEvent = eventsWithProject.map((e) => {
      const capped = applyCap(e.scores, maxN);
      const top = topKByScore(capped, topK);
      const totalProject = totalByProject.get(e.expectedProjectId!)!;
      return metrics(top, totalProject);
    });
    const avg = avgMetrics(perEvent);
    console.log(`${String(maxN).padEnd(8)}${String(topK).padEnd(8)}${(avg.p * 100).toFixed(1).padEnd(8)}%  ${(avg.r * 100).toFixed(1).padEnd(8)}%  ${(avg.f1 * 100).toFixed(1)}%`);
  }
  console.log("─".repeat(70));
}

// ─── Sweep 4: Score distribution ─────────────────────────────────────

console.log("");
console.log("═".repeat(70));
console.log("SWEEP 4 — Score distribution (relevant vs irrelevant)");
console.log("═".repeat(70));

const allRelevant = eventsWithProject.flatMap((e) => e.scores.filter((s) => s.isRelevant).map((s) => s.score));
const allIrrelevant = eventsWithProject.flatMap((e) => e.scores.filter((s) => !s.isRelevant).map((s) => s.score));

function pct(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * p)];
}

function minOf(arr: number[]): number { let m = Infinity; for (const v of arr) if (v < m) m = v; return m; }
function maxOf(arr: number[]): number { let m = -Infinity; for (const v of arr) if (v > m) m = v; return m; }

console.log(`\nRelevant (n=${allRelevant.length}):`);
console.log(`  min=${minOf(allRelevant).toFixed(3)}  p10=${pct(allRelevant, 0.1).toFixed(3)}  p50=${pct(allRelevant, 0.5).toFixed(3)}  p90=${pct(allRelevant, 0.9).toFixed(3)}  max=${maxOf(allRelevant).toFixed(3)}`);
console.log(`Irrelevant (n=${allIrrelevant.length}):`);
console.log(`  min=${minOf(allIrrelevant).toFixed(3)}  p10=${pct(allIrrelevant, 0.1).toFixed(3)}  p50=${pct(allIrrelevant, 0.5).toFixed(3)}  p90=${pct(allIrrelevant, 0.9).toFixed(3)}  max=${maxOf(allIrrelevant).toFixed(3)}`);

// ─── Sweep 5: Threshold-based selection ──────────────────────────────

console.log("");
console.log("═".repeat(70));
console.log("SWEEP 5 — Selection by score threshold (no top-K)");
console.log("═".repeat(70));
console.log(`\n${"threshold".padEnd(12)}${"avg P".padEnd(10)}${"avg R".padEnd(10)}${"avg F1".padEnd(10)}${"avg #selected"}`);
console.log("─".repeat(70));

const thresholds = [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70];
for (const thr of thresholds) {
  const perEvent = eventsWithProject.map((e) => {
    const selected = e.scores.filter((s) => s.score >= thr);
    const totalProject = totalByProject.get(e.expectedProjectId!)!;
    return { ...metrics(selected, totalProject), n: selected.length };
  });
  const avg = avgMetrics(perEvent);
  const avgN = perEvent.reduce((s, m) => s + m.n, 0) / perEvent.length;
  console.log(`${thr.toFixed(2).padEnd(12)}${(avg.p * 100).toFixed(1).padEnd(8)}%  ${(avg.r * 100).toFixed(1).padEnd(8)}%  ${(avg.f1 * 100).toFixed(1).padEnd(8)}%  ${avgN.toFixed(0)}`);
}

console.log("\nDone.");
