// Persistent key/value store for the assistant conversation.
//
// Uses OfficeRuntime.storage when available — it is the API designed to work
// across ALL Office hosts (web, desktop WebView2, mobile) and is shared between
// the add-in's surfaces (read pane ↔ reply/compose window), unlike localStorage
// which may be isolated per WebView on desktop. Falls back to localStorage when
// OfficeRuntime isn't present (e.g. the standalone test page outside Outlook).
//
// Every write is ALSO mirrored to localStorage so the `storage` event can keep
// simultaneously-open task-pane instances in sync on the web (OfficeRuntime.storage
// has no change event).

interface KVStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function officeStore(): KVStore | null {
  const rt = (window as unknown as { OfficeRuntime?: { storage?: KVStore } }).OfficeRuntime;
  return rt && rt.storage ? rt.storage : null;
}

/** Read the value, preferring OfficeRuntime.storage, falling back to localStorage. */
export async function loadConv(key: string): Promise<string | null> {
  const store = officeStore();
  if (store) {
    try {
      const v = await store.getItem(key);
      if (v != null) return v;
    } catch {
      // fall through to localStorage
    }
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Persist the value to OfficeRuntime.storage (if any) and mirror to localStorage. */
export async function saveConv(key: string, value: string): Promise<void> {
  // localStorage first: drives the cross-instance `storage` event on the web.
  try {
    localStorage.setItem(key, value);
  } catch {
    // quota — in-memory only
  }
  const store = officeStore();
  if (store) {
    try {
      await store.setItem(key, value);
    } catch {
      // ignore — localStorage mirror already holds it
    }
  }
}

/** Remove the value from both stores. */
export async function removeConv(key: string): Promise<void> {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
  const store = officeStore();
  if (store) {
    try {
      await store.removeItem(key);
    } catch {
      // ignore
    }
  }
}
