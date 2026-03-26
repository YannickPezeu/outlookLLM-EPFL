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
    redirectUri: window.location.origin + "/taskpane.html",
  },

  // Microsoft Graph
  graph: {
    baseUrl: "https://graph.microsoft.com/v1.0",
    scopes: ["User.Read", "Mail.Read", "Calendars.Read"],
  },

  // EPFL RCP API (OpenAI-compatible)
  rcp: {
    baseUrl: "https://inference.rcp.epfl.ch/v1",
    apiKey: "", // User sets this in the UI settings, or stored in localStorage
    defaultModel: "mistralai/Mistral-Small-3.2-24B-Instruct-2506-bfloat16",
    embeddingModel: "Qwen/Qwen3-Embedding-8B",
    completionsEndpoint: "/chat/completions",
    embeddingsEndpoint: "/embeddings",
  },

  // Feature defaults
  defaults: {
    maxEmailsToFetch: 50,
    maxEmailsForSummary: 30,
    maxEmailsPerParticipant: 200,
    embeddingTopK: 50,
    rerankTopK: 20,
  },
};
