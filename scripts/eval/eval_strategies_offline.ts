/**
 * Evaluate retrieval strategies using DB as single source of truth.
 *
 * Tables used:
 *   - email_event_scores: embedding_score + rerank_score per (email, event)
 *   - messages: relevance_score (ground truth, NULL for noise = 0)
 *   - calendar_events: event dates
 *
 * 100% offline — no API calls.
 *
 * Usage:
 *   npx tsx scripts/eval/eval_strategies_offline.ts
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require("better-sqlite3");

const db = new Database("data/mock-mailbox-large.sqlite", { readonly: true });

// ─── Load data ───────────────────────────────────────────────────────

interface ScoredEmail {
  emailId: string;
  embeddingScore: number;
  rerankScore: number | null;
  relevance: number; // ground truth (0 for noise)
  projectId: string | null;
}

interface EventData {
  eventId: string;
  subject: string;
  eventProjectId: string | null;
  emails: ScoredEmail[];
  totalImp7: number;
  totalImp8: number;
}

const events: EventData[] = [];

const eventRows = db.prepare("SELECT DISTINCT event_id FROM email_event_scores ORDER BY event_id").all() as Array<{ event_id: string }>;

// Map event → project using same logic as SqliteMailDataSource.getEventProjectId()
const getEventProjectStmt = db.prepare(`
  SELECT pp.project_id, COUNT(*) as match_count
  FROM calendar_events ce, json_each(ce.attendees_json) je, project_participants pp
  WHERE json_extract(je.value, '$.emailAddress.address') = pp.participant_email
    AND ce.id = ?
  GROUP BY pp.project_id
  ORDER BY match_count DESC
  LIMIT 1
`);

for (const { event_id } of eventRows) {
  const info = db.prepare("SELECT subject, start_date_time FROM calendar_events WHERE id = ?").get(event_id) as { subject: string; start_date_time: string };
  const eventDate = info.start_date_time;

  const projectRow = getEventProjectStmt.get(event_id) as { project_id: string } | undefined;
  const eventProjectId = projectRow?.project_id || null;

  // Only emails BEFORE the event
  const rows = db.prepare(`
    SELECT ees.email_id, ees.embedding_score, ees.rerank_score,
           COALESCE(m.relevance_score, 0) as relevance, m.project_id
    FROM email_event_scores ees
    JOIN messages m ON m.id = ees.email_id
    WHERE ees.event_id = ?
      AND m.received_date_time < ?
    ORDER BY ees.embedding_score DESC
  `).all(event_id, eventDate) as Array<{ email_id: string; embedding_score: number; rerank_score: number | null; relevance: number; project_id: string | null }>;

  const emails: ScoredEmail[] = rows.map((r) => ({
    emailId: r.email_id,
    embeddingScore: r.embedding_score,
    rerankScore: r.rerank_score,
    relevance: r.relevance,
    projectId: r.project_id,
  }));

  // Denominator = only emails FROM THIS EVENT'S PROJECT with score >= threshold, before the event
  const totalImp7 = emails.filter((e) => e.projectId === eventProjectId && e.relevance >= 7).length;
  const totalImp8 = emails.filter((e) => e.projectId === eventProjectId && e.relevance >= 8).length;

  events.push({ eventId: event_id, subject: info.subject, eventProjectId, emails, totalImp7, totalImp8 });
}

console.log(`Loaded ${events.length} events, ${events.reduce((s, e) => s + e.emails.length, 0).toLocaleString()} total pairs.\n`);

// ─── Metrics ─────────────────────────────────────────────────────────

function dcg(scores: number[]): number {
  return scores.reduce((sum, s, i) => sum + (Math.pow(2, s) - 1) / Math.log2(i + 2), 0);
}

interface Metrics {
  n: number;
  nDCG20: number;
  avgRel: number;
  countImp7: number;
  precImp7: number;
  recallImp7: number;
  precImp8: number;
  recallImp8: number;
  noisePct: number;
}

function evaluate(selected: ScoredEmail[], event: EventData): Metrics {
  const rels = selected.map((s) => s.relevance);
  const allRels = event.emails.map((s) => s.relevance);
  const idealTop20 = [...allRels].sort((a, b) => b - a).slice(0, 20);

  // Only count emails from the event's project as important (not cross-project)
  let imp7 = 0, imp8 = 0, noise = 0;
  for (const s of selected) {
    if (s.projectId === event.eventProjectId && s.relevance >= 7) imp7++;
    if (s.projectId === event.eventProjectId && s.relevance >= 8) imp8++;
    if (s.relevance === 0) noise++;
  }

  return {
    n: selected.length,
    nDCG20: dcg(rels.slice(0, 20)) / (dcg(idealTop20) || 1),
    avgRel: rels.length > 0 ? rels.reduce((a, b) => a + b, 0) / rels.length : 0,
    countImp7: imp7,
    precImp7: selected.length > 0 ? imp7 / selected.length : 0,
    recallImp7: event.totalImp7 > 0 ? imp7 / event.totalImp7 : 0,
    precImp8: selected.length > 0 ? imp8 / selected.length : 0,
    recallImp8: event.totalImp8 > 0 ? imp8 / event.totalImp8 : 0,
    noisePct: selected.length > 0 ? noise / selected.length : 0,
  };
}

function avg(results: Metrics[]): Metrics {
  const n = results.length;
  return {
    n: results.reduce((s, r) => s + r.n, 0) / n,
    nDCG20: results.reduce((s, r) => s + r.nDCG20, 0) / n,
    avgRel: results.reduce((s, r) => s + r.avgRel, 0) / n,
    countImp7: results.reduce((s, r) => s + r.countImp7, 0) / n,
    precImp7: results.reduce((s, r) => s + r.precImp7, 0) / n,
    recallImp7: results.reduce((s, r) => s + r.recallImp7, 0) / n,
    precImp8: results.reduce((s, r) => s + r.precImp8, 0) / n,
    recallImp8: results.reduce((s, r) => s + r.recallImp8, 0) / n,
    noisePct: results.reduce((s, r) => s + r.noisePct, 0) / n,
  };
}

// ─── Display ─────────────────────────────────────────────────────────

const HDR = `${"strategy".padEnd(28)}${"n".padEnd(6)}${"avgRel".padEnd(8)}${"P@7".padEnd(8)}${"R@7".padEnd(8)}${"P@8".padEnd(8)}${"R@8".padEnd(8)}${"noise%"}`;

function fmtRow(name: string, m: Metrics): string {
  return (
    `${name.padEnd(28)}` +
    `${String(Math.round(m.n)).padEnd(6)}` +
    `${m.avgRel.toFixed(2).padEnd(8)}` +
    `${(m.precImp7 * 100).toFixed(1).padStart(5)}%  ` +
    `${(m.recallImp7 * 100).toFixed(1).padStart(5)}%  ` +
    `${(m.precImp8 * 100).toFixed(1).padStart(5)}%  ` +
    `${(m.recallImp8 * 100).toFixed(1).padStart(5)}%  ` +
    `${(m.noisePct * 100).toFixed(0).padStart(3)}%`
  );
}

// ─── Part 1: Embedding top-K ─────────────────────────────────────────

console.log("═".repeat(90));
console.log("PART 1 — TOP-K BY EMBEDDING SCORE");
console.log("═".repeat(90));
console.log(HDR);
console.log("─".repeat(90));

const topKValues = [20, 50, 100, 200, 300, 500];

for (const k of topKValues) {
  const perEvent = events.map((ev) => {
    const selected = ev.emails.slice(0, k); // already sorted by embedding desc
    return evaluate(selected, ev);
  });
  console.log(fmtRow(`emb_top${k}`, avg(perEvent)));
}

// ─── Part 2: Rerank top-K (from top 200 by embedding) ────────────────

console.log(`\n${"═".repeat(90)}`);
console.log("PART 2 — TOP-K BY RERANK SCORE (from top 200 candidates)");
console.log("═".repeat(90));
console.log(HDR);
console.log("─".repeat(90));

const rerankKValues = [20, 50, 100, 200];

for (const k of rerankKValues) {
  const perEvent = events.map((ev) => {
    const withRerank = ev.emails.filter((e) => e.rerankScore !== null);
    const sorted = [...withRerank].sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
    return evaluate(sorted.slice(0, k), ev);
  });
  console.log(fmtRow(`rerank_top${k}`, avg(perEvent)));
}

// ─── Part 3: Direct comparison emb vs rerank at same K ───────────────

console.log(`\n${"═".repeat(90)}`);
console.log("PART 3 — EMBEDDING vs RERANK (same K, head-to-head)");
console.log("═".repeat(90));
console.log(`${"K".padEnd(6)}${"".padEnd(4)}${"avgRel".padEnd(9)}${"R@7".padEnd(9)}${"R@8".padEnd(9)}${"nDCG@20".padEnd(9)}${"noise%"}`);
console.log("─".repeat(90));

for (const k of [20, 50, 100, 200]) {
  // Embedding
  const embPerEvent = events.map((ev) => evaluate(ev.emails.slice(0, k), ev));
  const embAvg = avg(embPerEvent);

  // Rerank
  const rerankPerEvent = events.map((ev) => {
    const withRerank = ev.emails.filter((e) => e.rerankScore !== null);
    const sorted = [...withRerank].sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
    return evaluate(sorted.slice(0, k), ev);
  });
  const rerankAvg = avg(rerankPerEvent);

  const dRel = rerankAvg.avgRel - embAvg.avgRel;
  const dR7 = (rerankAvg.recallImp7 - embAvg.recallImp7) * 100;
  const dR8 = (rerankAvg.recallImp8 - embAvg.recallImp8) * 100;

  console.log(
    `${String(k).padEnd(6)}` +
    `${"emb".padEnd(4)}` +
    `${embAvg.avgRel.toFixed(2).padEnd(9)}` +
    `${(embAvg.recallImp7 * 100).toFixed(1).padStart(5)}%   ` +
    `${(embAvg.recallImp8 * 100).toFixed(1).padStart(5)}%   ` +
    `${embAvg.nDCG20.toFixed(3).padEnd(9)}` +
    `${(embAvg.noisePct * 100).toFixed(0).padStart(3)}%`
  );
  console.log(
    `${"".padEnd(6)}` +
    `${"rer".padEnd(4)}` +
    `${rerankAvg.avgRel.toFixed(2).padEnd(9)}` +
    `${(rerankAvg.recallImp7 * 100).toFixed(1).padStart(5)}%   ` +
    `${(rerankAvg.recallImp8 * 100).toFixed(1).padStart(5)}%   ` +
    `${rerankAvg.nDCG20.toFixed(3).padEnd(9)}` +
    `${(rerankAvg.noisePct * 100).toFixed(0).padStart(3)}%`
  );
  console.log(
    `${"".padEnd(6)}` +
    `${"Δ".padEnd(4)}` +
    `${(dRel >= 0 ? "+" : "") + dRel.toFixed(2).padEnd(9)}` +
    `${(dR7 >= 0 ? "+" : "") + dR7.toFixed(1).padStart(5)}pts  ` +
    `${(dR8 >= 0 ? "+" : "") + dR8.toFixed(1).padStart(5)}pts`
  );
  console.log("─".repeat(90));
}

// ─── Part 4: Threshold strategies ────────────────────────────────────

console.log(`\n${"═".repeat(90)}`);
console.log("PART 4 — EMBEDDING THRESHOLD");
console.log("═".repeat(90));
console.log(HDR);
console.log("─".repeat(90));

for (const thr of [0.55, 0.60, 0.65, 0.70]) {
  const perEvent = events.map((ev) => {
    const selected = ev.emails.filter((e) => e.embeddingScore >= thr);
    return evaluate(selected, ev);
  });
  console.log(fmtRow(`thr_${thr.toFixed(2)}`, avg(perEvent)));
}

console.log(`\n${"═".repeat(90)}`);
console.log("Done.");
db.close();
