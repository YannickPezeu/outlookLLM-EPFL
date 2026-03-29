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
      max_tokens: 2048,
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
      max_tokens: 2048,
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
    max_tokens: 2048,
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
 */
export async function summarizeInteractions(
  personName: string,
  personEmail: string,
  receivedEmails: Array<{ subject: string; body: string; date: string }>,
  sentEmails: Array<{ subject: string; body: string; date: string }>,
  onChunk?: (text: string) => void
): Promise<string> {
  // Build a chronological conversation digest
  const allEmails = [
    ...receivedEmails.map((e) => ({
      direction: `De ${personName}`,
      ...e,
    })),
    ...sentEmails.map((e) => ({
      direction: `À ${personName}`,
      ...e,
    })),
  ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // Truncate individual emails to avoid hitting token limits
  const digest = allEmails
    .map(
      (e) =>
        `[${e.date}] ${e.direction}\nSujet: ${e.subject}\n${e.body.slice(0, 500)}\n---`
    )
    .join("\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "Tu es un assistant qui analyse les échanges email entre deux personnes. " +
        "Fournis un résumé structuré en français qui inclut :\n" +
        "1. Un résumé global de la relation/collaboration\n" +
        "2. Les sujets principaux abordés\n" +
        "3. Les actions en cours ou demandées\n" +
        "4. Les décisions importantes prises\n" +
        "5. Les points en suspens",
    },
    {
      role: "user",
      content: `Voici les échanges email avec ${personName} (${personEmail}).\nRésume ces interactions :\n\n${digest}`,
    },
  ];

  if (onChunk) {
    return chatCompletionStream(messages, onChunk);
  }

  const response = await chatCompletion(messages);
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

// ─── Settings persistence ────────────────────────────────────────────

export function saveRcpSettings(baseUrl: string, apiKey: string, model: string): void {
  localStorage.setItem("rcp_base_url", baseUrl);
  localStorage.setItem("rcp_api_key", apiKey);
  localStorage.setItem("rcp_model", model);
}

export function loadRcpSettings(): { baseUrl: string; apiKey: string; model: string } {
  return getRcpConfig();
}
