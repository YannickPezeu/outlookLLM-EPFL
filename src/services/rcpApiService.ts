import { config } from "../config";

// ─── Types ───────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// Extended message type for agent loop (supports tool calling)
export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string; // required when role === "tool"
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: { role: string; content: string; reasoning_content?: string };
    finish_reason: string;
  }>;
}

export interface ToolCallResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
}

// ─── RCP API Client ──────────────────────────────────────────────────

function getRcpConfig() {
  // Allow runtime override from localStorage (user settings in UI)
  const storedUrl = localStorage.getItem("rcp_base_url");
  const storedKey = localStorage.getItem("rcp_api_key");
  const storedModel = localStorage.getItem("rcp_model");

  return {
    baseUrl: storedUrl || config.rcp.baseUrl,
    apiKey: storedKey || config.rcp.apiKey,
    model: storedModel || config.rcp.defaultModel,
  };
}

// Max context window (tokens) per model family — probed on RCP (2026-06):
// Kimi-K2.6 = 262144, gpt-oss-120b = 131072, Mistral-Small-3.2 = 131072.
const MODEL_CONTEXT_TOKENS: Array<[RegExp, number]> = [
  [/kimi-k2/i, 262144],
  [/gpt-oss/i, 131072],
  [/mistral-small|ministral|magistral|devstral/i, 131072],
  [/gemma-4|gemma-3-27|gemma-3-1b/i, 131072],
];
const DEFAULT_CONTEXT_TOKENS = 131072; // conservative floor for the models we use

/** Max context window (tokens) of the active (or given) model. */
export function getModelMaxContextTokens(model?: string): number {
  const m = model || getRcpConfig().model || "";
  for (const [re, tok] of MODEL_CONTEXT_TOKENS) if (re.test(m)) return tok;
  return DEFAULT_CONTEXT_TOKENS;
}

/**
 * Character budget for stuffing content (emails, attachments) into a single
 * prompt for the ACTIVE model, leaving room for the prompt structure + streamed
 * output. ~2.3 chars/token keeps ≈40% headroom over the real ~4 chars/token.
 */
export function getContextBudgetChars(model?: string): number {
  return Math.floor(getModelMaxContextTokens(model) * 2.3);
}

/**
 * Middle-out truncate a string to at most maxChars: keep the head and tail
 * (where the salient context usually sits) and replace the middle with a marker
 * so the model knows content was dropped (and doesn't treat the join as seamless).
 */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  const marker = `\n\n[⚠️ CONTENU TRONQUÉ : ~${omitted} caractères omis au milieu pour tenir dans la fenêtre de contexte du modèle]\n\n`;
  const keep = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(text.length - tail) : "");
}

/**
 * Single backstop that enforces the active model's input-character budget across
 * the WHOLE message array — every email body, attachment, tool result and agent
 * turn we ever stuff into a prompt passes through here (via buildChatBody).
 *
 * Water-filling: small messages (system prompt, instructions) are kept intact;
 * only the largest messages are middle-out truncated, down to a uniform cap,
 * until the total fits the budget. Returns NEW message objects and never mutates
 * the caller's array (the agent loop reuses it across turns).
 */
function truncateMessagesToBudget<T extends { content: string | null }>(
  messages: T[],
  model: string
): T[] {
  const budget = getContextBudgetChars(model);
  const sizes = messages.map((m) => m.content?.length ?? 0);
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= budget) return messages;

  // Find the uniform per-message cap C such that Σ min(size_i, C) ≤ budget.
  const sorted = [...sizes].sort((a, b) => a - b);
  let remaining = budget;
  let cap = Infinity;
  for (let i = 0; i < sorted.length; i++) {
    const fairShare = remaining / (sorted.length - i);
    if (sorted[i] <= fairShare) {
      remaining -= sorted[i];
    } else {
      cap = Math.floor(fairShare);
      break;
    }
  }
  if (!isFinite(cap)) return messages;

  return messages.map((m) =>
    m.content && m.content.length > cap
      ? { ...m, content: truncateMiddle(m.content, cap) }
      : m
  );
}

// Reasoning models served by RCP (self-hosted vLLM) emit a chain-of-thought
// before the answer/tool call. We don't need it for tool orchestration or
// summaries and it adds large latency (minutes on long context → timeouts), and
// our SSE parser discards reasoning_content anyway. Kimi's chat template gates
// reasoning on a boolean `thinking` kwarg passed via chat_template_kwargs.
// NOTE: it is `thinking`, NOT `enable_thinking` (that's the Qwen3 convention and
// is silently ignored by Kimi). Each model family has its own key, so we scope by
// model name. Verified on RCP 2026-05-28 (DPO-Agent probe_kimi_thinking.py):
// chat_template_kwargs.thinking=false → 0 reasoning chars, ~1s vs 2-4s.
function applyModelTweaks(body: Record<string, unknown>): Record<string, unknown> {
  const model = typeof body.model === "string" ? body.model : "";
  if (/kimi-k2/i.test(model)) {
    const existing = (body.chat_template_kwargs as Record<string, unknown>) ?? {};
    body.chat_template_kwargs = { ...existing, thinking: false };
    // Moonshot's published spec for NON-thinking mode requires these sampling
    // params (temperature 0.6, top_p 0.95, n 1, presence_penalty 0.0). Sending a
    // lower temperature (e.g. our default 0.3) can error or degrade output, so we
    // override them for Kimi only. See DPO-Agent docs/disable-kimi-thinking-rcp.md.
    body.temperature = 0.6;
    body.top_p = 0.95;
    body.n = 1;
    body.presence_penalty = 0.0;
  }
  return body;
}

/**
 * Build a chat/completions request body shared by all RCP calls, so request
 * params (temperature, max_tokens, per-model tweaks) live in one place.
 */
function buildChatBody(opts: {
  model: string;
  messages: ChatMessage[] | AgentMessage[];
  stream: boolean;
  tools?: ToolDefinition[];
  maxTokens?: number;
}): Record<string, unknown> {
  // Single enforcement point for the model's input budget: middle-out truncate
  // anything that would overflow the context window, regardless of which feature
  // built the prompt.
  const messages = truncateMessagesToBudget(
    opts.messages as Array<ChatMessage | AgentMessage>,
    opts.model
  );

  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    temperature: 0.3,
    max_tokens: opts.maxTokens ?? 8192,
    stream: opts.stream,
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }
  return applyModelTweaks(body);
}

/**
 * Send a chat completion request to the RCP API (OpenAI-compatible).
 * Returns the full response.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  model?: string,
  maxTokens: number = 8192
): Promise<ChatCompletionResponse> {
  const cfg = getRcpConfig();

  if (!cfg.apiKey) {
    throw new Error("Clé API RCP non configurée. Allez dans l'onglet Config pour la saisir.");
  }

  console.log("[RCP] Request to:", `${cfg.baseUrl}${config.rcp.completionsEndpoint}`);
  console.log("[RCP] API key starts with:", cfg.apiKey.slice(0, 6) + "...");
  console.log("[RCP] Model:", cfg.model);

  const response = await fetch(`${cfg.baseUrl}${config.rcp.completionsEndpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(buildChatBody({ model: model || cfg.model, messages, stream: false, maxTokens })),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`RCP API error ${response.status}: ${errorText}`);
  }

  return response.json();
}

/**
 * Extract text content from a chat completion response.
 * Handles thinking models that may put output in reasoning_content.
 */
function extractContent(response: ChatCompletionResponse): string {
  const message = response.choices[0]?.message;
  if (!message) return "Pas de réponse.";
  return message.content || message.reasoning_content || "Pas de réponse.";
}

/**
 * Send a streaming chat completion request. Calls onChunk for each text delta.
 * Returns the full accumulated text.
 */
export async function chatCompletionStream(
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  model?: string,
  signal?: AbortSignal
): Promise<string> {
  const cfg = getRcpConfig();

  if (!cfg.apiKey) {
    throw new Error("Clé API RCP non configurée. Allez dans l'onglet Config pour la saisir.");
  }

  const response = await fetch(`${cfg.baseUrl}${config.rcp.completionsEndpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(buildChatBody({ model: model || cfg.model, messages, stream: true })),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`RCP API error ${response.status}: ${errorText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE lines
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;

      const data = trimmed.slice(6);
      if (data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          onChunk(delta);
        }
      } catch {
        // Skip malformed SSE chunks
      }
    }
  }

  return fullText;
}

/**
 * Send a chat completion request with tool definitions (for agent loop).
 * Non-streaming — we need to parse tool_calls from the response.
 */
export async function chatCompletionWithTools(
  messages: AgentMessage[],
  tools: ToolDefinition[],
  model?: string,
  signal?: AbortSignal
): Promise<ToolCallResponse> {
  const cfg = getRcpConfig();

  if (!cfg.apiKey) {
    throw new Error("Clé API RCP non configurée. Allez dans l'onglet Config pour la saisir.");
  }

  const body = buildChatBody({ model: model || cfg.model, messages, stream: false, tools });

  console.log("[RCP] Tool-calling request, tools:", tools.map((t) => t.function.name));

  const response = await fetch(`${cfg.baseUrl}${config.rcp.completionsEndpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`RCP API error ${response.status}: ${errorText}`);
  }

  return response.json();
}

/**
 * Streaming chat completion that accepts AgentMessage[] (for final agent response).
 */
export async function chatCompletionStreamAgent(
  messages: AgentMessage[],
  onChunk: (text: string) => void,
  model?: string
): Promise<string> {
  // Reuse the existing streaming logic by casting — AgentMessage is a superset of ChatMessage
  return chatCompletionStream(messages as ChatMessage[], onChunk, model);
}

/**
 * Streaming chat completion with tool support.
 * Streams content tokens in real-time via onChunk, and accumulates tool_calls if present.
 * Returns the final message (content + optional tool_calls).
 */
export async function chatCompletionWithToolsStream(
  messages: AgentMessage[],
  tools: ToolDefinition[],
  onChunk: (text: string) => void,
  model?: string,
  signal?: AbortSignal
): Promise<{
  message: { role: string; content: string | null; tool_calls?: ToolCall[] };
  finish_reason: string;
}> {
  const cfg = getRcpConfig();

  if (!cfg.apiKey) {
    throw new Error("Clé API RCP non configurée. Allez dans l'onglet Config pour la saisir.");
  }

  const body = buildChatBody({ model: model || cfg.model, messages, stream: true, tools });

  console.log("[RCP] Streaming tool-calling request, tools:", tools.map((t) => t.function.name));

  const response = await fetch(`${cfg.baseUrl}${config.rcp.completionsEndpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`RCP API error ${response.status}: ${errorText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let finishReason = "stop";

  // Accumulate tool calls by index
  const toolCallsMap = new Map<number, { id: string; type: "function"; function: { name: string; arguments: string } }>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;

      const data = trimmed.slice(6);
      if (data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data);
        const choice = parsed.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }

        const delta = choice.delta;
        if (!delta) continue;

        // Stream content tokens
        if (delta.content) {
          fullContent += delta.content;
          onChunk(delta.content);
        }

        // Accumulate tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallsMap.has(idx)) {
              toolCallsMap.set(idx, {
                id: tc.id || "",
                type: "function",
                function: { name: tc.function?.name || "", arguments: "" },
              });
            }
            const existing = toolCallsMap.get(idx)!;
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.function.name = tc.function.name;
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
          }
        }
      } catch {
        // Skip malformed SSE chunks
      }
    }
  }

  const toolCalls = toolCallsMap.size > 0
    ? Array.from(toolCallsMap.values())
    : undefined;

  // vLLM bug: certains modèles (Mistral 3.2 sur RCP) émettent un stream complètement
  // vide quand ils décident d'appeler un outil — le tool-call parser streaming avale
  // la sortie. Détection : tools fournis, stream sans contenu et sans tool_calls.
  // Fallback : refaire l'appel en non-streaming, qui retourne bien les tool_calls.
  if (tools.length > 0 && !toolCalls && !fullContent) {
    console.warn("[RCP] Stream empty (likely vLLM tool-call parser issue), retrying non-streaming");
    const fallback = await chatCompletionWithTools(messages, tools, model, signal);
    const choice = fallback.choices[0];
    return {
      message: {
        role: choice.message.role,
        content: choice.message.content,
        tool_calls: choice.message.tool_calls,
      },
      finish_reason: choice.finish_reason,
    };
  }

  return {
    message: {
      role: "assistant",
      content: fullContent || null,
      tool_calls: toolCalls,
    },
    finish_reason: finishReason,
  };
}

// ─── OCR (vision LLM) ────────────────────────────────────────────────

// Prompt mirrors DPO-Agent's PaddleOCR-VL prompt: raw text, no commentary, no
// markdown fences, reading order preserved.
const OCR_PROMPT =
  "OCR this page. Return the full text exactly as written, preserving line " +
  "breaks and reading order. No commentary, no markdown fences.";

// A dense A4 French page ≈ 1000 completion tokens; 6000 gives headroom without
// making a runaway repetition loop dramatically worse (attachmentService's
// degenerate-output detector is the real safety net).
const OCR_MAX_TOKENS = 6000;

/**
 * OCR a single page image via the RCP vision model (PaddleOCR-VL).
 * `imageDataUrl` must be a full data URL (e.g. "data:image/png;base64,...").
 * Returns the extracted text, or throws on network/HTTP/parse failure so the
 * caller can fall back (skip the page) rather than poison the result silently.
 */
export async function ocrImageViaRcp(
  imageDataUrl: string,
  signal?: AbortSignal
): Promise<string> {
  const cfg = getRcpConfig();

  if (!cfg.apiKey) {
    throw new Error("Clé API RCP non configurée. Allez dans l'onglet Config pour la saisir.");
  }

  const body = {
    model: config.rcp.ocrModel,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: OCR_PROMPT },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
    max_tokens: OCR_MAX_TOKENS,
    temperature: 0,
    stream: false,
  };

  const response = await fetch(`${cfg.baseUrl}${config.rcp.completionsEndpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`RCP OCR error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  return typeof text === "string" ? text.trim() : "";
}

// ─── High-level functions ────────────────────────────────────────────

/**
 * Summarize all interactions with a specific person.
 *
 * Deduplicates by conversationId (keeps only the most recent email per thread,
 * which contains the full reply chain in its body). Uses cleanEmailBodyFull()
 * to strip HTML while preserving reply chains for full context.
 */
export async function summarizeInteractions(
  personName: string,
  personEmail: string,
  emails: Array<{
    subject: string;
    body: string;
    date: string;
    direction: "sent" | "received" | "servicedesk";
    conversationId?: string;
  }>,
  onChunk?: (text: string) => void,
  model?: string,
  signal?: AbortSignal
): Promise<string> {
  if (emails.length === 0) {
    return `Aucun échange trouvé avec ${personName}.`;
  }

  // Deduplicate by conversationId — keep only the most recent per thread
  const sorted = [...emails].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
  const seenConversations = new Set<string>();
  const deduplicated = sorted.filter((e) => {
    if (!e.conversationId) return true; // keep emails without conversationId
    if (seenConversations.has(e.conversationId)) return false;
    seenConversations.add(e.conversationId);
    return true;
  });

  // Clean bodies — cleanEmailBodyFull preserves reply chains
  const { cleanEmailBodyFull } = await import("./cleanEmailBody");

  const digest = deduplicated
    .map((e) => {
      const tag = e.direction === "sent" ? `À ${personName}` :
                  e.direction === "servicedesk" ? `[ServiceNow]` :
                  `De ${personName}`;
      const cleanBody = cleanEmailBodyFull(e.body);
      return `[${new Date(e.date).toLocaleDateString("fr-FR")}] ${tag}\nSujet: ${e.subject}\n${cleanBody}`;
    })
    .join("\n---\n");

  const today = new Date().toLocaleDateString("fr-FR", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const customPrompt = getUserCustomPrompt();
  const customContext = customPrompt
    ? `\n\nContexte fourni par l'utilisateur (adapte le ton et le focus du résumé en conséquence) :\n${customPrompt}`
    : "";

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `Tu es un assistant qui analyse les échanges email entre deux personnes. ` +
        `Nous sommes le ${today}. ` +
        "Fournis un résumé structuré en français qui inclut :\n" +
        "1. Un résumé global de la relation/collaboration\n" +
        "2. Les sujets principaux abordés\n" +
        "3. Les décisions importantes prises\n" +
        "4. Les points en suspens\n" +
        "5. **To-dos** : liste concrète des actions à faire suite à ces échanges " +
        "(qui doit faire quoi, avec quelle échéance si mentionnée)\n\n" +
        "Sois concis mais complet." +
        customContext,
    },
    {
      role: "user",
      content:
        `Voici les ${deduplicated.length} échanges email (dédupliqués par conversation) ` +
        `avec ${personName} (${personEmail}).\nRésume ces interactions :\n\n${digest}`,
    },
  ];

  if (onChunk) {
    return chatCompletionStream(messages, onChunk, model, signal);
  }

  const response = await chatCompletion(messages, model);
  return extractContent(response);
}

// ─── Settings persistence ────────────────────────────────────────────

export function saveRcpSettings(
  baseUrl: string,
  apiKey: string,
  model: string,
  customPrompt?: string
): void {
  localStorage.setItem("rcp_base_url", baseUrl);
  localStorage.setItem("rcp_api_key", apiKey);
  localStorage.setItem("rcp_model", model);
  if (typeof customPrompt === "string") {
    const trimmed = customPrompt.trim();
    if (trimmed) localStorage.setItem("user_custom_prompt", trimmed);
    else localStorage.removeItem("user_custom_prompt");
  }
}

export function loadRcpSettings(): {
  baseUrl: string;
  apiKey: string;
  model: string;
  customPrompt: string;
} {
  return {
    ...getRcpConfig(),
    customPrompt: getUserCustomPrompt(),
  };
}

/**
 * Free-form context the user provides in Settings (name, role, activity, recurring
 * needs) so the assistant and the email summaries can adapt their tone and focus.
 * Empty string when unset.
 */
export function getUserCustomPrompt(): string {
  return localStorage.getItem("user_custom_prompt") || "";
}

/**
 * Whether the user is, by default, a participant in the meetings they schedule.
 * Drives the `include_self` parameter of find_common_slots when the request has no
 * explicit "avec moi" / "sans moi" signal:
 *   - "include" → assume include_self=true   (typical for a manager/organizer)
 *   - "exclude" → assume include_self=false  (typical for an assistant booking for others)
 *   - null      → unset: the assistant must ASK before scheduling.
 */
export function getMeetingSelfDefault(): "include" | "exclude" | null {
  const v = localStorage.getItem("meeting_self_default");
  return v === "include" || v === "exclude" ? v : null;
}
