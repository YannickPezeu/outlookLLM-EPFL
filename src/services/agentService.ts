import {
  AgentMessage,
  chatCompletionWithTools,
} from "./rcpApiService";
import { AGENT_TOOLS, executeTool } from "./agentTools";

// ─── Types ──────────────────────────────────────────────────────────

export type ToolProgressCallback = (
  toolName: string,
  status: "calling" | "done" | "error",
  detail?: string
) => void;

export type StreamCallback = (chunk: string) => void;

export type LogCallback = (message: string) => void;

// ─── System Prompt ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `Tu es un assistant intelligent intégré dans Outlook pour les collaborateurs EPFL.
Tu aides à chercher des emails, résumer des échanges, préparer des réunions et organiser la messagerie.

Règles importantes :
- Quand l'utilisateur mentionne un contact par nom (ex: "Dupont", "Martin"), utilise TOUJOURS l'outil search_contacts d'abord pour trouver l'adresse email exacte avant d'appeler d'autres outils.
- Si search_contacts retourne un seul résultat, utilise-le directement sans demander confirmation.
- Si search_contacts retourne plusieurs résultats, choisis celui dont le nom correspond le mieux à la requête de l'utilisateur (même avec des fautes d'orthographe). Ne demande confirmation que si tu hésites vraiment entre deux contacts plausibles.
- Si search_contacts ne retourne aucun résultat, dis-le à l'utilisateur et suggère de reformuler.
- Réponds toujours en français.
- Sois concis et structuré dans tes réponses.
- Utilise le format Markdown pour structurer tes réponses (listes, titres, gras).`;

const MAX_ITERATIONS = 8;

// ─── Agent Loop ─────────────────────────────────────────────────────

/**
 * Run the agent loop: send user message → LLM with tools → execute tools → loop.
 * Returns the final assistant response text.
 */
export async function runAgent(
  userMessage: string,
  conversationHistory: AgentMessage[],
  onToolProgress: ToolProgressCallback,
  onStream: StreamCallback,
  onLog?: LogCallback
): Promise<{ response: string; updatedHistory: AgentMessage[] }> {
  const log = (msg: string) => {
    console.log(`[Agent] ${msg}`);
    onLog?.(`[Agent] ${msg}`);
  };
  // Build message array: system + history + new user message
  const messages: AgentMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...conversationHistory,
    { role: "user", content: userMessage },
  ];

  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    log(`Iteration ${iterations} — appel LLM avec ${AGENT_TOOLS.length} outils`);

    // Call LLM with tools (non-streaming to parse tool_calls)
    const response = await chatCompletionWithTools(messages, AGENT_TOOLS);
    const choice = response.choices[0];

    if (!choice) {
      throw new Error("Pas de réponse du LLM.");
    }

    const assistantMessage = choice.message;
    const finishReason = choice.finish_reason;

    log(`finish_reason=${finishReason}, tool_calls=${assistantMessage.tool_calls?.length || 0}, content=${assistantMessage.content ? assistantMessage.content.slice(0, 80) + '...' : '(vide)'}`);

    // Mistral sometimes puts tool calls in content as text instead of structured format:
    // "[TOOL_CALLS]func_name{"arg":"val"}func_name2{"arg":"val"}"
    // Parse these and convert to structured tool_calls
    if (
      !assistantMessage.tool_calls?.length &&
      assistantMessage.content?.includes("[TOOL_CALLS]")
    ) {
      log("Detected text-format tool calls from Mistral, parsing...");
      const textContent = assistantMessage.content;
      const toolCallsText = textContent.slice(textContent.indexOf("[TOOL_CALLS]") + "[TOOL_CALLS]".length);
      const parsed: import("./rcpApiService").ToolCall[] = [];
      // Match patterns like: func_name{"key":"value"} or func_name{"key":"value","key2":"value2"}
      const regex = /([a-z_]+)(\{[^}]*(?:\{[^}]*\}[^}]*)*\})/gi;
      let match;
      while ((match = regex.exec(toolCallsText)) !== null) {
        parsed.push({
          id: `text_call_${parsed.length}`,
          type: "function",
          function: { name: match[1], arguments: match[2] },
        });
      }
      if (parsed.length > 0) {
        log(`Parsed ${parsed.length} tool calls from text: ${parsed.map((t) => t.function.name).join(", ")}`);
        assistantMessage.tool_calls = parsed;
        assistantMessage.content = null;
      }
    }

    // Check if the LLM wants to call tools
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      // Add assistant message with tool_calls to conversation
      messages.push({
        role: "assistant",
        content: assistantMessage.content,
        tool_calls: assistantMessage.tool_calls,
      });

      // Execute each tool call
      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name;
        let args: Record<string, unknown> = {};

        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          log(`ERREUR parse arguments: ${toolCall.function.arguments}`);
        }

        log(`Tool call: ${toolName}(${JSON.stringify(args)})`);
        onToolProgress(toolName, "calling", JSON.stringify(args));

        try {
          const result = await executeTool(toolName, args);
          log(`Tool ${toolName} OK — résultat: ${result.slice(0, 200)}${result.length > 200 ? '...' : ''}`);
          onToolProgress(toolName, "done");

          // Add tool result to conversation
          messages.push({
            role: "tool",
            content: result,
            tool_call_id: toolCall.id,
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          log(`Tool ${toolName} ERREUR: ${errorMsg}`);
          onToolProgress(toolName, "error", errorMsg);

          messages.push({
            role: "tool",
            content: JSON.stringify({ error: errorMsg }),
            tool_call_id: toolCall.id,
          });
        }
      }

      // Continue the loop — LLM will process tool results
      continue;
    }

    // No tool calls — this is the final text response
    if (finishReason === "stop" || !assistantMessage.tool_calls) {
      const finalContent = assistantMessage.content || "";
      log(`Réponse finale (${finalContent.length} chars)`);

      // If we got content directly (non-streaming), stream it to UI chunk by chunk
      if (finalContent) {
        // Stream the already-received content in small chunks for UI effect
        const chunkSize = 20;
        for (let i = 0; i < finalContent.length; i += chunkSize) {
          onStream(finalContent.slice(i, i + chunkSize));
          // Small delay for visual streaming effect
          await new Promise((r) => setTimeout(r, 10));
        }
      }

      // Build the updated history (without system prompt)
      const updatedHistory: AgentMessage[] = [
        ...conversationHistory,
        { role: "user", content: userMessage },
        { role: "assistant", content: finalContent },
      ];

      return { response: finalContent, updatedHistory };
    }
  }

  // Max iterations reached
  const fallback = "J'ai atteint la limite de recherches. Veuillez reformuler votre demande de manière plus simple.";
  onStream(fallback);

  const updatedHistory: AgentMessage[] = [
    ...conversationHistory,
    { role: "user", content: userMessage },
    { role: "assistant", content: fallback },
  ];

  return { response: fallback, updatedHistory };
}
