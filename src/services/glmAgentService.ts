/**
 * Client du backend "Ultra" — assistant sur harness OpenHands (MIT) +
 * GLM-5.3-Flash en réflexion libre via RCP, servi par glm-agent-server/ (POC).
 * Le moteur et le modèle sont fixés côté backend ; la réflexion libre est son
 * défaut (champ `thinking` de /chat absent).
 *
 * Sélectionné via le profil « Ultra » de l'onglet Config :
 * localStorage "assistant_engine" = "ultra". L'onglet Assistant bascule alors
 * ses requêtes vers ce backend au lieu de la boucle agent locale
 * (agentService.ts). Les autres onglets (Réunion, Résumés…) ne sont PAS
 * affectés et continuent d'utiliser l'API RCP directe.
 *
 * Multi-tour sans état : l'historique et la table des refs email partent avec
 * chaque message (cf. currentRefs). Reset via resetUltraSession().
 *
 * Le token Graph (MSAL) est transmis à chaque requête ; le backend l'utilise
 * pour exécuter les tools et ne le stocke jamais.
 */
import { getGraphToken, getIdToken } from "./authService";
import { persistSetting } from "./settingsStore";
import type { ToolProgressCallback, StreamCallback, LogCallback, EmailListCallback, EmailListItem } from "./agentService";

const ENGINE_KEY = "assistant_engine";
const BACKEND_URL_KEY = "ultra_backend_url";
// Backend permanent sur le cluster k8s EPFL (même hôte que l'add-in en prod).
const ONLINE_BACKEND_URL = "https://expert-finder.epfl.ch/outlook/agent";
const LOCAL_BACKEND_URL = "http://localhost:8790";

export function isUltraEngine(): boolean {
  return localStorage.getItem(ENGINE_KEY) === "ultra";
}

export function setUltraEngine(enabled: boolean): void {
  persistSetting(ENGINE_KEY, enabled ? "ultra" : null);
}

/**
 * URL du backend Ultra, par priorité :
 * 1. Override manuel (localStorage "ultra_backend_url" — mettre
 *    http://localhost:8790 pour développer le backend en local)
 * 2. Le serveur en ligne (défaut, y compris depuis le dev local de l'add-in)
 */
export function getUltraBackendUrl(): string {
  return localStorage.getItem(BACKEND_URL_KEY) || ONLINE_BACKEND_URL;
}

/** Pour la doc/UI : l'URL du backend local de dev. */
export const ULTRA_LOCAL_BACKEND_URL = LOCAL_BACKEND_URL;

// Mode SANS ÉTAT : le backend ne garde rien entre deux tours. L'historique
// part avec chaque message (celui de l'UI, déjà persisté avec la conversation)
// et la table des refs email (ref_N → vrai ID Graph) revient à chaque fin de
// tour par l'événement `refs` : on la garde ici et on la renvoie au tour
// suivant, pour que « ouvre le 3e mail » résolve encore le ref_3 du tour
// précédent. Persistée par AssistantView avec la conversation (convStorage).
let currentRefs: unknown = null;

export function resetUltraSession(): void {
  currentRefs = null;
}

export function getUltraRefs(): unknown {
  return currentRefs;
}

/** Restaure la table des refs (au remontage du taskpane, avec la conversation). */
export function setUltraRefs(refs: unknown): void {
  currentRefs = refs ?? null;
}

/** Nom d'affichage d'un tool MCP : mcp__outlook__search_contacts → search_contacts */
function displayToolName(name: string): string {
  return name.replace(/^mcp__[^_]+(?:__)/, "");
}

/**
 * Contexte de l'email actuellement ouvert dans Outlook (Office.js), transmis
 * au backend pour que get_current_email puisse le lire via Graph.
 * Retourne undefined en mode compose, sur un événement calendrier, ou hors Outlook.
 */
function getCurrentEmailContext(): { id: string; subject?: string; from?: string } | undefined {
  try {
    const OfficeRef = (window as any).Office;
    const item = OfficeRef?.context?.mailbox?.item;
    if (!item?.itemId) return undefined; // compose ou rien d'ouvert
    if (String(item.itemType || "").toLowerCase().includes("appointment")) return undefined;

    let restId = item.itemId as string;
    try {
      restId = OfficeRef.context.mailbox.convertToRestId(
        item.itemId,
        OfficeRef.MailboxEnums.RestVersion.v2_0
      );
    } catch {
      // conversion échouée — on tente avec l'id d'origine
    }
    return {
      id: restId,
      subject: item.subject as string | undefined,
      from: item.from?.displayName || item.from?.emailAddress || undefined,
    };
  } catch {
    return undefined;
  }
}

export interface UltraAgentResult {
  response: string;
}

/** Delta de tokens consommés par un appel LLM (le composant cumule). */
export type UsageCallback = (delta: { input: number; output: number }) => void;

/** Demande du backend d'exécuter le pipeline détaillé summarize_exchanges côté frontend. */
export interface DetailedSummaryRequest {
  people: Array<{ name: string; email: string }>;
  mode: "soft" | "deep";
  focus?: string;
  language?: string;
  start_date?: string;
  end_date?: string;
}
export type DetailedSummaryCallback = (request: DetailedSummaryRequest) => void;

/**
 * Envoie un message au backend Ultra et streame la réponse.
 * Mappe les événements SSE sur les callbacks existants de l'UI Assistant
 * (mêmes types que runAgent d'agentService).
 */
export async function runUltraAgent(
  userMessage: string,
  /** Tours précédents de la conversation, du plus ancien au plus récent. */
  history: Array<{ role: "user" | "assistant"; content: string }>,
  onToolProgress: ToolProgressCallback,
  onStream: StreamCallback,
  onLog: LogCallback,
  signal?: AbortSignal,
  onUsage?: UsageCallback,
  onEmailList?: EmailListCallback,
  onDetailedSummary?: DetailedSummaryCallback
): Promise<UltraAgentResult> {
  const graphToken = await getGraphToken();

  const resp = await fetch(`${getUltraBackendUrl()}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Cookie d'affinité de l'ingress (plusieurs réplicas du backend).
    credentials: "include",
    body: JSON.stringify({
      message: userMessage,
      graphToken,
      history,
      refs: currentRefs ?? undefined,
      currentEmail: getCurrentEmailContext(),
      // id_token Entra délégué — recherche KB ServiceNow (modèle OBO DPO-Agent).
      // Absent en mode dev token : le tool KB se dégrade proprement.
      kbToken: getIdToken() || undefined,
    }),
    signal,
  });

  if (!resp.ok || !resp.body) {
    throw new Error(
      `Backend Ultra injoignable (${resp.status}). Vérifie que glm-agent-server tourne sur ${getUltraBackendUrl()}.`
    );
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResponse = "";
  let streamedAnything = false;
  // Appels d'outils en cours : tool_use_id → nom d'affichage. L'appariement
  // par id est indispensable — les appels parallèles cassent tout appariement
  // par ordre (une trace resterait "en cours" à jamais dans l'UI).
  const openToolCalls = new Map<string, string>();
  // Texte accumulé via les deltas du bloc courant — pour ne pas dupliquer
  // quand le bloc complet ("text") arrive ensuite.
  let blockDelta = "";

  const handleEvent = (eventType: string, dataJson: string) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataJson);
    } catch {
      return;
    }

    switch (eventType) {
      case "refs":
        currentRefs = data;
        break;

      case "text_block_start":
        blockDelta = "";
        break;

      case "text_delta": {
        const t = data.text as string;
        if (t) {
          // Premier delta d'un nouveau bloc → séparateur Markdown
          if (!blockDelta && streamedAnything) onStream("\n\n");
          blockDelta += t;
          onStream(t);
          streamedAnything = true;
        }
        break;
      }

      case "text": {
        const text = data.text as string;
        if (!text) break;
        // Bloc complet : si déjà affiché token par token via les deltas, ne pas
        // dupliquer — on remet juste le compteur de bloc à zéro.
        if (blockDelta.trim()) {
          blockDelta = "";
          break;
        }
        onStream(streamedAnything ? `\n\n${text}` : text);
        streamedAnything = true;
        break;
      }

      case "tool_use": {
        const name = displayToolName(data.name as string);
        if (data.id) openToolCalls.set(data.id as string, name);
        onToolProgress(name, "calling", JSON.stringify(data.input ?? {}));
        break;
      }

      case "tool_result": {
        const id = data.tool_use_id as string | undefined;
        const name = (id && openToolCalls.get(id)) || undefined;
        if (name) {
          openToolCalls.delete(id!);
          const preview = (data.preview as string) || "";
          // auth_expired ou is_error → trace en erreur dans l'UI
          const isAuthError = preview.includes('"auth_expired"');
          const isError = isAuthError || !!data.is_error;
          onToolProgress(name, isError ? "error" : "done", isAuthError ? "Session expirée" : isError ? preview.slice(0, 120) : undefined);
          if (preview) onLog(`[${name}] ${preview.slice(0, 200)}`);
        }
        break;
      }

      case "usage":
        onUsage?.({ input: (data.input as number) || 0, output: (data.output as number) || 0 });
        break;

      case "email_list": {
        // display_emails côté backend : liste cliquable à rendre dans l'UI.
        // Les ids sont les VRAIS ids Graph (nécessaires pour ouvrir l'email).
        const emails = (data.emails as EmailListItem[]) || [];
        if (emails.length > 0) onEmailList?.((data.name as string) || "", emails);
        break;
      }

      case "run_summarize_exchanges":
        // Le backend délègue le pipeline détaillé (rapport + Word + liens
        // cliquables) au frontend — exécuté par AssistantView après ce tour.
        onDetailedSummary?.(data as unknown as DetailedSummaryRequest);
        break;

      case "result":
        if (typeof data.result === "string") finalResponse = data.result;
        break;

      case "error":
        throw new Error((data.message as string) || "Erreur du backend Ultra");
    }
  };

  // Parse SSE : blocs séparés par ligne vide, chaque bloc = "event: X\ndata: {...}"
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let eventType = "";
      let dataJson = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) eventType = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataJson += line.slice(6);
      }
      if (eventType && dataJson) handleEvent(eventType, dataJson);
    }
  }

  // Filet de sécurité : si le flux se termine avec des appels d'outils encore
  // « en cours » (résultat jamais reçu — interruption, event perdu), on ferme
  // leurs traces pour que le spinner de l'UI s'arrête.
  for (const name of openToolCalls.values()) {
    onToolProgress(name, "done");
  }
  openToolCalls.clear();

  return { response: finalResponse };
}
