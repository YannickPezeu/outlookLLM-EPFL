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

// In NAA mode the broker holds the session and getAllAccounts() can stay empty
// even though token acquisitions succeed. Track auth state ourselves: set to true
// on any successful token acquisition, and notify subscribers so the UI updates.
let tokenAuthenticated = false;
// Under NAA, logoutPopup can fail (the Office broker owns the session) and the
// MSAL account cache survives. This flag makes the sign-out stick in the UI
// until the next successful token acquisition.
let userSignedOut = false;
const authListeners = new Set<() => void>();

/**
 * Subscribe to auth state changes (sign-in, sign-out). Returns an unsubscribe fn.
 */
export function onAuthStateChanged(listener: () => void): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function notifyAuthChanged(): void {
  authListeners.forEach((l) => l());
}

/** Record a successful token acquisition and surface the account to MSAL's cache. */
function markAuthenticated(result: AuthenticationResult): void {
  const wasAuthenticated = tokenAuthenticated && !userSignedOut;
  tokenAuthenticated = true;
  userSignedOut = false;
  if (result.account) {
    try {
      msalInstance?.setActiveAccount(result.account);
    } catch {
      // setActiveAccount unsupported in some NAA hosts — account display is best-effort
    }
  }
  if (!wasAuthenticated) notifyAuthChanged();
}

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
  const active = msalInstance.getActiveAccount();
  if (active) return active;
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
    markAuthenticated(result);
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

    // Under NAA the Office broker owns the session and survives a local sign-out,
    // so a silent re-SSO usually succeeds without any popup. acquireTokenPopup is
    // the fragile path (popups get blocked / never close in Outlook Mac desktop),
    // so prefer ssoSilent first in NAA mode and keep it as a last-resort fallback.
    if (isNaa) {
      try {
        console.log("[Auth] Attempting silent SSO (NAA)...");
        const result = await msalInstance!.ssoSilent(tokenRequest);
        markAuthenticated(result);
        return result.accessToken;
      } catch (ssoError) {
        console.warn("[Auth] Silent SSO failed, falling back to popup:", ssoError);
      }
    }

    try {
      console.log("[Auth] Launching interactive login...");
      const result = await msalInstance!.acquireTokenPopup(tokenRequest);
      markAuthenticated(result);
      return result.accessToken;
    } catch (error) {
      console.error("[Auth] Interactive login (popup) failed:", error);
      // Last resort under NAA: the popup may be blocked while the broker session
      // is still valid — try a silent SSO before giving up.
      if (isNaa) {
        try {
          console.log("[Auth] Retrying silent SSO after popup failure (NAA)...");
          const result = await msalInstance!.ssoSilent(tokenRequest);
          markAuthenticated(result);
          return result.accessToken;
        } catch (ssoError) {
          console.error("[Auth] Silent SSO fallback also failed:", ssoError);
        }
      }
      throw error;
    } finally {
      interactivePromise = null;
    }
  })();

  return interactivePromise;
}

/**
 * Attempt a silent sign-in (no popup). Used at startup to connect by default
 * and to refresh the displayed auth status. Returns true on success.
 */
export async function trySilentSignIn(): Promise<boolean> {
  try {
    if (!msalInstance) await initAuth();
    const result = await msalInstance!.acquireTokenSilent({
      scopes: config.graph.scopes,
      account: getAccount() || undefined,
    });
    markAuthenticated(result);
    return true;
  } catch (error) {
    console.warn("[Auth] Silent sign-in failed:", error);
    return false;
  }
}

/**
 * Sign out the current user. In NAA mode the broker owns the session and
 * logout may be unsupported — we still clear our local state so the user
 * can re-trigger an interactive sign-in.
 */
export async function signOut(): Promise<void> {
  tokenAuthenticated = false;
  userSignedOut = true;
  localStorage.removeItem("graph_popout_token");

  try {
    const account = getAccount();
    if (msalInstance && account) {
      await msalInstance.logoutPopup({ account });
    }
  } catch (error) {
    console.warn("[Auth] logoutPopup failed (expected under NAA):", error);
  } finally {
    notifyAuthChanged();
  }
}

/**
 * Check if the user is currently authenticated.
 * Returns true for MSAL accounts, dev tokens, or relayed popout tokens.
 */
export function isAuthenticated(): boolean {
  if (userSignedOut) return false;
  if (tokenAuthenticated) return true;
  if (getAccount() !== null) return true;
  if (localStorage.getItem("graph_dev_token")) return true;
  const popoutToken = localStorage.getItem("graph_popout_token");
  if (popoutToken) {
    try {
      const payload = JSON.parse(atob(popoutToken.split(".")[1]));
      if (payload.exp * 1000 > Date.now() + 60_000) return true;
    } catch {
      // ignore malformed token
    }
  }
  return false;
}

/**
 * Returns whether NAA is being used (vs standard MSAL).
 */
export function isUsingNaa(): boolean {
  return isNaa;
}
