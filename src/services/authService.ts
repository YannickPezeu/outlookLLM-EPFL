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
export async function getGraphToken(forceRefresh = false): Promise<string> {
  console.log(`[Auth] getGraphToken called (forceRefresh=${forceRefresh})`);

  // Pop-out dialog: token relayed from taskpane, but only if not expired
  const popoutToken = localStorage.getItem("graph_popout_token");
  if (popoutToken && !forceRefresh) {
    try {
      const payload = JSON.parse(atob(popoutToken.split(".")[1]));
      const expiresAt = payload.exp * 1000;
      if (expiresAt > Date.now() + 60_000) { // 1min margin
        console.log("[Auth] Using popout token (valid)");
        return popoutToken;
      }
      console.warn("[Auth] Popout token expired, removing");
      localStorage.removeItem("graph_popout_token");
    } catch {
      console.warn("[Auth] Popout token invalid, removing");
      localStorage.removeItem("graph_popout_token");
    }
  }

  // Dev mode: use manually pasted token (from Graph Explorer)
  const devToken = localStorage.getItem("graph_dev_token");
  if (devToken) {
    console.log("[Auth] Using dev token");
    return devToken;
  }

  if (!msalInstance) {
    await initAuth();
  }

  const account = getAccount();
  console.log(`[Auth] Account: ${account?.username || "NONE"}`);
  const tokenRequest = {
    scopes: config.graph.scopes,
    account: account || undefined,
    forceRefresh,
  };

  try {
    const result: AuthenticationResult = await msalInstance!.acquireTokenSilent(tokenRequest);
    // Decode exp from JWT to check if token is already expired
    return result.accessToken;
  } catch (error) {
    console.error(`[Auth] acquireTokenSilent FAILED:`, error);
    if (error instanceof InteractionRequiredAuthError) {
      return acquireTokenInteractive();
    }
    throw error;
  }
}

/**
 * Interactive login with mutex — only one popup at a time.
 * All concurrent callers await the same promise.
 */
let interactivePromise: Promise<string> | null = null;

export async function acquireTokenInteractive(): Promise<string> {
  if (interactivePromise) {
    console.log("[Auth] Interactive login already in progress, waiting...");
    return interactivePromise;
  }

  interactivePromise = (async () => {
    if (!msalInstance) {
      await initAuth();
    }

    const tokenRequest = {
      scopes: config.graph.scopes,
    };

    try {
      console.log("[Auth] Launching interactive login...");
      const result = await msalInstance!.acquireTokenPopup(tokenRequest);
      return result.accessToken;
    } catch (error) {
      console.error("[Auth] Interactive login failed:", error);
      throw error;
    } finally {
      interactivePromise = null;
    }
  })();

  return interactivePromise;
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
