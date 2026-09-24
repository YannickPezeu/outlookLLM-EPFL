/**
 * Moteur OpenHands — alternative au harness Claude Code (choix par requête
 * via le champ `engine` de /chat).
 *
 * Motivation : Claude Code / Agent SDK sont propriétaires (licence commerciale
 * Anthropic) — les utiliser en serveur institutionnel pour piloter un modèle
 * non-Anthropic est une zone grise juridique. OpenHands est MIT.
 *
 * Architecture : le sidecar Python (openhands-engine/, port 8792) fait tourner
 * la boucle agentique ; TOUS les tools restent ici (TypeScript) — le sidecar
 * les voit comme des proxys et rappelle POST /internal/tool-exec pour chaque
 * exécution. Une seule boîte à outils, deux harness.
 *
 *   runOpenHandsAgent()
 *     ├─ enregistre les descripteurs du run (runId → ToolDescriptor[])
 *     ├─ POST sidecar /run … stream NDJSON
 *     ├─ mappe les événements sur le MÊME contrat SSE que le moteur Claude Code
 *     └─ (pendant ce temps le sidecar rappelle /internal/tool-exec)
 */
import type { AgentEvent, RunAgentParams } from "./agent.js";
import { buildSystemPrompt, buildDpoSystemPrompt } from "./agent.js";
import { createAgentMcpServer, type ToolDescriptor, type AgentProfile } from "./tools.js";
import { getOrCreateStore, adoptStore } from "./emailRefs.js";
import { config } from "./config.js";
import { randomUUID } from "node:crypto";

// Registre des runs actifs : le sidecar rappelle avec {run_id, name, args}.
const activeRuns = new Map<string, Map<string, ToolDescriptor>>();

/** Exécute un tool pour le compte du sidecar (route /internal/tool-exec). */
export async function executeToolForRun(
  runId: string,
  name: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; result: string }> {
  const tools = activeRuns.get(runId);
  const descriptor = tools?.get(name);
  if (!descriptor) {
    return { ok: false, result: JSON.stringify({ error: `Tool inconnu ou run terminé: ${name}` }) };
  }
  try {
    console.log(`[openhands] tool ${name}(${JSON.stringify(args).slice(0, 120)})`);
    return { ok: true, result: await descriptor.execute(args) };
  } catch (err) {
    return { ok: true, result: JSON.stringify({ error: (err as Error).message }) };
  }
}

/**
 * Boucle agent via le sidecar OpenHands — même interface générateur que
 * runAgent (moteur Claude Code), pour un routage transparent dans server.ts.
 */
export async function* runOpenHandsAgent(params: RunAgentParams): AsyncGenerator<AgentEvent> {
  const profile: AgentProfile = params.profile === "dpo" ? "dpo" : "outlook";
  const refStore = params.refStore ?? getOrCreateStore(params.sessionId);

  // Même fabrique de tools que le moteur Claude Code — on ne garde que les
  // descripteurs (le serveur MCP in-process n'est pas utilisé par ce moteur).
  const { descriptors } = createAgentMcpServer({
    profile,
    graphToken: params.graphToken,
    refs: refStore,
    emitUi: params.emitUi ?? (() => {}),
    currentEmail: params.currentEmail,
    kbToken: params.kbToken,
    clientTools: params.clientTools,
  });

  const runId = randomUUID();
  activeRuns.set(runId, new Map(descriptors.map((d) => [d.name, d])));

  const systemPrompt = profile === "dpo" ? buildDpoSystemPrompt() : buildSystemPrompt(params.currentEmail);

  try {
    const resp = await fetch(`${config.openhandsUrl}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        run_id: runId,
        session_id: params.stateless ? null : params.sessionId || null,
        // Sans état : le sidecar jette la session à la fin du tour.
        ephemeral: !!params.stateless,
        images: params.images ?? [],
        system_prompt: systemPrompt,
        message: params.message,
        tools: descriptors.map((d) => ({
          name: d.name,
          description: d.description,
          parameters: d.inputSchema,
        })),
        callback_url: `http://127.0.0.1:${config.port}/internal/tool-exec`,
        max_iterations: 24,
        reasoning_effort: params.thinking === false ? "low" : null,
      }),
      signal: params.abortController?.signal,
    });

    if (!resp.ok || !resp.body) {
      const detail = await resp.text().catch(() => "");
      yield {
        type: "error",
        data: { message: `Moteur OpenHands indisponible (${resp.status}) ${detail.slice(0, 200)}` },
      };
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const mapEvent = (ev: Record<string, unknown>): AgentEvent | null => {
      switch (ev.type) {
        case "session": {
          const sid = ev.session_id as string;
          if (!params.stateless) adoptStore(sid, refStore);
          return { type: "session", data: { sessionId: sid, model: `${config.rcp.model} (openhands)` } };
        }
        case "text_delta":
          return { type: "text_delta", data: { text: ev.text } };
        case "thinking_delta":
          return { type: "thinking_delta", data: { text: ev.text } };
        case "text":
          return { type: "text", data: { text: ev.text } };
        case "tool_use":
          return { type: "tool_use", data: { id: ev.id, name: ev.name, input: ev.input } };
        case "tool_result":
          return { type: "tool_result", data: { tool_use_id: ev.tool_use_id, preview: ev.preview } };
        case "usage":
          return { type: "usage", data: { input: ev.input, output: ev.output } };
        case "result":
          return { type: "result", data: { subtype: "success", result: ev.text ?? null, sessionId: null } };
        case "error":
          return { type: "error", data: { message: ev.message } };
        default:
          return null;
      }
    };

    // Le flux OpenHands ne délimite pas les blocs de texte : on synthétise un
    // text_block_start au premier delta qui suit un résultat de tool, pour que
    // les frontends insèrent leur séparateur Markdown (même contrat que le
    // moteur Claude Code).
    let toolSinceText = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.type === "tool_result") toolSinceText = true;
          if (parsed.type === "text_delta" && toolSinceText) {
            toolSinceText = false;
            yield { type: "text_block_start", data: {} };
          }
          const mapped = mapEvent(parsed);
          if (mapped) yield mapped;
        } catch {
          /* ligne NDJSON malformée — ignorée */
        }
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      yield { type: "error", data: { message: (err as Error).message } };
    }
  } finally {
    activeRuns.delete(runId);
  }
}
