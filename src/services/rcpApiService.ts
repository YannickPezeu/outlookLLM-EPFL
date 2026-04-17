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

/**
 * Send a chat completion request to the RCP API (OpenAI-compatible).
 * Returns the full response.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  model?: string
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
    body: JSON.stringify({
      model: model || cfg.model,
      messages,
      temperature: 0.3,
      max_tokens: 8192,
      stream: false,
    }),
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
  model?: string
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
    body: JSON.stringify({
      model: model || cfg.model,
      messages,
      temperature: 0.3,
      max_tokens: 8192,
      stream: true,
    }),
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
  model?: string
): Promise<ToolCallResponse> {
  const cfg = getRcpConfig();

  if (!cfg.apiKey) {
    throw new Error("Clé API RCP non configurée. Allez dans l'onglet Config pour la saisir.");
  }

  const body: Record<string, unknown> = {
    model: model || cfg.model,
    messages,
    temperature: 0.3,
    max_tokens: 8192,
    stream: false,
  };

  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  console.log("[RCP] Tool-calling request, tools:", tools.map((t) => t.function.name));

  const response = await fetch(`${cfg.baseUrl}${config.rcp.completionsEndpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
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
  model?: string
): Promise<{
  message: { role: string; content: string | null; tool_calls?: ToolCall[] };
  finish_reason: string;
}> {
  const cfg = getRcpConfig();

  if (!cfg.apiKey) {
    throw new Error("Clé API RCP non configurée. Allez dans l'onglet Config pour la saisir.");
  }

  const body: Record<string, unknown> = {
    model: model || cfg.model,
    messages,
    temperature: 0.3,
    max_tokens: 8192,
    stream: true,
  };

  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  console.log("[RCP] Streaming tool-calling request, tools:", tools.map((t) => t.function.name));

  const response = await fetch(`${cfg.baseUrl}${config.rcp.completionsEndpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
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

  return {
    message: {
      role: "assistant",
      content: fullContent || null,
      tool_calls: toolCalls,
    },
    finish_reason: finishReason,
  };
}

// ─── High-level functions ────────────────────────────────────────────

/**
 * Summarize a single email body.
 */
export async function summarizeEmail(
  emailBody: string,
  onChunk?: (text: string) => void
): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "Tu es un assistant qui résume des emails de manière concise et structurée en français. " +
        "Identifie les points clés, les actions demandées, et les décisions prises.",
    },
    {
      role: "user",
      content: `Résume cet email :\n\n${emailBody}`,
    },
  ];

  if (onChunk) {
    return chatCompletionStream(messages, onChunk);
  }

  const response = await chatCompletion(messages);
  return extractContent(response);
}

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
  model?: string
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
        "Sois concis mais complet.",
    },
    {
      role: "user",
      content:
        `Voici les ${deduplicated.length} échanges email (dédupliqués par conversation) ` +
        `avec ${personName} (${personEmail}).\nRésume ces interactions :\n\n${digest}`,
    },
  ];

  if (onChunk) {
    return chatCompletionStream(messages, onChunk, model);
  }

  const response = await chatCompletion(messages, model);
  return extractContent(response);
}

/**
 * Ask the LLM to suggest a folder name for an email.
 */
export async function suggestFolder(
  emailSubject: string,
  emailBody: string,
  existingFolders: string[]
): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "Tu es un assistant qui organise des emails dans des dossiers. " +
        "Réponds UNIQUEMENT avec le nom du dossier recommandé, rien d'autre. " +
        "Utilise un dossier existant si pertinent, sinon suggère un nouveau nom court.",
    },
    {
      role: "user",
      content:
        `Dossiers existants : ${existingFolders.join(", ")}\n\n` +
        `Email :\nSujet: ${emailSubject}\n${emailBody.slice(0, 300)}\n\n` +
        `Dans quel dossier classer cet email ?`,
    },
  ];

  const response = await chatCompletion(messages);
  return extractContent(response).trim() || "Inbox";
}

// ─── Reranker (BAAI/bge-reranker-v2-m3) ─────────────────────────────

interface RerankApiResponse {
  id: string;
  results: Array<{
    index: number;
    relevance_score: number;
    document?: { text: string };
  }>;
}

export interface RerankResult {
  index: number;
  score: number;
}

function isRerankLengthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /maximum context length|context length is|exceeds.*tokens|too long/i.test(msg);
}

async function callRerankApi(query: string, documents: string[], model: string): Promise<RerankResult[]> {
  const cfg = getRcpConfig();
  if (!cfg.apiKey) {
    throw new Error("Clé API RCP non configurée. Allez dans l'onglet Config pour la saisir.");
  }

  const response = await fetch(`${cfg.baseUrl}${config.rcp.rerankEndpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ model, query, documents }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`RCP rerank error ${response.status}: ${errorText}`);
  }

  const json: RerankApiResponse = await response.json();
  return json.results.map((r) => ({ index: r.index, score: r.relevance_score }));
}

const RERANK_BATCH_SIZE = 50;

/**
 * Rerank a single batch, with token-level truncation on length error.
 */
async function rerankBatchWithRetry(
  query: string,
  documents: string[],
  model: string
): Promise<RerankResult[]> {
  try {
    return await callRerankApi(query, documents, model);
  } catch (err) {
    if (!isRerankLengthError(err)) throw err;

    console.log(`[Rerank] Length error on batch of ${documents.length}, truncating with char limit fallback...`);

    // Simple char-based truncation instead of tokenizer (which hangs on large docs)
    const MAX_DOC_CHARS = 10000;
    const MAX_QUERY_CHARS = 2000;

    const truncQuery = query.length > MAX_QUERY_CHARS ? query.slice(0, MAX_QUERY_CHARS) : query;
    let truncCount = 0;
    const truncDocs = documents.map((d) => {
      if (d.length > MAX_DOC_CHARS) {
        truncCount++;
        return d.slice(0, MAX_DOC_CHARS);
      }
      return d;
    });
    console.log(`[Rerank] Truncated ${truncCount}/${documents.length} docs to ${MAX_DOC_CHARS} chars (query: ${truncQuery.length} chars)`);

    return await callRerankApi(truncQuery, truncDocs, model);
  }
}

/**
 * Rerank documents against a query using BAAI/bge-reranker-v2-m3.
 *
 * Splits documents into batches of 50 to avoid socket errors on large payloads.
 * Each batch is scored independently, then results are merged and sorted globally.
 *
 * Returns results sorted by relevance_score descending.
 */
export async function rerank(
  query: string,
  documents: string[],
  model: string = config.rcp.rerankerModel
): Promise<RerankResult[]> {
  if (documents.length === 0) return [];

  if (documents.length <= RERANK_BATCH_SIZE) {
    return await rerankBatchWithRetry(query, documents, model);
  }

  console.log(`[Rerank] Splitting ${documents.length} docs into batches of ${RERANK_BATCH_SIZE}`);
  const allResults: RerankResult[] = [];

  for (let i = 0; i < documents.length; i += RERANK_BATCH_SIZE) {
    const batchDocs = documents.slice(i, i + RERANK_BATCH_SIZE);
    const batchResults = await rerankBatchWithRetry(query, batchDocs, model);
    for (const r of batchResults) {
      allResults.push({ index: i + r.index, score: r.score });
    }
  }

  allResults.sort((a, b) => b.score - a.score);
  return allResults;
}

// ─── Settings persistence ────────────────────────────────────────────

export function saveRcpSettings(baseUrl: string, apiKey: string, model: string): void {
  localStorage.setItem("rcp_base_url", baseUrl);
  localStorage.setItem("rcp_api_key", apiKey);
  localStorage.setItem("rcp_model", model);
}

export function loadRcpSettings(): { baseUrl: string; apiKey: string; model: string } {
  return getRcpConfig();
}
