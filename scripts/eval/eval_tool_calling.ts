/**
 * Tool-calling eval harness — multi-model, multi-run.
 *
 * Replays scripted multi-turn conversations through chatCompletionWithTools
 * and checks whether the model calls the expected tool (or correctly abstains).
 *
 * Each scenario is run N times per model (default 10) to measure variance,
 * and models run in parallel with a concurrency limit.
 *
 * Usage:
 *   npx tsx scripts/eval/eval_tool_calling.ts
 *   npx tsx scripts/eval/eval_tool_calling.ts --models google/gemma-4-26B-A4B-it-bfloat16,google/gemma-4-31B-it-bfloat16
 *   npx tsx scripts/eval/eval_tool_calling.ts --runs 20 --concurrency 8
 *   npx tsx scripts/eval/eval_tool_calling.ts --only followup_
 *   npx tsx scripts/eval/eval_tool_calling.ts --json results/comparison.json
 */

import "./node_shims";

import * as fs from "fs";
import * as path from "path";
import { AgentMessage, chatCompletionWithTools, ToolCall } from "../../src/services/rcpApiService";
import { AGENT_TOOLS } from "../../src/services/agentTools";
import { buildSystemPrompt } from "../../src/services/agentService";
import { SKILL_CATALOG } from "../../src/skills/skillRegistry";
import { SCENARIOS, ToolCallScenario } from "./scenarios/tool_calling_scenarios";
import { config } from "../../src/config";

// ─── Bridge tools: tools that are safe to execute offline during eval ──
// These are deterministic, no-side-effect tools used as intermediate steps.
// When the model calls them, we execute, feed back the result, and re-ask
// until the model picks a non-bridge tool (or gives up).

const BRIDGE_TOOLS = new Set(["load_skill"]);
const MAX_BRIDGE_HOPS = 3;

function executeLoadSkill(args: Record<string, unknown>): string {
  const skillId = args.skill_id as string;
  const skill = SKILL_CATALOG.find((s) => s.id === skillId);
  if (!skill) {
    return JSON.stringify({ error: `Skill inconnu: ${skillId}` });
  }
  const filePath = path.resolve(__dirname, "../../assets/skills", skill.file);
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.stringify({ skill_id: skillId, instructions: content });
}

function executeBridgeTool(name: string, args: Record<string, unknown>): string {
  if (name === "load_skill") return executeLoadSkill(args);
  return JSON.stringify({ error: `Bridge tool inconnu: ${name}` });
}

// ─── CLI args ────────────────────────────────────────────────────────

function getArg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function getArgAll(name: string): string[] {
  const values: string[] = [];
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1]) values.push(args[++i]);
  }
  return values;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// Accept any of: --model X --model Y, --models A,B,C, --models "A B C" (PowerShell-safe).
// Split on comma OR whitespace to survive PS array flattening.
const rawModels = [...getArgAll("model"), ...getArgAll("models")];
const models = rawModels.length > 0
  ? rawModels.flatMap((m) => m.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))
  : [config.rcp.defaultModel];
const runs = parseInt(getArg("runs", "10")!, 10);
const concurrency = parseInt(getArg("concurrency", "5")!, 10);
const onlyPattern = getArg("only");
const jsonOut = getArg("json");
const verbose = hasFlag("verbose") || hasFlag("v");
// When true, strip assistant.tool_calls and tool messages from scenario histories —
// simulates the PRE-fix behavior where tool results were dropped between turns.
// Useful for A/B-testing the PRESERVED_TOOLS fix impact.
const stripToolHistory = hasFlag("strip-tool-history");

function stripTools(history: AgentMessage[]): AgentMessage[] {
  return history
    .filter((m) => m.role !== "tool")
    .map((m) => {
      if (m.role === "assistant" && m.tool_calls) {
        // Drop tool_calls; keep any text content
        return { role: "assistant", content: m.content ?? null } as AgentMessage;
      }
      return m;
    })
    // After stripping tool_calls, assistant messages with no content and no tool_calls are empty noise
    .filter((m) => !(m.role === "assistant" && !m.content && !m.tool_calls));
}

// ─── Single-call execution ───────────────────────────────────────────

interface ChainStep {
  tool: string;
  args: Record<string, unknown> | null;
}

interface SingleResult {
  model: string;
  scenario: string;
  run: number;
  expected: string | null;
  got: string | null;                 // final (post-bridges) tool name
  gotArgs: Record<string, unknown> | null;
  chain: ChainStep[];                 // full sequence of tool calls, including bridges
  pass: boolean;
  argsOk: boolean | null;
  error?: string;
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

async function runOnce(s: ToolCallScenario, model: string, runIdx: number): Promise<SingleResult> {
  const history = stripToolHistory ? stripTools(s.history) : s.history;
  const messages: AgentMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    ...history,
    { role: "user", content: s.nextUserMessage },
  ];

  const chain: ChainStep[] = [];
  let finalToolCall: ToolCall | undefined;

  try {
    for (let hop = 0; hop <= MAX_BRIDGE_HOPS; hop++) {
      const resp = await chatCompletionWithTools(messages, AGENT_TOOLS, model);
      const msg = resp.choices[0]?.message;
      const toolCall = msg?.tool_calls?.[0];

      if (!toolCall) {
        // Model answered in text without calling any tool — stop.
        break;
      }

      const args = parseArgs(toolCall.function.arguments);
      chain.push({ tool: toolCall.function.name, args });

      if (!BRIDGE_TOOLS.has(toolCall.function.name)) {
        // Non-bridge tool reached — this is the "real" tool call we evaluate.
        finalToolCall = toolCall;
        break;
      }

      if (hop === MAX_BRIDGE_HOPS) {
        // Stuck calling bridges — give up.
        break;
      }

      // Execute the bridge tool and append the response, then loop.
      const toolResult = executeBridgeTool(toolCall.function.name, args ?? {});
      messages.push({
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: [toolCall],
      });
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolResult,
      });
    }
  } catch (err) {
    return {
      model,
      scenario: s.name,
      run: runIdx,
      expected: s.expected.tool,
      got: null,
      gotArgs: null,
      chain,
      pass: false,
      argsOk: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const got = finalToolCall?.function.name ?? null;
  const gotArgs = finalToolCall ? parseArgs(finalToolCall.function.arguments) : null;

  const toolMatches = got === s.expected.tool;
  let argsOk: boolean | null = null;
  if (toolMatches && s.expected.argsCheck) {
    argsOk = gotArgs !== null && s.expected.argsCheck(gotArgs);
  }
  const pass = toolMatches && (argsOk === null || argsOk === true);

  return {
    model,
    scenario: s.name,
    run: runIdx,
    expected: s.expected.tool,
    got,
    gotArgs,
    chain,
    pass,
    argsOk,
  };
}

// ─── Concurrency-limited task pool ───────────────────────────────────

async function runPool<T>(tasks: Array<() => Promise<T>>, limit: number, onDone?: (t: T) => void): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;

  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= tasks.length) return;
      const r = await tasks[idx]();
      results[idx] = r;
      onDone?.(r);
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─── Aggregation ────────────────────────────────────────────────────

interface CellStats {
  passes: number;
  total: number;
  errors: number;
}

function aggregate(results: SingleResult[]): Map<string, Map<string, CellStats>> {
  // model -> scenario -> stats
  const byModel = new Map<string, Map<string, CellStats>>();
  for (const r of results) {
    if (!byModel.has(r.model)) byModel.set(r.model, new Map());
    const byScenario = byModel.get(r.model)!;
    if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, { passes: 0, total: 0, errors: 0 });
    const cell = byScenario.get(r.scenario)!;
    cell.total++;
    if (r.pass) cell.passes++;
    if (r.error) cell.errors++;
  }
  return byModel;
}

function shortModelName(fullName: string): string {
  const last = fullName.includes("/") ? fullName.split("/").pop()! : fullName;
  return last.length > 24 ? last.slice(0, 22) + ".." : last;
}

// ─── Display ────────────────────────────────────────────────────────

function renderTable(
  scenarios: ToolCallScenario[],
  modelList: string[],
  stats: Map<string, Map<string, CellStats>>
): string {
  const scenarioCol = Math.max(24, ...scenarios.map((s) => s.name.length)) + 2;
  const modelCols = modelList.map(shortModelName);
  const colWidth = Math.max(9, ...modelCols.map((m) => m.length)) + 2;

  const lines: string[] = [];
  // Header
  let header = "Scénario".padEnd(scenarioCol);
  for (const m of modelCols) header += m.padEnd(colWidth);
  lines.push(header);
  lines.push("─".repeat(header.length));

  // Rows
  for (const s of scenarios) {
    let row = s.name.padEnd(scenarioCol);
    for (const model of modelList) {
      const cell = stats.get(model)?.get(s.name);
      if (!cell) {
        row += "—".padEnd(colWidth);
        continue;
      }
      const rate = cell.total > 0 ? Math.round((cell.passes / cell.total) * 100) : 0;
      const cellStr = `${cell.passes}/${cell.total} (${rate}%)`;
      row += cellStr.padEnd(colWidth);
    }
    lines.push(row);
  }

  // Global row
  lines.push("─".repeat(header.length));
  let total = "TOTAL".padEnd(scenarioCol);
  for (const model of modelList) {
    const cells = Array.from(stats.get(model)?.values() ?? []);
    const passes = cells.reduce((a, c) => a + c.passes, 0);
    const totals = cells.reduce((a, c) => a + c.total, 0);
    const rate = totals > 0 ? Math.round((passes / totals) * 100) : 0;
    total += `${passes}/${totals} (${rate}%)`.padEnd(colWidth);
  }
  lines.push(total);

  return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const filtered = onlyPattern
    ? SCENARIOS.filter((s) => new RegExp(onlyPattern).test(s.name))
    : SCENARIOS;

  if (filtered.length === 0) {
    console.error(`Aucun scénario ne matche /${onlyPattern}/`);
    process.exit(1);
  }

  const totalCalls = models.length * filtered.length * runs;
  console.log(`Modèles (${models.length}) :`);
  for (const m of models) console.log(`  - ${m}`);
  console.log(`Scénarios : ${filtered.length}/${SCENARIOS.length}  |  Runs par scénario : ${runs}  |  Concurrency : ${concurrency}`);
  if (stripToolHistory) console.log(`⚠️  Mode --strip-tool-history : les tool_calls/tool results sont retirés de l'historique (simule le comportement pré-fix).`);
  console.log(`Appels total : ${totalCalls}`);
  console.log("─".repeat(80));

  // Build task list: (model × scenario × run)
  const tasks: Array<() => Promise<SingleResult>> = [];
  for (const model of models) {
    for (const s of filtered) {
      for (let r = 0; r < runs; r++) {
        tasks.push(() => runOnce(s, model, r));
      }
    }
  }

  let done = 0;
  const startTime = Date.now();
  const results = await runPool(tasks, concurrency, (r) => {
    done++;
    if (verbose) {
      const status = r.pass ? "PASS" : r.error ? "ERR " : "FAIL";
      const chainStr = r.chain.length > 1 ? ` [chain: ${r.chain.map((c) => c.tool).join(" → ")}]` : "";
      console.log(
        `[${done}/${totalCalls}] ${status} ${shortModelName(r.model).padEnd(24)} ${r.scenario.padEnd(32)} expected=${r.expected ?? "(aucun)"} got=${r.got ?? "(aucun)"}${chainStr}`
      );
    } else if (done % 10 === 0 || done === totalCalls) {
      const pct = Math.round((done / totalCalls) * 100);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      process.stdout.write(`\r  ${done}/${totalCalls} (${pct}%) — ${elapsed}s`);
    }
  });

  if (!verbose) process.stdout.write("\n");

  // ─── Aggregate ────────────────────────────────────────────────────
  const stats = aggregate(results);
  console.log("");
  console.log(renderTable(filtered, models, stats));

  // Error summary
  const errors = results.filter((r) => r.error);
  if (errors.length > 0) {
    console.log(`\n${errors.length} erreurs API :`);
    const errorsByModel = new Map<string, number>();
    for (const e of errors) errorsByModel.set(e.model, (errorsByModel.get(e.model) ?? 0) + 1);
    for (const [m, n] of errorsByModel) console.log(`  ${shortModelName(m)} : ${n}`);
    if (verbose) {
      // Print first few distinct messages
      const seen = new Set<string>();
      for (const e of errors.slice(0, 3)) {
        if (!seen.has(e.error!)) {
          seen.add(e.error!);
          console.log(`  → ${e.error}`);
        }
      }
    }
  }

  if (jsonOut) {
    const dir = jsonOut.includes("/") ? jsonOut.slice(0, jsonOut.lastIndexOf("/")) : null;
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Build summary tables for quick reading
    const summaryByScenario: Record<string, Record<string, { passes: number; total: number; rate: number; errors: number }>> = {};
    for (const s of filtered) {
      summaryByScenario[s.name] = {};
      for (const m of models) {
        const cell = stats.get(m)?.get(s.name) ?? { passes: 0, total: 0, errors: 0 };
        summaryByScenario[s.name][m] = {
          passes: cell.passes,
          total: cell.total,
          rate: cell.total > 0 ? cell.passes / cell.total : 0,
          errors: cell.errors,
        };
      }
    }
    const summaryByModel: Record<string, { passes: number; total: number; rate: number; errors: number }> = {};
    for (const m of models) {
      const cells = Array.from(stats.get(m)?.values() ?? []);
      const passes = cells.reduce((a, c) => a + c.passes, 0);
      const total = cells.reduce((a, c) => a + c.total, 0);
      const errs = cells.reduce((a, c) => a + c.errors, 0);
      summaryByModel[m] = { passes, total, rate: total > 0 ? passes / total : 0, errors: errs };
    }

    // Flat table (1 row per scenario × model) — easy to import in a spreadsheet
    const table: Array<{ scenario: string; model: string; passes: number; total: number; rate: number; errors: number }> = [];
    for (const s of filtered) {
      for (const m of models) {
        const cell = summaryByScenario[s.name][m];
        table.push({ scenario: s.name, model: m, ...cell });
      }
    }

    fs.writeFileSync(
      jsonOut,
      JSON.stringify(
        {
          models,
          runs,
          timestamp: new Date().toISOString(),
          summary: {
            byModel: summaryByModel,
            byScenario: summaryByScenario,
            table,
          },
          scenarios: filtered.map((s) => ({ name: s.name, expected: s.expected.tool, description: s.description })),
          results,
        },
        null,
        2
      )
    );
    console.log(`\nJSON écrit : ${jsonOut}`);
  }

  // Exit code: 0 if every scenario has >50% pass rate on every model
  const allHealthy = Array.from(stats.values()).every((byScenario) =>
    Array.from(byScenario.values()).every((c) => c.total > 0 && c.passes / c.total > 0.5)
  );
  process.exit(allHealthy ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
