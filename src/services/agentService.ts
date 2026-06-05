import {
  AgentMessage,
  chatCompletionWithToolsStream,
} from "./rcpApiService";
import { AGENT_TOOLS, executeTool, PRESERVED_TOOLS, CORE_TOOL_NAMES, ToolProgressFn } from "./agentTools";
import { replaceEmailIdsWithRefs, resolveEmailRef as _resolveEmailRef } from "./emailRefs";
import { getSkillTools } from "../skills/skillRegistry";
import { getUserCustomPrompt } from "./rcpApiService";

// Re-export so existing AssistantView import path keeps working.
export const resolveEmailRef = _resolveEmailRef;

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
  const customPrompt = getUserCustomPrompt();
  const customSection = customPrompt
    ? `\n\nCONTEXTE UTILISATEUR (fourni dans les réglages — qui il est, son activité, ses besoins récurrents). Tiens-en compte pour adapter le ton, le niveau de détail et le focus de tes réponses, notamment lors des résumés. Ce contexte ne remplace JAMAIS la règle anti-hallucination : il ne constitue pas une source de faits sur les emails/contacts/calendrier.\n${customPrompt}`
    : "";
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

RÈGLE STREAMING — ANTI-RÉPÉTITION :
Quand le résultat d'un outil contient le champ "already_displayed": true, cela veut dire que son contenu principal (champ "summary", "briefing" ou équivalent) a DÉJÀ été streamé à l'utilisateur pendant l'exécution. Tu ne dois PAS le répéter, paraphraser ou réafficher. Termine par une phrase de transition courte (ex: "Besoin que je creuse un point ?" ou "Veux-tu que j'affiche les emails clés ?"). Rien d'autre.

Règles importantes :
- Distinguer "afficher" et "résumer" les emails d'un contact :
  * get_email_interactions — récupère/affiche les emails échangés avec un contact. SANS query, la liste cliquable complète s'affiche automatiquement dans l'UI (pas de synthèse). AVEC query, tu reçois les emails triés par pertinence pour les filtrer toi-même puis appeler display_emails. Utiliser pour "montre/affiche/liste/donne-moi/quels sont les emails échangés avec X", "voir mes emails avec Y".
  * summarize_email_interactions — GÉNÈRE UN RÉSUMÉ / SYNTHÈSE des échanges. Utiliser uniquement si l'utilisateur demande explicitement un résumé, une synthèse, un bilan, un point ("résume mes échanges avec X", "fais-moi un point sur mes emails avec Y").
  En cas de doute entre les deux, préférer get_email_interactions (afficher est l'action neutre par défaut).
- Deux outils thématiques à bien distinguer :
  * identify_topic_participants — cartographie les PERSONNES impliquées sur un sujet. Utiliser pour "qui travaille sur X ?", "quels sont les acteurs sur Y ?", "qui est impliqué dans Z ?", "quel est le positionnement de chacun sur W ?".
  * summarize_topic_status — POINT D'AVANCEMENT chronologique d'un projet/dossier en cours. Utiliser pour "où on en est de X ?", "état d'avancement de Y ?", "fais-moi un point sur Z", "résume l'avancée du dossier W".
  Ne demande PAS de précisions — lance directement l'outil adapté. IMPORTANT : le paramètre topic sert au classement sémantique (embeddings). Un mot seul est trop vague. Développe en description riche avec synonymes et termes associés (ex: "intelligence artificielle, IA, machine learning, LLM, modèles de langage, deep learning, ChatGPT, Copilot" au lieu de juste "IA").
- Quand l'utilisateur mentionne un contact par nom (ex: "Dupont", "Martin"), utilise TOUJOURS l'outil search_contacts d'abord pour trouver l'adresse email exacte avant d'appeler d'autres outils. search_contacts couvre l'annuaire EPFL complet (n'importe quel collaborateur, même sans historique d'échange) ainsi que les emails de l'utilisateur (utile pour les contacts externes).
- Si search_contacts retourne un seul résultat, utilise-le directement sans demander confirmation.
- Si search_contacts retourne plusieurs résultats, choisis celui dont le nom correspond le mieux à la requête de l'utilisateur (même avec des fautes d'orthographe). Si plusieurs personnes EPFL portent le même nom, utilise les champs jobTitle/department quand ils sont fournis pour désambiguïser. Ne demande confirmation que si tu hésites vraiment.
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
- EMAIL OUVERT : pour RÉSUMER / analyser l'email actuellement ouvert (corps + pièces jointes), charge le skill email_courant. Si l'utilisateur veut répondre, tu peux proposer un texte de réponse DANS LE CHAT (il le copiera/collera) — l'add-in ne rédige pas dans le brouillon Outlook.
- PIÈCES JOINTES : Tu PEUX lire le contenu texte des pièces jointes (PDF, Word/DOCX, TXT, CSV, HTML) via l'outil read_email_attachments(email_id=<ref>). Les résultats d'emails marquent has_attachments:true quand un email a des pièces jointes, et summarize_email_interactions retourne attachments_available (refs des emails avec PJ). Ne lis une pièce jointe QUE lorsqu'elle est jugée importante pour la demande (un seul email par appel, jamais en masse ni « au cas où » — cela sature le contexte). Tu n'as PAS accès à SharePoint/OneDrive, aux images, ni aux fichiers non joints à un email.
- LIENS EMAILS CLIQUABLES : Quand tu listes des emails et que tu disposes de leur ID, utilise le format [Sujet — Date](email:ID) pour créer des liens cliquables. L'utilisateur pourra cliquer pour ouvrir l'email directement dans Outlook. Utilise ce format systématiquement pour chaque email que tu mentionnes.
- AFFICHAGE DE LISTES D'EMAILS — DÉCISION AVANT D'APPELER L'OUTIL :
  Pose-toi la question : « la demande contient-elle un critère de filtrage de contenu ? » (ex: "concernant X", "sur le sujet Y", "à propos de Z", "qui parlent de W", "liés à V", "le recrutement", "l'IA", "le budget", "les importants").
  * NON, juste un contact (et éventuellement une période) → get_email_interactions(name, email, [start_date], [end_date]) SANS query. La liste cliquable complète s'affiche automatiquement.
  * OUI, il y a un critère → get_email_interactions(name, email, query="<sujet enrichi avec synonymes>"), PUIS :
      1. Lis les sujets+previews retournés. Choisis TOI-MÊME les refs réellement pertinents (le ranking par embeddings n'est qu'un pré-tri, certains hors-sujet remontent quand même — c'est ton boulot de les écarter).
      2. display_emails(email_ids=[refs sélectionnés], context_label="<sujet>")
  Dans les DEUX cas : après l'appel final, écris UNIQUEMENT une phrase d'introduction courte (ex: "Voici les 8 emails sur le recrutement échangés avec Martin Rajman."). Ne JAMAIS recopier la liste à la main avec [Sujet](email:ref_X) — l'UI s'en charge.${customSection}`;
}

const MAX_ITERATIONS = 20;

/**
 * Detect when the assistant presents availability slots (a free/busy listing), so
 * we can verify it actually called find_common_slots instead of inventing them.
 * Requires an availability keyword AND at least 2 time-of-day patterns (a table).
 */
function presentsSlots(text: string): boolean {
  const hasAvailabilityWord = /(cr[ée]neau|disponib|libre|occup[ée])/i.test(text);
  const timeCount = (text.match(/\b\d{1,2}\s*[h:]\s*\d{2}\b/g) || []).length;
  return hasAvailabilityWord && timeCount >= 2;
}

/**
 * Hand off any tool result of shape `{type: "email_list", emails: [...]}`
 * to the UI callback, then return a compact marker for the LLM. The LLM
 * only needs to know the list was shown — it shouldn't re-emit markdown.
 * Used by get_email_interactions (no-query full list) and display_emails (LLM-filtered subset).
 */
function handleEmailListResult(
  rawResult: string,
  onEmailList?: EmailListCallback
): string {
  try {
    const parsed = JSON.parse(rawResult);
    if (
      parsed.type === "email_list" &&
      Array.isArray(parsed.emails) &&
      onEmailList
    ) {
      onEmailList(parsed.name ?? "", parsed.emails);
      return JSON.stringify({
        already_displayed: true,
        type: "email_list",
        name: parsed.name ?? null,
        count: parsed.count ?? parsed.emails.length,
      });
    }
  } catch {
    // Fall through and return raw result; the LLM will see the full payload.
  }
  return replaceEmailIdsWithRefs(rawResult);
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
  onEmailList?: EmailListCallback,
  signal?: AbortSignal
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
  let calledFindSlots = false; // find_common_slots was invoked this turn
  let forcedSlotRetry = false;

  // Progressive tool disclosure: start with the core tools only; loading a skill
  // unlocks its tools. Re-derive already-loaded skills from prior turns
  // (load_skill is preserved in history) so their tools stay available.
  const activeToolNames = new Set<string>(CORE_TOOL_NAMES);
  const loadedSkills = new Set<string>();
  for (const msg of conversationHistory) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.function.name === "load_skill") {
          try {
            const sid = JSON.parse(tc.function.arguments).skill_id as string;
            if (sid) {
              loadedSkills.add(sid);
              getSkillTools(sid).forEach((t) => activeToolNames.add(t));
            }
          } catch {
            /* ignore malformed args */
          }
        }
      }
    }
  }

  while (iterations < MAX_ITERATIONS) {
    if (signal?.aborted) throw new DOMException("Aborted by user", "AbortError");
    iterations++;
    const activeTools = AGENT_TOOLS.filter((t) => activeToolNames.has(t.function.name));
    log(`Iteration ${iterations} — appel LLM avec ${activeTools.length} outils (skills: ${[...loadedSkills].join(", ") || "aucun"})`);

    // Call LLM with streaming — content tokens are streamed in real-time,
    // tool_calls are accumulated from SSE deltas
    const streamResult = await chatCompletionWithToolsStream(
      messages,
      activeTools,
      onStream, // Stream content tokens directly to UI
      undefined,
      signal
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
      let onlySkillLoads = true;
      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name;
        let args: Record<string, unknown> = {};

        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          log(`ERREUR parse arguments: ${toolCall.function.arguments}`);
        }
        if (toolName !== "load_skill") onlySkillLoads = false;

        log(`Tool call: ${toolName}(${JSON.stringify(args)})`);

        // Progressive disclosure: loading an already-loaded skill is a no-op (its
        // tools are already active) — short-circuit without re-fetching, so the
        // model can't loop on load_skill.
        if (toolName === "load_skill") {
          const sid = String((args as Record<string, unknown>).skill_id || "");
          if (sid && loadedSkills.has(sid)) {
            onToolProgress(toolName, "calling", JSON.stringify(args));
            onToolProgress(toolName, "done");
            messages.push({
              role: "tool",
              content: JSON.stringify({ skill_id: sid, note: "Skill déjà chargé, ses outils sont disponibles." }),
              tool_call_id: toolCall.id,
            });
            continue;
          }
        }

        onToolProgress(toolName, "calling", JSON.stringify(args));

        try {
          const progressFn: ToolProgressFn = (detail) => onToolProgress(toolName, "calling", detail);
          // Les tools "résumé" (summarize_email_interactions, ...) peuvent streamer leur
          // sortie directement à l'UI pour une perception beaucoup plus rapide qu'un
          // résultat tardif bloqué. Le tool signale alors already_displayed:true pour
          // que l'agent ne recopie pas le texte ensuite.
          const toolStreamFn = (chunk: string) => onStream(chunk);
          const rawResult = await executeTool(toolName, args, onLog, progressFn, toolStreamFn, signal);
          log(`Tool ${toolName} OK — résultat: ${rawResult.slice(0, 500)}${rawResult.length > 500 ? '...' : ''}`);
          // Progressive disclosure: a freshly-loaded skill unlocks its tools for
          // the next iterations.
          if (toolName === "load_skill" && !rawResult.includes('"error"')) {
            const sid = String((args as Record<string, unknown>).skill_id || "");
            if (sid) {
              loadedSkills.add(sid);
              getSkillTools(sid).forEach((t) => activeToolNames.add(t));
            }
          }
          if (toolName === "find_common_slots") calledFindSlots = true;
          onToolProgress(toolName, "done");

          // Any tool result of shape {type:"email_list",...} (get_email_interactions
          // without query, display_emails) is rendered directly in the UI via
          // onEmailList, and the LLM sees only a compact marker. Other results get
          // their long Graph IDs swapped for short refs. load_skill is passed through
          // verbatim so its instructions aren't mangled.
          let result: string;
          if (toolName === "load_skill") {
            result = rawResult;
          } else {
            result = handleEmailListResult(rawResult, onEmailList);
          }

          // Add tool result to conversation
          messages.push({
            role: "tool",
            content: result,
            tool_call_id: toolCall.id,
          });
        } catch (err) {
          // Propagate user-triggered abort up to the caller; don't swallow as a tool error.
          if (err instanceof Error && err.name === "AbortError") throw err;
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

      // load_skill calls don't consume the work budget (their number is bounded
      // by the catalog size, and re-loads are no-ops) — refund this iteration if
      // nothing but skill-loading happened.
      if (onlySkillLoads) iterations = Math.max(0, iterations - 1);

      // Continue the loop — LLM will process tool results
      continue;
    }

    // No tool calls — this is the final text response (already streamed to UI)
    const finalContent = assistantMessage.content || "";

    // Anti-invention guard for scheduling: if find_common_slots is available
    // (scheduling skill loaded) and the answer presents slots but the tool wasn't
    // called this turn, those slots are invented — force ONE corrective call.
    if (
      !forcedSlotRetry &&
      !calledFindSlots &&
      activeToolNames.has("find_common_slots") &&
      presentsSlots(finalContent)
    ) {
      forcedSlotRetry = true;
      log("Garde planification: créneaux présentés sans appel find_common_slots — relance forcée");
      onStream(null); // discard the invented streamed text
      messages.push({ role: "assistant", content: finalContent });
      messages.push({
        role: "system",
        content:
          "STOP. Tu présentes des créneaux/disponibilités mais tu n'as PAS appelé find_common_slots ce tour-ci — ces créneaux sont donc INVENTÉS. Appelle find_common_slots MAINTENANT (avec les emails des participants obtenus via search_contacts) et présente UNIQUEMENT ses résultats réels. Ne fabrique JAMAIS de créneaux.",
      });
      continue;
    }

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
