/**
 * Application configuration.
 * Replace placeholder values with your actual Azure AD and RCP API settings.
 */
export const config = {
  // Azure AD / Entra ID
  auth: {
    clientId: process.env.ENTRA_CLIENT_ID || "YOUR_CLIENT_ID",
    tenantId: process.env.ENTRA_TENANT_ID || "YOUR_TENANT_ID",
    authority: `https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID || "YOUR_TENANT_ID"}`,
    redirectUri: window.location.origin + window.location.pathname,
  },

  // Microsoft Graph
  graph: {
    baseUrl: "https://graph.microsoft.com/v1.0",
    scopes: ["User.Read", "Mail.Read", "Calendars.Read"],
  },

  // EPFL RCP API (OpenAI-compatible)
  // Build-time detection: k8s uses CORS proxy, dev/ghpages use direct URL
  rcp: {
    baseUrl: process.env.DEPLOY_TARGET === "k8s"
      ? "https://expert-finder.epfl.ch/outlook/api/rcp"
      : "https://inference.rcp.epfl.ch/v1",
    apiKey: "", // User sets this in the UI settings, or stored in localStorage
    defaultModel: "google/gemma-4-26B-A4B-it-bfloat16",
    embeddingModel: "Qwen/Qwen3-Embedding-8B",
    rerankerModel: "BAAI/bge-reranker-v2-m3",
    filterModel: "google/gemma-4-E2B-it-bfloat16",
    synthesisModel: "google/gemma-4-26B-A4B-it-bfloat16",
    completionsEndpoint: "/chat/completions",
    embeddingsEndpoint: "/embeddings",
    rerankEndpoint: "/rerank",
  },

  // Feature defaults
  defaults: {
    maxEmailsToFetch: 50,
    maxEmailsForSummary: 30,
    maxEmailsPerParticipant: 200,
    embeddingTopK: 200,
    filterThreshold: 6,
    filterBatchSize: 30,
    recentMonths: 6,
    nonParticipantTopK: 20,
  },
};
