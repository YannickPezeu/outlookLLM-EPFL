/**
 * Configuration du backend agent — tout vient de l'environnement.
 * IMPORTANT : la clé RCP ne doit JAMAIS être commitée ; utiliser .env (gitignored)
 * ou les secrets k8s en déploiement.
 */

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Variable d'environnement manquante : ${name}`);
  return v;
}

export const config = {
  port: parseInt(env("PORT", "8790"), 10),
  // Port interne du proxy qui strip les paramètres non supportés par LiteLLM/vLLM
  proxyPort: parseInt(env("RCP_PROXY_PORT", "8791"), 10),

  rcp: {
    host: env("RCP_HOST", "inference.rcp.epfl.ch"),
    apiKey: env("RCP_API_KEY"),
    // GLM-5.3-Flash depuis le 24.09.2026 (GLM-5.2 avant) : servi 24/7 sur RCP,
    // contrairement à GLM-5.2, et retenu en production par le banc de
    // DPO-Agent/docs/loadtest/resultats-2026-09-15.md. La réflexion se règle
    // par requête (champ `thinking` de /chat), pas par modèle.
    model: env("AGENT_MODEL", "zai-org/GLM-5.3-Flash"),
    // Modèle des tâches annexes du harness (titres, etc.) : le même.
    smallModel: env("AGENT_SMALL_MODEL", "zai-org/GLM-5.3-Flash"),
    embeddingModel: env("EMBEDDING_MODEL", "Qwen/Qwen3-Embedding-8B"),
  },

  graph: {
    baseUrl: "https://graph.microsoft.com/v1.0",
  },

  // Recherche KBs ServiceNow + site EPFL — service Hierarchical_search déjà
  // déployé (même pattern OBO que l'extension DPO-Agent : l'id_token Entra de
  // l'utilisateur est forwardé en Bearer, ServiceNow filtre selon SES droits).
  kbSearchUrl: env("KB_SEARCH_URL", "https://hierarchical-search.epfl.ch/servicenow/search"),

  // Recherche arborescente « coarse-to-fine » sur le site EPFL : on cherche
  // d'abord la PAGE (descripteurs : titre + fil d'Ariane + résumé), puis le
  // CONTENU en se limitant aux pages retenues. Corrige la pollution croisée
  // entre facettes du site qu'on observe avec une recherche plate.
  // Contrat : epfl-scraper/docs/search-api-contract.md
  //   prod (à venir) : https://hierarchical-search.epfl.ch
  //   test           : https://lex-chatbot.epfl.ch (pod dev, corpus élargi)
  //   local          : http://127.0.0.1:8100
  epflSearch: {
    baseUrl: env("EPFL_SEARCH_BASE_URL", "https://lex-chatbot.epfl.ch"),
    library: env("EPFL_SEARCH_LIBRARY", "epfl_website_v2"),
    // Repli X-API-Key quand l'appelant n'a pas d'id_token Entra (tests locaux).
    apiKey: process.env.EPFL_SEARCH_API_KEY || "",
  },

  // Sidecar OpenHands (second moteur d'agent, MIT). Interne au pod/machine.
  openhandsUrl: env("OPENHANDS_URL", "http://127.0.0.1:8792"),

  // Fuseau de l'utilisateur (rendu des heures calendrier). En dev = machine
  // locale ; sur k8s, mettre TZ/USER_TIMEZONE=Europe/Zurich dans le déploiement.
  timezone: process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Zurich",
};
