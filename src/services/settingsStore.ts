// Persistance des réglages utilisateur (clé API RCP, modèle, prompt perso, etc.).
//
// Problème constaté (09.2026) : chez certains collègues, la clé API est oubliée
// à chaque redémarrage d'Outlook. Les réglages n'étaient stockés qu'en
// localStorage, or sur Outlook desktop (WebView2) ce localStorage peut être
// isolé par surface et purgé à la fermeture ; sur le web, une politique
// « effacer les données de site à la fermeture » a le même effet.
//
// OfficeRuntime.storage est l'API prévue pour ça : persistante sur tous les
// hôtes Office et partagée entre les surfaces de l'add-in. Même approche que
// convStorage.ts pour la conversation.
//
// Le reste du code lit les réglages de façon SYNCHRONE via localStorage. On
// garde ce contrat : au démarrage, hydrateSettings() recopie dans localStorage
// ce qu'OfficeRuntime.storage connaît (source de vérité), puis chaque écriture
// passe par persistSetting() qui met à jour les deux.

interface KVStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function officeStore(): KVStore | null {
  const rt = (window as unknown as { OfficeRuntime?: { storage?: KVStore } }).OfficeRuntime;
  return rt && rt.storage ? rt.storage : null;
}

/** Toutes les clés de réglages persistées durablement. */
export const SETTING_KEYS = [
  "rcp_base_url",
  "rcp_api_key",
  "rcp_model",
  "user_custom_prompt",
  "ocr_enabled",
  "meeting_self_default",
  "assistant_engine",
  "assistant_thinking",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

/**
 * Recopie les réglages d'OfficeRuntime.storage vers localStorage.
 * OfficeRuntime.storage fait foi : il survit là où localStorage est purgé.
 * À appeler une fois au démarrage, avant le premier rendu / appel API.
 * Ne bloque jamais plus de `timeoutMs` (hôte sans OfficeRuntime, API lente).
 */
export async function hydrateSettings(timeoutMs = 1500): Promise<void> {
  const store = officeStore();
  if (!store) return;
  const work = (async () => {
    // Un seul aller-retour si l'API le permet, sinon clé par clé.
    const multi = (store as { getItems?: (k: string[]) => Promise<Record<string, string | null>> })
      .getItems;
    let values: Record<string, string | null>;
    if (typeof multi === "function") {
      values = await multi.call(store, [...SETTING_KEYS]);
    } else {
      values = {};
      await Promise.all(
        SETTING_KEYS.map(async (k) => {
          values[k] = await store.getItem(k);
        })
      );
    }
    for (const k of SETTING_KEYS) {
      const v = values[k];
      try {
        if (v != null) {
          localStorage.setItem(k, v);
        } else if (localStorage.getItem(k) != null) {
          // localStorage a une valeur qu'Office ignore (réglage saisi avant cette
          // migration) : on la promeut dans le stockage durable.
          await store.setItem(k, localStorage.getItem(k)!);
        }
      } catch {
        // localStorage indisponible : on continue, les lecteurs retomberont sur les défauts
      }
    }
  })();
  await Promise.race([
    work.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/**
 * Écrit (ou supprime si `value` est null) un réglage dans localStorage ET dans
 * OfficeRuntime.storage. Synchrone côté localStorage pour que les lecteurs
 * existants voient la valeur immédiatement ; l'écriture Office part en tâche de fond.
 */
export function persistSetting(key: SettingKey, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // quota / stockage bloqué : OfficeRuntime.storage prend le relais ci-dessous
  }
  const store = officeStore();
  if (!store) return;
  const p = value == null ? store.removeItem(key) : store.setItem(key, value);
  p.catch((e) => console.warn("[settings] OfficeRuntime.storage write failed for", key, e));
}
