/**
 * Boucle agent : le harness Claude Code (Agent SDK) pointé sur RCP/GLM-5.2
 * via le proxy interne, avec UNIQUEMENT nos tools emails.
 *
 * Confidentialité :
 *  - ANTHROPIC_BASE_URL → proxy interne → RCP. Aucun appel modèle vers Anthropic.
 *  - Env passé EXPLICITEMENT au sous-processus (ANTHROPIC_API_KEY retiré) :
 *    si la base URL sautait, le pire cas est un 401, jamais une fuite.
 *  - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 coupe télémétrie/Sentry/update-check.
 *  - Tous les tools built-in (fichiers, bash, web) sont désactivés.
 */
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { createAgentMcpServer, type UiEmitter, type CurrentEmailContext, type AgentProfile } from "./tools.js";
import type { ClientToolDef } from "./clientTools.js";
import { getOrCreateStore, adoptStore, type RefStore } from "./emailRefs.js";
import { getSkillCatalogForPrompt } from "./skills.js";

// Prompt construit PAR REQUÊTE : la date du jour doit être fraîche (le harness
// n'injecte plus la sienne puisqu'on remplace son system prompt).
// Exportés : partagés avec le moteur OpenHands (openhandsEngine.ts).
export const buildSystemPrompt = (currentEmail?: CurrentEmailContext) => `Tu es l'assistant email du personnel EPFL, intégré dans Outlook.
Tu réponds en français, de façon concise et factuelle.

Nous sommes le ${new Date().toLocaleString("fr-CH", { timeZone: config.timezone, dateStyle: "full", timeStyle: "short" })} (${config.timezone}).
${currentEmail?.id
    ? `L'utilisateur a actuellement un email OUVERT dans Outlook : « ${currentEmail.subject || "(sans objet)"} »${currentEmail.from ? ` de ${currentEmail.from}` : ""}. S'il parle de « cet email / ce mail / le message ouvert », utilise get_current_email.`
    : `Aucun email n'est actuellement ouvert dans Outlook (get_current_email retournera une erreur).`}

Règles :
- Quand l'utilisateur mentionne une personne par son nom, utilise d'abord search_contacts pour résoudre son adresse email.
- Pour une recherche par sujet/mot-clé SANS contact précis, utilise search_emails directement (pas get_email_interactions).
- Quand l'utilisateur dit « l'email de X qui parle de Y », utilise search_emails avec le paramètre sender.
- Ne réponds jamais de mémoire sur le contenu des emails : appelle toujours un tool.
- Cite les dates et sujets des emails sur lesquels tu t'appuies.
- Tu es en LECTURE SEULE : tu ne peux ni envoyer, ni modifier, ni supprimer quoi que ce soit.

Particularité EPFL — ServiceNow : une partie des échanges avec une personne passe par
des tickets ServiceDesk. Ces emails viennent de 1234@epfl.ch (PAS de la personne) et la
personne n'est mentionnée que dans le corps du ticket. Conséquences :
- get_email_interactions les inclut déjà (sujets préfixés [ServiceNow]).
- Avec search_emails, si une recherche avec sender=<personne> ne donne rien ou peu,
  réessaie SANS sender en ajoutant le nom de la personne aux mots-clés de query —
  l'email cherché est peut-être un ticket envoyé par 1234@epfl.ch.

Résumés d'échanges (« résume mes échanges avec X », « fais le point sur X ») : pose UNE
SEULE question — (a) résumé rapide pour se rafraîchir la mémoire (tu improvises avec
get_email_interactions) ou (b) rapport vérifiable avec emails sources cliquables + Word
(tu appelles summarize_exchanges DIRECTEMENT, sans question supplémentaire — période par
défaut 6 derniers mois sauf indication spontanée de l'utilisateur).

Refs d'emails : les résultats de tools identifient chaque email par un ref court (ref_0,
ref_1…) valable pour toute la conversation. Utilise ces refs pour display_emails et
read_email_attachments. N'écris JAMAIS de lien markdown vers un email — pour montrer des
emails cliquables à l'utilisateur, utilise display_emails.

Skills (workflows guidés) : quand la demande correspond à un skill ci-dessous, charge-le
via load_skill AVANT d'agir et suis ses instructions :
${getSkillCatalogForPrompt()}`;

// Profil "dpo" : personalRAG — documents personnels (tools client de
// l'extension) + base de connaissances EPFL + web.
export const buildDpoSystemPrompt = () => `Tu es l'assistant personalRAG de l'EPFL (extension navigateur).
Tu réponds dans la langue de l'utilisateur (français par défaut), de façon précise et sourcée.

Nous sommes le ${new Date().toLocaleString("fr-CH", { timeZone: config.timezone, dateStyle: "full", timeStyle: "short" })} (${config.timezone}).

Tes sources, à choisir selon la question (tu peux en combiner plusieurs) :
- search_local — les DOCUMENTS PERSONNELS de l'utilisateur (fichiers qu'il a chargés dans
  l'extension : contrats, rapports, procédures internes…). À privilégier quand la question
  porte sur « mes documents », un fichier précis, ou un contenu vraisemblablement uploadé.
- search_epfl — la base de connaissances EPFL : articles KB ServiceNow (IT, RH,
  administration), incidents résolus, pages du site EPFL. Pour « comment faire X à l'EPFL »
  et toute question administrative/procédurale EPFL.
- search_web — le web ouvert, si disponible. Pour les infos générales/actualités.

Règles :
- Ne réponds jamais de mémoire quand une source peut vérifier : appelle un tool.
- CITATIONS (format OBLIGATOIRE) : après chaque affirmation factuelle, cite le passage
  source avec une phrase-clé copiée MOT POUR MOT depuis le champ "text" du passage :
  [N: "phrase exacte du passage"]. C'est ce matching textuel qui permet à l'interface de
  SURLIGNER le passage dans la source au clic — le mécanisme de vérification central.
  - N = le champ "number" du passage retourné par le tool.
  - La phrase doit être un extrait VERBATIM (copie exacte, même langue que le passage,
    8-20 mots) — jamais une paraphrase, jamais une phrase reconstruite.
  - Citation INLINE, à la fin de la phrase ou de l'item de liste, sur la MÊME ligne.
  - Plusieurs passages → citations successives : [2: "phrase A"] [5: "phrase B"].
  - Plusieurs phrases éloignées du même passage → [3: "phrase A"] [3: "phrase B"],
    jamais de "…" dans une citation.
- Si l'information n'est pas dans les passages, dis-le explicitement, sans citation.
- Si une recherche ne donne rien, essaie une reformulation ou une autre source.
- Tu es en LECTURE SEULE.`;

const DISALLOWED_BUILTIN_TOOLS = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep",
  "WebFetch", "WebSearch", "Task", "NotebookEdit", "TodoWrite", "AskUserQuestion",
];

export interface AgentEvent {
  type:
    | "session"
    | "text"          // bloc de texte complet (fallback / persistance)
    | "text_block_start"
    | "text_delta"    // streaming token par token
    | "thinking_delta" // réflexion du modèle, pour l'afficher à part (jamais dans la réponse)
    | "tool_use"
    | "tool_result"
    | "usage"
    | "result"
    | "error";
  data: Record<string, unknown>;
}

export interface RunAgentParams {
  message: string;
  /** Profil de capacités (défaut: outlook). */
  profile?: AgentProfile;
  /** Token Graph délégué — requis pour le profil outlook. */
  graphToken?: string;
  /** Session Claude Code à reprendre (multi-tour). */
  sessionId?: string;
  abortController?: AbortController;
  /** Événements UI émis par les tools (email_list…), envoyés directement en SSE. */
  emitUi?: UiEmitter;
  /** Email actuellement ouvert dans Outlook (transmis par l'add-in). */
  currentEmail?: CurrentEmailContext;
  /** id_token Entra délégué pour la recherche KB ServiceNow. Optionnel. */
  kbToken?: string;
  /** Tools exécutés côté frontend (profil dpo : search_local, search_web…). */
  clientTools?: ClientToolDef[];
  /** false = réflexion réduite (`reasoning_effort: low`). Défaut : libre. */
  thinking?: boolean;
  /** Mode sans état : le serveur ne garde rien entre deux tours. Le contexte
   *  est déjà dans `message` (historique transmis par le client), et
   *  `refStore` vient de la table renvoyée par le client. */
  stateless?: boolean;
  refStore?: RefStore;
  /** Images jointes (data URLs) — moteur OpenHands uniquement. */
  images?: string[];
}

/** En-tête interne qui porte le réglage de réflexion du harness jusqu'au
 *  proxy RCP (rcpProxy.ts), qui le convertit en `reasoning_effort`. */
export const REASONING_HEADER = "x-agent-reasoning-effort";

/**
 * Lance une requête agent et émet des événements consommables en SSE.
 */
export async function* runAgent(params: RunAgentParams): AsyncGenerator<AgentEvent> {
  const profile: AgentProfile = params.profile === "dpo" ? "dpo" : "outlook";
  // Registre de refs de la conversation : réutilisé entre les tours via le
  // sessionId Claude Code (les refs du tour 1 restent résolubles au tour 5).
  const refStore: RefStore = params.refStore ?? getOrCreateStore(params.sessionId);
  const { server: outlookServer, allowedToolNames } = createAgentMcpServer({
    profile,
    graphToken: params.graphToken,
    refs: refStore,
    emitUi: params.emitUi ?? (() => {}),
    currentEmail: params.currentEmail,
    kbToken: params.kbToken,
    clientTools: params.clientTools,
  });

  // Env explicite : on part de process.env (PATH etc. nécessaires au spawn)
  // mais on RETIRE toute clé Anthropic et on force la destination RCP.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("ANTHROPIC_")) childEnv[k] = v;
  }
  Object.assign(childEnv, {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.proxyPort}`,
    ANTHROPIC_AUTH_TOKEN: config.rcp.apiKey,
    ANTHROPIC_MODEL: config.rcp.model,
    ANTHROPIC_SMALL_FAST_MODEL: config.rcp.smallModel,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  });
  // Réflexion coupée : le harness ne sait pas émettre `reasoning_effort` (format
  // Anthropic). On lui fait poser un en-tête que le proxy traduit. Vérifié
  // contre RCP le 24.09.2026 sur /v1/messages : `reasoning_effort: low` y coupe
  // la réflexion de GLM-5.3-Flash (0 bloc thinking), même si la requête porte
  // aussi `thinking: enabled` ; `thinking: disabled`, lui, est ignoré.
  if (params.thinking === false) {
    childEnv.ANTHROPIC_CUSTOM_HEADERS = `${REASONING_HEADER}: low`;
  }

  const stream = query({
    prompt: params.message,
    options: {
      model: config.rcp.model,
      systemPrompt: profile === "dpo" ? buildDpoSystemPrompt() : buildSystemPrompt(params.currentEmail),
      mcpServers: { outlook: outlookServer },
      allowedTools: allowedToolNames,
      disallowedTools: DISALLOWED_BUILTIN_TOOLS,
      permissionMode: "bypassPermissions",
      maxTurns: 24,
      env: childEnv,
      resume: params.stateless ? undefined : params.sessionId,
      abortController: params.abortController,
      // Émet les événements de stream bruts (deltas de texte) pour un
      // affichage token par token dans l'UI.
      includePartialMessages: true,
      // Ne charge ni settings.json ni CLAUDE.md — l'agent est autonome
      settingSources: [],
    },
  });

  // Comptage de tokens : chaque message assistant du SDK porte l'usage de
  // l'appel API qui l'a produit. Un même appel peut apparaître sur plusieurs
  // messages SDK (même id) → dédup par id, et on émet le DELTA (le frontend
  // cumule sur la conversation).
  const countedMessageIds = new Set<string>();

  try {
    for await (const message of stream as AsyncIterable<SDKMessage>) {
      switch (message.type) {
        case "stream_event" as any: {
          // Deltas du stream Anthropic : le texte visible, et la réflexion à
          // part — les frontends l'affichent dans leur journal d'activité.
          const ev = (message as any).event;
          if (ev?.type === "content_block_start" && ev.content_block?.type === "text") {
            yield { type: "text_block_start", data: {} };
          } else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
            yield { type: "text_delta", data: { text: ev.delta.text } };
          } else if (ev?.type === "content_block_delta" && ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
            yield { type: "thinking_delta", data: { text: ev.delta.thinking } };
          }
          break;
        }

        case "system":
          if (message.subtype === "init") {
            // Le sessionId n'est connu qu'ici pour un premier tour : on y
            // rattache le registre de refs pour les tours suivants (resume).
            if (!params.stateless) adoptStore(message.session_id, refStore);
            yield { type: "session", data: { sessionId: message.session_id, model: (message as any).model } };
          }
          break;

        case "assistant": {
          const apiMessage = message.message as Record<string, any>;
          const usage = apiMessage?.usage;
          const msgId = apiMessage?.id as string | undefined;
          if (usage && msgId && !countedMessageIds.has(msgId)) {
            countedMessageIds.add(msgId);
            yield {
              type: "usage",
              data: {
                input: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
                output: usage.output_tokens || 0,
              },
            };
          }
          for (const block of message.message.content as Array<Record<string, any>>) {
            if (block.type === "text" && block.text) {
              yield { type: "text", data: { text: block.text } };
            } else if (block.type === "tool_use") {
              // L'id permet au frontend d'apparier chaque résultat à SON appel
              // (les appels parallèles cassent tout appariement par ordre).
              yield { type: "tool_use", data: { id: block.id, name: block.name, input: block.input } };
            }
          }
          break;
        }

        case "user": {
          // Résultats de tools renvoyés au modèle — utile pour l'UI (progression)
          const content = (message as any).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result") {
                const text = Array.isArray(block.content)
                  ? block.content.map((c: any) => c.text || "").join("")
                  : String(block.content ?? "");
                yield {
                  type: "tool_result",
                  data: {
                    tool_use_id: block.tool_use_id,
                    is_error: !!block.is_error,
                    preview: text.slice(0, 400),
                  },
                };
              }
            }
          }
          break;
        }

        case "result":
          yield {
            type: "result",
            data: {
              subtype: message.subtype,
              result: (message as any).result ?? null,
              turns: (message as any).num_turns,
              usage: (message as any).usage,
              sessionId: (message as any).session_id,
            },
          };
          break;
      }
    }
  } catch (err) {
    yield { type: "error", data: { message: (err as Error).message } };
  }
}
