import {
  createNestablePublicClientApplication,
  type IPublicClientApplication,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  InteractionRequiredAuthError,
} from "@azure/msal-browser";
import { config } from "../config";

/* global Office */

const msalConfig = {
  auth: {
    clientId: config.auth.clientId,
    authority: config.auth.authority,
    redirectUri: config.auth.redirectUri,
    supportsNestedAppAuth: true,
  },
};

let msalInstance: IPublicClientApplication | null = null;
let isNaa = false;

/**
 * Initialize MSAL. Tries Nested App Auth (NAA) first for seamless SSO,
 * falls back to standard MSAL SPA if NAA is not supported.
 */
export async function initAuth(): Promise<IPublicClientApplication> {
  if (msalInstance) return msalInstance;

  try {
    // Try NAA first (works in new Outlook desktop & web)
    msalInstance = await createNestablePublicClientApplication(msalConfig);
    isNaa = true;
    console.log("[Auth] NAA initialized successfully");
  } catch {
    // Fallback to standard MSAL SPA (older Outlook clients)
    console.log("[Auth] NAA not available, falling back to standard MSAL");
    msalInstance = await PublicClientApplication.createPublicClientApplication(msalConfig);
    isNaa = false;
  }

  return msalInstance;
}

/**
 * Get the currently signed-in account, or null if not signed in.
 */
export function getAccount(): AccountInfo | null {
  if (!msalInstance) return null;
  const accounts = msalInstance.getAllAccounts();
  return accounts.length > 0 ? accounts[0] : null;
}

/**
 * Acquire a Graph API access token silently, with interactive fallback.
 * In dev mode, uses a manually pasted Graph Explorer token from localStorage.
 */
export async function getGraphToken(): Promise<string> {
  // Dev mode: use manually pasted token (from Graph Explorer)
  const devToken = localStorage.getItem("graph_dev_token");
  if (devToken) {
    return devToken;
  }

  if (!msalInstance) {
    await initAuth();
  }

  const account = getAccount();
  const tokenRequest = {
    scopes: config.graph.scopes,
    account: account || undefined,
  };

  try {
    // Try silent token acquisition first
    const result: AuthenticationResult = await msalInstance!.acquireTokenSilent(tokenRequest);
    return result.accessToken;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      // Silent failed, need interactive login
      return acquireTokenInteractive();
    }
    throw error;
  }
}

/**
 * Interactive login - uses popup (works in both NAA and standard MSAL).
 */
async function acquireTokenInteractive(): Promise<string> {
  if (!msalInstance) throw new Error("MSAL not initialized");

  const tokenRequest = {
    scopes: config.graph.scopes,
  };

  try {
    const result = await msalInstance.acquireTokenPopup(tokenRequest);
    return result.accessToken;
  } catch (error) {
    console.error("[Auth] Interactive login failed:", error);
    throw error;
  }
}

/**
 * Sign out the current user.
 */
export async function signOut(): Promise<void> {
  if (!msalInstance) return;

  const account = getAccount();
  if (account) {
    await msalInstance.logoutPopup({ account });
  }
}

/**
 * Check if the user is currently authenticated.
 */
export function isAuthenticated(): boolean {
  return getAccount() !== null;
}

/**
 * Returns whether NAA is being used (vs standard MSAL).
 */
export function isUsingNaa(): boolean {
  return isNaa;
}
