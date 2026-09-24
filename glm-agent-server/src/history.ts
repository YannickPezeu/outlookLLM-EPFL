/**
 * Mode sans état : l'historique transmis par le client est rejoué en tête du
 * message (cf. server.ts). Module à part pour être testé sans démarrer le
 * serveur.
 */

// Plafond de l'historique rejoué, en caractères : on garde les messages les
// plus RÉCENTS. Il doit contenir les documents joints dans le chat, que
// Personal RAG autorise jusqu'à 250 000 jetons par conversation (~1 million de
// caractères) — sinon un document glissé quelques tours plus tôt sortirait de
// la mémoire de l'agent. Au-delà, il protège du temps de prefill.
export const HISTORY_MAX_CHARS = 1_200_000;

/** Mode sans état : l'historique transmis par le client devient un bloc de
 *  contexte en tête de la question, identique pour les deux moteurs. */
export function withHistory(message: string, history: Array<{ role?: string; content?: unknown }>): string {
  const turns: string[] = [];
  let total = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (typeof h?.content !== "string" || !h.content.trim()) continue;
    const who = h.role === "assistant" ? "Assistant" : "Utilisateur";
    const turn = `${who} : ${h.content}`;
    if (total + turn.length > HISTORY_MAX_CHARS) break;
    turns.unshift(turn);
    total += turn.length;
  }
  if (turns.length === 0) return message;
  return (
    "Historique de la conversation, pour le contexte (ne pas y répondre à nouveau) :\n" +
    `<historique>\n${turns.join("\n\n")}\n</historique>\n\n` +
    `Nouvelle demande de l'utilisateur :\n${message}`
  );
}
