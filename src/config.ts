/**
 * Application configuration.
 * Replace placeholder values with your actual Azure AD and RCP API settings.
 */
export const config = {
  // Azure AD / Entra ID
  auth: {
    clientId: "YOUR_CLIENT_ID", // From Azure AD App Registration
    tenantId: "YOUR_TENANT_ID", // EPFL tenant ID
    authority: "https://login.microsoftonline.com/YOUR_TENANT_ID",
    redirectUri: window.location.origin + "/taskpane.html",
  },

  // Microsoft Graph
  graph: {
    baseUrl: "https://graph.microsoft.com/v1.0",
    scopes: ["User.Read", "Mail.Read", "Mail.ReadWrite"],
  },

  // EPFL RCP API (OpenAI-compatible)
  rcp: {
    baseUrl: "https://inference.rcp.epfl.ch/v1",
    apiKey: "", // User sets this in the UI settings, or stored in localStorage
    defaultModel: "mistralai/Mistral-Small-3.2-24B-Instruct-2506-bfloat16",
    completionsEndpoint: "/chat/completions",
  },

  // Feature defaults
  defaults: {
    maxEmailsToFetch: 50,
    maxEmailsForSummary: 30,
  },
};
