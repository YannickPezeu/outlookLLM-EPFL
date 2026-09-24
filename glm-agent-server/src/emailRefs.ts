/**
 * Registre de refs courts pour les IDs d'emails — port serveur de
 * src/services/emailRefs.ts.
 *
 * Les IDs Graph font 100+ caractères : les remplacer par ref_N permet au
 * modèle de les recopier sans erreur (display_emails, read_email_attachments)
 * ET économise des tokens (~100 car./email sur des listes de 150).
 *
 * Un registre par CONVERSATION (sessionId Claude Code) : les refs du tour 1
 * doivent rester résolubles au tour 5. Le vrai ID ne quitte jamais le serveur
 * sauf dans les événements UI (email_list) où le frontend en a besoin pour
 * ouvrir l'email dans Outlook.
 */

export interface EmailRefMeta {
  realId: string;
  subject: string;
  date: string;
  from: string;
  direction: "received" | "sent" | "servicedesk";
}

export interface SerializedRefs {
  counter: number;
  refs: Record<string, EmailRefMeta>;
}

export class RefStore {
  private counter = 0;
  private byRef = new Map<string, EmailRefMeta>();
  private refByRealId = new Map<string, string>();

  /** Enregistre un email et retourne son ref court (stable pour un même ID). */
  makeRef(meta: EmailRefMeta): string {
    const existing = this.refByRealId.get(meta.realId);
    if (existing) return existing;
    const ref = `ref_${this.counter++}`;
    this.byRef.set(ref, meta);
    this.refByRealId.set(meta.realId, ref);
    return ref;
  }

  resolve(ref: string): EmailRefMeta | undefined {
    return this.byRef.get(ref);
  }

  /** Mode sans état : la table voyage avec la conversation côté client
   *  (événement SSE `refs` en fin de tour, champ `refs` au tour suivant). */
  toJSON(): SerializedRefs {
    return { counter: this.counter, refs: Object.fromEntries(this.byRef) };
  }

  static fromJSON(data: unknown): RefStore {
    const store = new RefStore();
    const d = data as Partial<SerializedRefs> | null | undefined;
    if (!d || typeof d.refs !== "object" || d.refs === null) return store;
    for (const [ref, meta] of Object.entries(d.refs)) {
      if (!meta || typeof meta.realId !== "string") continue;
      store.byRef.set(ref, meta);
      store.refByRealId.set(meta.realId, ref);
    }
    store.counter = Math.max(typeof d.counter === "number" ? d.counter : 0, store.byRef.size);
    return store;
  }
}

// ── Registres par session, avec éviction LRU simple ──────────────────
const MAX_STORES = 100;
const stores = new Map<string, RefStore>(); // insertion order = LRU approximatif

export function getOrCreateStore(sessionId: string | undefined): RefStore {
  if (sessionId) {
    const existing = stores.get(sessionId);
    if (existing) {
      // Rafraîchit la position LRU
      stores.delete(sessionId);
      stores.set(sessionId, existing);
      return existing;
    }
  }
  return new RefStore();
}

/** Associe un store (créé avant de connaître le sessionId) à sa session. */
export function adoptStore(sessionId: string, store: RefStore): void {
  if (stores.get(sessionId) === store) return;
  stores.set(sessionId, store);
  while (stores.size > MAX_STORES) {
    const oldest = stores.keys().next().value;
    if (oldest === undefined) break;
    stores.delete(oldest);
  }
}
