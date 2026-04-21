import {
  AgentMessage,
  chatCompletionWithToolsStream,
} from "./rcpApiService";
import { AGENT_TOOLS, executeTool, PRESERVED_TOOLS, ToolProgressFn } from "./agentTools";

// ─── Types ──────────────────────────────────────────────────────────

export type ToolProgressCallback = (
  toolName: string,
  status: "calling" | "done" | "error",
  detail?: string
) => void;

/** Stream callback: string = append chunk, null = reset (clear streamed content) */
export type StreamCallback = (chunk: string | null) => void;

export type LogCallback = (message: string) => void;

export interface EmailListItem {
  id: string;
  subject: string;
  date: string;
  from: string;
  direction: "received" | "sent";
}

export type EmailListCallback = (name: string, emails: EmailListItem[]) => void;

// ─── System Prompt ──────────────────────────────────────────────────

export function buildSystemPrompt(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const nowLocal = new Date().toLocaleString("fr-CH", {
    timeZone: tz,
    dateStyle: "full",
    timeStyle: "short",
  });
  return `Tu es un assistant intelligent intégré dans Outlook pour les collaborateurs EPFL.
Tu aides à chercher des emails, résumer des échanges, préparer des réunions et organiser la messagerie.
La date et l'heure actuelles sont : ${nowLocal} (fuseau ${tz}).

RÈGLE ANTI-HALLUCINATION — LA PLUS IMPORTANTE :
Tu n'as AUCUNE connaissance du calendrier, des emails, des contacts ou des réunions de l'utilisateur en dehors des résultats retournés par tes outils. Tu ne DOIS JAMAIS inventer :
- un sujet de réunion, un titre d'email, un nom de contact, une date, une heure, un participant, un lieu
- ni aucune donnée factuelle qui n'apparaît pas littéralement dans un résultat d'outil de la conversation en cours
Si tu n'as pas appelé l'outil correspondant dans cette conversation, tu dois l'appeler MAINTENANT avant de répondre. Ne devine pas. Ne fais pas "comme si". Si l'outil ne retourne rien, dis "Je n'ai trouvé aucun résultat" — ne comble jamais le vide avec une réponse plausible.

RÈGLE CALENDRIER :
Pour TOUTE question concernant des réunions, rendez-vous, disponibilités, agenda ou calendrier (incluant "ma prochaine réunion", "la suivante", "qu'ai-je demain", "suis-je libre à X"), tu DOIS appeler get_calendar_events AVANT de répondre, à CHAQUE question, même si l'utilisateur vient de poser une question similaire. N'utilise jamais le résultat d'un appel précédent pour répondre à une nouvelle question calendrier — rappelle l'outil.

RÈGLE PRIORITAIRE — SKILLS :
Tu disposes de skills (workflows prédéfinis). Ton PREMIER réflexe pour chaque nouvelle demande est de vérifier si un skill correspond. Si oui, appelle load_skill AVANT tout autre outil. Lis les instructions retournées et suis-les exactement.

Règles importantes :
- Deux outils thématiques à bien distinguer :
  * identify_topic_participants — cartographie les PERSONNES impliquées sur un sujet. Utiliser pour "qui travaille sur X ?", "quels sont les acteurs sur Y ?", "qui est impliqué dans Z ?", "quel est le positionnement de chacun sur W ?".
  * summarize_topic_status — POINT D'AVANCEMENT chronologique d'un projet/dossier en cours. Utiliser pour "où on en est de X ?", "état d'avancement de Y ?", "fais-moi un point sur Z", "résume l'avancée du dossier W".
  Ne demande PAS de précisions — lance directement l'outil adapté. IMPORTANT : le paramètre topic sert au classement sémantique (embeddings). Un mot seul est trop vague. Développe en description riche avec synonymes et termes associés (ex: "intelligence artificielle, IA, machine learning, LLM, modèles de langage, deep learning, ChatGPT, Copilot" au lieu de juste "IA").
- Quand l'utilisateur mentionne un contact par nom (ex: "Dupont", "Martin"), utilise TOUJOURS l'outil search_contacts d'abord pour trouver l'adresse email exacte avant d'appeler d'autres outils.
- Si search_contacts retourne un seul résultat, utilise-le directement sans demander confirmation.
- Si search_contacts retourne plusieurs résultats, choisis celui dont le nom correspond le mieux à la requête de l'utilisateur (même avec des fautes d'orthographe). Ne demande confirmation que si tu hésites vraiment entre deux contacts plausibles.
- Si search_contacts ne retourne aucun résultat pertinent, utilise search_contacts_in_servicedesk pour chercher dans les tickets ServiceNow (certains échanges passent par le ServiceDesk et le vrai nom de la personne n'apparaît que dans le corps du mail).
- Si aucun outil ne trouve le contact, dis-le à l'utilisateur et suggère de reformuler.
- Quand l'utilisateur mentionne une période temporelle, convertis-la en paramètres start_date et end_date au format ISO 8601. Fais très attention à l'année mentionnée — ne remplace JAMAIS une année explicite par l'année courante. Exemples :
  * "mai 2023" → start_date="2023-05-01T00:00:00Z", end_date="2023-06-01T00:00:00Z"
  * "les 3 derniers mois de 2023" → start_date="2023-10-01T00:00:00Z", end_date="2024-01-01T00:00:00Z" (octobre, novembre, décembre 2023)
  * "le mois dernier" → calcule en fonction de la date actuelle
  * "depuis janvier" → depuis janvier de l'année courante jusqu'à aujourd'hui
  N'utilise start_date/end_date que quand l'utilisateur mentionne explicitement une période.
- Par défaut, get_email_interactions se limite aux 6 derniers mois. Si le résultat indique "default_period", informe l'utilisateur que la recherche couvre les 6 derniers mois et propose d'élargir si besoin.
- Quand un outil retourne des résultats, évalue leur pertinence par rapport à la demande de l'utilisateur. Ne présente que les résultats réellement pertinents. Si aucun résultat n'est pertinent, dis-le clairement plutôt que d'afficher des résultats hors-sujet.
- Réponds dans la langue utilisée par l'utilisateur.
- Sois concis et structuré dans tes réponses.
- Utilise le format Markdown pour structurer tes réponses.
- LIENS EMAILS CLIQUABLES : Quand tu listes des emails et que tu disposes de leur ID, utilise le format [Sujet — Date](email:ID) pour créer des liens cliquables. L'utilisateur pourra cliquer pour ouvrir l'email directement dans Outlook. Utilise ce format systématiquement pour chaque email que tu mentionnes.`;
}

const MAX_ITERATIONS = 8;

// ─── Email ID reference mapping ────────────────────────────────────
// Tool results contain very long Graph API email IDs (100+ chars).
// We replace them with short refs (ref_0, ref_1...) so the LLM can
// reliably include them in markdown links like [Subject](email:ref_0).
// The UI resolves refs back to real IDs at click time.

let emailRefCounter = 0;
const emailRefMap = new Map<string, string>(); // ref → real ID

function replaceEmailIdsWithRefs(jsonStr: string): string {
  try {
    const data = JSON.parse(jsonStr);
    const items = data.results || data.emails || data.email_list;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item.id && typeof item.id === "string" && item.id.length > 20) {
          const ref = `ref_${emailRefCounter++}`;
          emailRefMap.set(ref, item.id);
          item.id = ref;
        }
      }
    }
    // Also handle get_email_interactions format
    if (Array.isArray(data.emails)) {
      for (const item of data.emails) {
        if (item.id && typeof item.id === "string" && item.id.length > 20) {
          const ref = `ref_${emailRefCounter++}`;
          emailRefMap.set(ref, item.id);
          item.id = ref;
        }
      }
    }
    return JSON.stringify(data);
  } catch {
    return jsonStr;
  }
}

/** Resolve a short ref (ref_0) to the real Graph API email ID. */
export function resolveEmailRef(ref: string): string | undefined {
  return emailRefMap.get(ref);
}

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
  onLog?: LogCallback,
  onEmailList?: EmailListCallback
): Promise<{ response: string; updatedHistory: AgentMessage[] }> {
  const log = (msg: string) => {
    console.log(`[Agent] ${msg}`);
    onLog?.(`[Agent] ${msg}`);
  };
  // Build message array: system + history + new user message
  const messages: AgentMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    ...conversationHistory,
    { role: "user", content: userMessage },
  ];

  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    log(`Iteration ${iterations} — appel LLM avec ${AGENT_TOOLS.length} outils`);

    // Call LLM with streaming — content tokens are streamed in real-time,
    // tool_calls are accumulated from SSE deltas
    const streamResult = await chatCompletionWithToolsStream(
      messages,
      AGENT_TOOLS,
      onStream // Stream content tokens directly to UI
    );

    const assistantMessage = streamResult.message;
    const finishReason = streamResult.finish_reason;

    log(`finish_reason=${finishReason}, tool_calls=${assistantMessage.tool_calls?.length || 0}, content=${assistantMessage.content ? assistantMessage.content.slice(0, 80) + '...' : '(vide)'}`);

    // Mistral sometimes puts tool calls in content as text instead of structured format:
    // "[TOOL_CALLS]func_name{"arg":"val"}func_name2{"arg":"val"}"
    // Parse these and convert to structured tool_calls
    if (
      !assistantMessage.tool_calls?.length &&
      assistantMessage.content?.includes("[TOOL_CALLS]")
    ) {
      log("Detected text-format tool calls from Mistral, parsing...");
      // Reset streamed content since it was tool call text, not a real response
      onStream(null);
      const textContent = assistantMessage.content;
      const toolCallsText = textContent.slice(textContent.indexOf("[TOOL_CALLS]") + "[TOOL_CALLS]".length);
      const parsed: import("./rcpApiService").ToolCall[] = [];
      // Match patterns like: func_name{"key":"value"} or func_name{"key":"value","key2":"value2"}
      const regex = /([a-z_]+)(\{[^}]*(?:\{[^}]*\}[^}]*)*\})/gi;
      let match;
      while ((match = regex.exec(toolCallsText)) !== null) {
        // ID must be exactly 9 alphanumeric chars (API requirement)
        const id = Array.from({ length: 9 }, () =>
          "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 62)]
        ).join("");
        parsed.push({
          id,
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
          const progressFn: ToolProgressFn = (detail) => onToolProgress(toolName, "calling", detail);
          const rawResult = await executeTool(toolName, args, onLog, progressFn);
          log(`Tool ${toolName} OK — résultat: ${rawResult.slice(0, 500)}${rawResult.length > 500 ? '...' : ''}`);
          onToolProgress(toolName, "done");

          // Replace long email IDs with short refs for the LLM
          const result = toolName === "load_skill" ? rawResult : replaceEmailIdsWithRefs(rawResult);

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

    // No tool calls — this is the final text response (already streamed to UI)
    const finalContent = assistantMessage.content || "";
    log(`Réponse finale (${finalContent.length} chars)`);

    // Build the updated history (without system prompt), preserving tool_calls
    // and tool results for tools in PRESERVED_TOOLS so follow-up questions
    // ("la suivante ?", "rien entre les 2 ?") have access to the fresh data.
    const turnMessages = messages.slice(conversationHistory.length + 2);
    const preserved = filterPreservedToolMessages(turnMessages);
    const updatedHistory: AgentMessage[] = [
      ...conversationHistory,
      { role: "user", content: userMessage },
      ...preserved,
      { role: "assistant", content: finalContent },
    ];

    return { response: finalContent, updatedHistory };
  }

  // Max iterations reached
  const fallback = "J'ai atteint la limite de recherches. Veuillez reformuler votre demande de manière plus simple.";
  onStream(fallback);

  const turnMessages = messages.slice(conversationHistory.length + 2);
  const preserved = filterPreservedToolMessages(turnMessages);
  const updatedHistory: AgentMessage[] = [
    ...conversationHistory,
    { role: "user", content: userMessage },
    ...preserved,
    { role: "assistant", content: fallback },
  ];

  return { response: fallback, updatedHistory };
}

// Filter turn messages to keep only assistant→tool_calls + tool_results pairs
// for tools flagged in PRESERVED_TOOLS. Drops non-preserved tool cycles entirely
// (their summaries are already in the final assistant text).
function filterPreservedToolMessages(turnMessages: AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];
  for (let i = 0; i < turnMessages.length; i++) {
    const msg = turnMessages[i];
    if (msg.role !== "assistant" || !msg.tool_calls || msg.tool_calls.length === 0) continue;

    const preservedCalls = msg.tool_calls.filter((tc) => PRESERVED_TOOLS.has(tc.function.name));
    if (preservedCalls.length === 0) continue;

    result.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: preservedCalls,
    });

    const preservedIds = new Set(preservedCalls.map((c) => c.id));
    for (let j = i + 1; j < turnMessages.length && turnMessages[j].role === "tool"; j++) {
      const tr = turnMessages[j];
      if (tr.tool_call_id && preservedIds.has(tr.tool_call_id)) result.push(tr);
    }
  }
  return result;
}
