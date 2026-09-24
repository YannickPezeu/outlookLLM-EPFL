/**
 * Tools CLIENT : outils exécutés par le frontend (extension/add-in) à la
 * demande de l'agent — pour les capacités qui vivent dans le navigateur
 * (ex: search_local du personalRAG = RAG sur documents perso en IndexedDB).
 *
 * Mécanique (aller-retour SSE) :
 *  1. Le frontend déclare ses tools dans la requête /chat (name, description,
 *     input_schema JSON Schema plat).
 *  2. Quand l'agent appelle le tool, le serveur émet un événement SSE
 *     `client_tool_request` {call_id, name, input} et ATTEND.
 *  3. Le frontend exécute son implémentation locale et POST /tool-result
 *     {call_id, result} — la promesse se résout, l'agent continue.
 *
 * Même philosophie que les custom tools des Managed Agents Anthropic : le
 * secret/la donnée reste côté client, le serveur n'orchestre que le flux.
 */
import { randomUUID } from "node:crypto";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { UiEmitter } from "./tools.js";

export interface ClientToolDef {
  name: string;
  description: string;
  /** JSON Schema PLAT : {type:"object", properties:{x:{type,description}}, required:[]} */
  input_schema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string; items?: { type?: string } }>;
    required?: string[];
  };
}

const CLIENT_TOOL_TIMEOUT_MS = 120_000;
const MAX_CLIENT_TOOLS = 10;

// Corrélation call_id → résolution. Les call_id sont des UUID : pas besoin de
// scoper par session, une collision est impossible en pratique.
const pendingCalls = new Map<string, { resolve: (v: { result: string; isError: boolean }) => void; timer: NodeJS.Timeout }>();

/** Appelé par la route POST /tool-result quand le frontend renvoie un résultat. */
export function resolveClientToolCall(callId: string, result: string, isError = false): boolean {
  const pending = pendingCalls.get(callId);
  if (!pending) return false;
  pendingCalls.delete(callId);
  clearTimeout(pending.timer);
  pending.resolve({ result, isError });
  return true;
}

/** Conversion JSON Schema plat → shape zod (types simples uniquement). */
function schemaToZodShape(schema?: ClientToolDef["input_schema"]): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const props = schema?.properties || {};
  const required = new Set(schema?.required || []);
  for (const [key, prop] of Object.entries(props)) {
    let zt: z.ZodTypeAny;
    switch (prop.type) {
      case "number":
      case "integer":
        zt = z.number();
        break;
      case "boolean":
        zt = z.boolean();
        break;
      case "array":
        zt = z.array(prop.items?.type === "number" ? z.number() : z.string());
        break;
      default:
        zt = z.string();
    }
    if (prop.description) zt = zt.describe(prop.description);
    if (!required.has(key)) zt = zt.optional();
    shape[key] = zt;
  }
  return shape;
}

/** Exécution d'un tool client : émet la demande SSE et attend le POST /tool-result. */
async function executeClientToolCall(
  def: ClientToolDef,
  args: Record<string, unknown>,
  emitUi: UiEmitter
): Promise<{ result: string; isError: boolean }> {
  const callId = randomUUID();
  console.log(`[client-tool] ${def.name}(${JSON.stringify(args).slice(0, 120)}) → attente frontend (${callId.slice(0, 8)})`);

  return new Promise<{ result: string; isError: boolean }>((resolve) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(callId);
      resolve({
        result: JSON.stringify({ error: `Le frontend n'a pas répondu en ${CLIENT_TOOL_TIMEOUT_MS / 1000}s pour ${def.name}.` }),
        isError: true,
      });
    }, CLIENT_TOOL_TIMEOUT_MS);
    pendingCalls.set(callId, { resolve, timer });
    emitUi("client_tool_request", { call_id: callId, name: def.name, input: args });
  });
}

/** Descripteur moteur-agnostique (même forme que ToolDescriptor de tools.ts). */
export interface ClientToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

/** Construit les tools MCP « pont » + leurs descripteurs à partir des déclarations du frontend. */
export function buildClientTools(defs: ClientToolDef[], emitUi: UiEmitter) {
  const valid = defs
    .slice(0, MAX_CLIENT_TOOLS)
    .filter((d) => d.name && /^[a-zA-Z0-9_-]{1,64}$/.test(d.name) && d.description);

  const tools = valid.map((def) =>
    tool(def.name, def.description.slice(0, 2000), schemaToZodShape(def.input_schema), async (args) => {
      const outcome = await executeClientToolCall(def, args as Record<string, unknown>, emitUi);
      return {
        content: [{ type: "text" as const, text: outcome.result }],
        ...(outcome.isError ? { isError: true } : {}),
      };
    })
  );

  const descriptors: ClientToolDescriptor[] = valid.map((def) => ({
    name: def.name,
    description: def.description.slice(0, 2000),
    // Le schéma du frontend est déjà du JSON Schema — transmis tel quel
    inputSchema: (def.input_schema as Record<string, unknown>) || { type: "object", properties: {} },
    execute: async (args) => (await executeClientToolCall(def, args, emitUi)).result,
  }));

  return { tools, descriptors };
}
