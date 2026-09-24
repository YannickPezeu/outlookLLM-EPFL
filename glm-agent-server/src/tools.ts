/**
 * Tools emails exposés au harness via un serveur MCP in-process.
 *
 * Les descriptions sont reprises de src/services/agentTools.ts (elles encodent
 * les leçons des évals — routage par sujet vs contact, modes avec/sans query).
 *
 * Fabrique PAR REQUÊTE : chaque requête /chat crée son serveur MCP avec le
 * token Graph de l'utilisateur en closure — le token ne vit que le temps de
 * la requête.
 */
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { GraphClient, GraphAuthError, type EmailMessage } from "./graphClient.js";
import { batchEmbed, rankBySimilarity } from "./embeddings.js";
import type { RefStore } from "./emailRefs.js";
import { extractTextFromAttachments } from "./attachments.js";
import { loadSkillContent, getSkillIds } from "./skills.js";
import { config } from "./config.js";
import { buildClientTools, type ClientToolDef } from "./clientTools.js";

/** Événement UI poussé directement au frontend (hors boucle LLM). */
export type UiEmitter = (eventType: string, data: Record<string, unknown>) => void;

/**
 * Profils d'agent : même serveur, capacités différentes selon le frontend.
 * - "outlook" : assistant email EPFL (tools Graph + KB + pipeline détaillé)
 * - "dpo"     : personalRAG (KB EPFL côté serveur + tools client déclarés par
 *               l'extension : search_local sur documents perso, search_web…)
 */
export type AgentProfile = "outlook" | "dpo";

/**
 * Descripteur moteur-agnostique d'un tool : permet aux moteurs alternatifs
 * (OpenHands via /internal/tool-exec) d'exécuter EXACTEMENT les mêmes tools
 * que le harness Claude Code, sans dupliquer la logique.
 */
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
  execute: (args: Record<string, unknown>) => Promise<string>;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function resultText(r: ToolResult): string {
  return r.content.map((c) => c.text).join("");
}

/** Email actuellement ouvert dans Outlook, transmis par l'add-in (Office.js). */
export interface CurrentEmailContext {
  /** ID REST Graph (convertToRestId côté frontend). */
  id: string;
  subject?: string;
  from?: string;
}

function bodySnippet(html?: string, preview?: string, maxChars = 2000): string {
  if (html) {
    return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxChars);
  }
  return preview?.slice(0, Math.min(maxChars, 500)) || "";
}

// ── Budgets de sortie des tools ──────────────────────────────────────
// Le harness plafonne les résultats de tools (~25k tokens) : au-delà, il
// remplace le résultat par une erreur "exceeds maximum allowed tokens" et le
// modèle repart en retries lents. On borne donc À LA SOURCE : peu d'emails
// avec corps, le reste en sujets seuls.
const LIST_MAX_ROWS = 150;      // mode liste (sans query) : sujets uniquement
const SEMANTIC_TOP_N = 60;      // mode query : emails retournés au total
const SEMANTIC_BODIES = 25;     // ... dont N avec corps (les plus pertinents)
const SEMANTIC_BODY_CHARS = 1200;
const SEARCH_BODIES = 20;       // search_emails : corps pour les N premiers
const SEARCH_BODY_CHARS = 1500;

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/**
 * Wrapper commun : transforme un GraphAuthError en message actionnable pour le
 * modèle (qui le relaie à l'utilisateur), au lieu de laisser le tool échouer
 * silencieusement ou renvoyer une liste vide trompeuse.
 */
function withAuthHandling<A>(handler: (args: A) => Promise<{ content: Array<{ type: "text"; text: string }> }>) {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (err) {
      if (err instanceof GraphAuthError) {
        return ok({
          error: "auth_expired",
          message:
            "⚠️ Le token Microsoft Graph est invalide ou expiré. " +
            "Informe l'utilisateur qu'il doit se reconnecter (onglet Config de l'add-in) et n'invente aucun résultat.",
        });
      }
      throw err;
    }
  };
}

export interface McpServerOptions {
  profile: AgentProfile;
  /** Token Graph délégué — requis pour le profil outlook. */
  graphToken?: string;
  refs: RefStore;
  emitUi: UiEmitter;
  currentEmail?: CurrentEmailContext;
  /** id_token Entra (délégué) pour la recherche KB ServiceNow. Optionnel. */
  kbToken?: string;
  /** Tools exécutés côté frontend (aller-retour SSE). */
  clientTools?: ClientToolDef[];
}

export function createAgentMcpServer(opts: McpServerOptions) {
  const { profile, refs, emitUi, currentEmail, kbToken } = opts;
  const graph = new GraphClient(opts.graphToken || "");

  // Registre des descripteurs (pour les moteurs alternatifs). defTool crée le
  // tool MCP (harness Claude Code) ET enregistre le descripteur en parallèle.
  const descriptors: ToolDescriptor[] = [];
  // Typage volontairement lâche sur `args` : les handlers sont typés par leur
  // destructuring, et le générique du SDK (tool) est incompatible avec une
  // signature générique intermédiaire (addQuestionMarks vs infer _output).
  const defTool = (
    name: string,
    description: string,
    shape: z.ZodRawShape,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (args: any) => Promise<ToolResult>
  ) => {
    descriptors.push({
      name,
      description,
      inputSchema: zodToJsonSchema(z.object(shape)) as Record<string, unknown>,
      execute: async (args) => resultText(await handler(args)),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return tool(name, description, shape, handler as any);
  };

  /** Enregistre un email dans le registre et retourne son ref court. */
  const toRef = (e: { id: string; subject?: string; date?: string; from?: string; direction?: string }): string =>
    refs.makeRef({
      realId: e.id,
      subject: e.subject ?? "(Sans sujet)",
      date: e.date ?? "",
      from: e.from ?? "?",
      direction: e.direction === "sent" ? "sent" : e.direction === "servicedesk" ? "servicedesk" : "received",
    });

  const searchContacts = defTool(
    "search_contacts",
    "Recherche des contacts par nom dans l'annuaire EPFL ET dans les emails de l'utilisateur. " +
      "Trouve n'importe quel collaborateur EPFL même sans historique d'échange. " +
      "Gère les noms partiels, les accents manquants, etc. " +
      "Retourne une liste de contacts avec nom, email, et le cas échéant fonction/département. " +
      "TOUJOURS utiliser cet outil avant les autres quand l'utilisateur mentionne un contact par nom.",
    { query: z.string().describe("Le nom (ou partie du nom) du contact à rechercher") },
    withAuthHandling(async ({ query }) => {
      const contacts = await graph.searchContactsByName(query);
      if (contacts.length === 0) {
        return ok({ message: `Aucun contact trouvé pour "${query}".`, contacts: [] });
      }
      return ok({ contacts });
    })
  );

  const getEmailInteractions = defTool(
    "get_email_interactions",
    "Récupère les emails échangés avec un contact : reçus, envoyés, ET tickets ServiceNow " +
      "(emails de 1234@epfl.ch qui mentionnent la personne — une partie des échanges passe par là, " +
      "l'expéditeur est alors le ServiceDesk et non la personne). " +
      "Nécessite le nom et l'adresse email. Supporte le filtrage par période via start_date/end_date.\n" +
      "DEUX MODES selon la présence de 'query' :\n" +
      "• SANS query → retourne la LISTE COMPLÈTE des emails (sujets + dates). " +
      "À utiliser quand l'utilisateur veut VOIR / LISTER ses emails avec un contact, sans critère de contenu.\n" +
      "• AVEC query → trie les emails par pertinence sémantique (embeddings) et retourne leurs sujets+CORPS " +
      "(extrait ~2000 car. — tu peux donc LIRE l'email et en extraire une info précise, ex: une URL, un montant).",
    {
      name: z.string().describe("Le nom complet du contact"),
      email: z.string().describe("L'adresse email exacte du contact"),
      start_date: z.string().optional().describe("Date de début ISO 8601 (ex: 2023-05-01T00:00:00Z). Optionnel."),
      end_date: z.string().optional().describe("Date de fin ISO 8601. Optionnel."),
      query: z.string().optional().describe("Recherche sémantique : filtre les emails par pertinence (ex: 'budget'). Optionnel."),
    },
    withAuthHandling(async ({ name, email, start_date, end_date, query }) => {
      const dateRange = start_date || end_date ? { startDate: start_date, endDate: end_date } : undefined;
      const MAX_PER_DIRECTION = 200;

      // Les corps ne sont nécessaires qu'au tri sémantique — le mode liste s'en
      // passe, ce qui rend la requête Graph nettement plus rapide.
      // Les tickets ServiceNow (de 1234@epfl.ch, personne mentionnée dans le
      // corps) font partie des échanges : fusionnés comme dans agentTools.ts.
      const [{ received, sent }, serviceDeskEmails] = await Promise.all([
        graph.getAllInteractions(email, MAX_PER_DIRECTION, dateRange, !!query),
        graph.getServiceDeskEmailsForPerson(name, MAX_PER_DIRECTION, dateRange),
      ]);
      console.log(
        `[tool] get_email_interactions(${email}): ${received.length} reçus, ${sent.length} envoyés, ${serviceDeskEmails.length} ServiceNow`
      );

      type Merged = EmailMessage & { direction: "received" | "sent" | "servicedesk"; displayDate: string };
      const allEmails: Merged[] = [
        ...received.map((e) => ({ ...e, direction: "received" as const, displayDate: e.receivedDateTime })),
        ...sent.map((e) => ({ ...e, direction: "sent" as const, displayDate: e.sentDateTime || e.receivedDateTime })),
        ...serviceDeskEmails.map((e) => ({
          ...e,
          direction: "servicedesk" as const,
          displayDate: e.receivedDateTime,
          subject: `[ServiceNow] ${e.subject}`,
        })),
      ];

      // ── Sans query → liste (sujets + dates), plafonnée ──
      if (!query) {
        const list = allEmails
          .map((e) => {
            const item = {
              subject: e.subject,
              date: e.displayDate,
              from: e.direction === "sent" ? "Moi"
                : e.direction === "servicedesk" ? "ServiceDesk"
                : e.from?.emailAddress?.name || e.from?.emailAddress?.address || "?",
              direction: e.direction,
            };
            return { id: toRef({ id: e.id, ...item }), ...item };
          })
          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        const shown = list.slice(0, LIST_MAX_ROWS);
        return ok({
          type: "email_list",
          name,
          email,
          total_count: list.length,
          shown_count: shown.length,
          truncated: list.length > LIST_MAX_ROWS
            ? `Liste limitée aux ${LIST_MAX_ROWS} plus récents sur ${list.length}. Pour une période précise utilise start_date/end_date ; pour un thème utilise query.`
            : null,
          emails: shown,
        });
      }

      // ── Avec query → tri sémantique, corps inclus ──
      let topEmails = allEmails;
      const MAX_FOR_EMBEDDINGS = 500;
      let capped = false;
      if (topEmails.length > MAX_FOR_EMBEDDINGS) {
        topEmails.sort((a, b) => new Date(b.displayDate).getTime() - new Date(a.displayDate).getTime());
        topEmails = topEmails.slice(0, MAX_FOR_EMBEDDINGS);
        capped = true;
      }

      if (topEmails.length > 0) {
        const texts = topEmails.map((e) => {
          const body = e.body?.content
            ? e.body.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 4000)
            : e.bodyPreview?.slice(0, 500) || "";
          return `${e.subject} ${body}`;
        });
        const [queryEmbedding, ...itemEmbeddings] = await batchEmbed([query, ...texts]);
        const ranked = rankBySimilarity(queryEmbedding, itemEmbeddings);
        const topN = Math.min(SEMANTIC_TOP_N, topEmails.length);
        topEmails = ranked.slice(0, topN).map((r) => topEmails[r.index]);
      }

      // Corps uniquement pour les plus PERTINENTS (ordre du ranking), pour
      // rester sous le plafond de tokens des résultats de tools.
      const withBody = new Set(topEmails.slice(0, SEMANTIC_BODIES).map((e) => e.id));
      const richEmails = [...topEmails].sort(
        (a, b) => new Date(b.displayDate).getTime() - new Date(a.displayDate).getTime()
      );
      const emailSummaries = richEmails.map((e) => {
        const item = {
          subject: e.subject,
          date: e.displayDate,
          direction: e.direction,
          from: e.direction === "sent" ? "Moi"
            : e.direction === "servicedesk" ? "ServiceDesk"
            : e.from?.emailAddress?.name || e.from?.emailAddress?.address || "?",
        };
        return {
          id: toRef({ id: e.id, ...item }),
          ...item,
          ...(withBody.has(e.id)
            ? { body: bodySnippet(e.body?.content, e.bodyPreview, SEMANTIC_BODY_CHARS) }
            : {}),
          has_attachments: !!e.hasAttachments,
        };
      });

      return ok({
        total_count: allEmails.length,
        returned_count: emailSummaries.length,
        query,
        capped: capped ? `Limité à ${MAX_FOR_EMBEDDINGS} emails sur ${allEmails.length} total` : null,
        emails: emailSummaries,
      });
    })
  );

  const searchEmails = defTool(
    "search_emails",
    "Recherche plein-texte dans les emails de l'utilisateur (sujets, corps, expéditeurs). " +
      "Rapide (une seule requête Graph, sans embeddings) et SANS borne de date par défaut (cherche depuis toujours). " +
      "Renvoie le CORPS (~2000 car.) de chaque résultat — tu peux donc lire l'email et en extraire une info précise (URL, montant…). " +
      "Le paramètre 'sender' permet de combiner expéditeur + contenu en une fois : " +
      "à utiliser dès que l'utilisateur précise DE QUI vient l'email cherché par mot-clé/sujet. " +
      "Supporte le filtrage par période via start_date/end_date.",
    {
      query: z.string().describe("Le texte / mots-clés à rechercher dans les emails"),
      sender: z.string().optional().describe(
        "Optionnel : restreint aux emails REÇUS d'un expéditeur (nom ou adresse email). " +
          "Utilise-le quand l'utilisateur dit « l'email de X qui parle de Y »."
      ),
      max_results: z.number().optional().describe("Nombre maximum de résultats (défaut: 100)"),
      start_date: z.string().optional().describe("Date de début ISO 8601. Optionnel."),
      end_date: z.string().optional().describe("Date de fin ISO 8601. Optionnel."),
    },
    withAuthHandling(async ({ query, sender, max_results, start_date, end_date }) => {
      const dateRange = start_date || end_date ? { startDate: start_date, endDate: end_date } : undefined;
      const emails = await graph.searchEmails(query, max_results || 100, dateRange, sender?.trim() || undefined);
      console.log(`[tool] search_emails("${query}"${sender ? `, from:${sender}` : ""}): ${emails.length} résultats`);

      // Corps pour les N premiers résultats seulement (Graph $search renvoie
      // par pertinence) — le reste en sujets, pour tenir le budget de tokens.
      const results = emails.map((e, i) => {
        const item = {
          subject: e.subject,
          from: e.from?.emailAddress?.name || e.from?.emailAddress?.address || "?",
          date: e.receivedDateTime,
          direction: "received" as const,
        };
        return {
          id: toRef({ id: e.id, ...item }),
          ...item,
          ...(i < SEARCH_BODIES ? { body: bodySnippet(e.body?.content, e.bodyPreview, SEARCH_BODY_CHARS) } : {}),
          has_attachments: !!e.hasAttachments,
        };
      });
      return ok({ count: results.length, emails: results });
    })
  );

  // ── Calendrier ────────────────────────────────────────────────────

  const getCalendarEvents = defTool(
    "get_calendar_events",
    "Récupère les événements du calendrier dans une période donnée. " +
      "Par défaut, retourne les événements des 7 prochains jours. " +
      "OBLIGATOIRE pour toute question sur les réunions, rendez-vous, agenda ou disponibilités — " +
      "ne jamais répondre sans appeler cet outil, même pour un simple 'ma prochaine réunion' ou 'la suivante'.",
    {
      start_date: z.string().optional().describe(
        "Date de début au format ISO 8601 en heure LOCALE de l'utilisateur (ex: 2025-01-15T00:00:00). Par défaut: maintenant."
      ),
      end_date: z.string().optional().describe(
        "Date de fin ISO 8601 en heure LOCALE. Par défaut: 7 jours après start_date. " +
          "Utilise une fenêtre LARGE : ne cale JAMAIS end_date sur l'heure exacte supposée d'un événement " +
          "(la borne est exclusive). Pour un événement « aujourd'hui », couvre toute la journée (jusqu'à 23:59)."
      ),
    },
    withAuthHandling(async ({ start_date, end_date }) => {
      const now = new Date();
      const startDate = start_date || now.toISOString();
      const endDate = end_date || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const events = await graph.getCalendarView(startDate, endDate);
      console.log(`[tool] get_calendar_events(${startDate.slice(0, 10)} → ${endDate.slice(0, 10)}): ${events.length} événements`);

      const eventSummaries = events.map((e) => ({
        id: e.id,
        subject: e.subject,
        start: e.start.dateTime,
        end: e.end.dateTime,
        startLocal: formatLocalDateTime(e.start.dateTime, e.start.timeZone),
        endLocal: formatLocalDateTime(e.end.dateTime, e.end.timeZone),
        location: e.location?.displayName,
        attendees: e.attendees.map((a) => ({ name: a.emailAddress.name, email: a.emailAddress.address })),
        isOrganizer: e.isOrganizer,
      }));
      return ok({ events: eventSummaries, count: events.length });
    })
  );

  // ── Créneaux communs (free/busy) ──────────────────────────────────

  const findCommonSlots = defTool(
    "find_common_slots",
    "Trouve des créneaux horaires de réunion en consultant le free/busy des participants via l'API Graph getSchedule. " +
      "Ne voit PAS le détail des événements des collègues, seulement libre/occupé/tentatif/absent. " +
      "Par défaut cherche sur 7 jours en heures ouvrées (9h–18h, lun–ven), créneaux de 30 min. " +
      "Comportement : (1) si des créneaux où TOUT LE MONDE est libre existent, ils sont retournés en priorité " +
      "(`all_free_slot_found: true`). (2) Sinon, FALLBACK automatique : retourne les meilleurs créneaux disponibles " +
      "ordonnés par nombre de personnes libres (`fallback_mode: true`). " +
      "Chaque créneau indique `free_participants` et `busy_participants` — utilise ces listes pour expliquer à l'utilisateur " +
      "qui est libre et qui ne l'est pas. " +
      "Usage typique : 'trouve un créneau avec X et Y' (include_self=true) ou 'quand est libre Alexandre ?' (include_self=false).",
    {
      participants: z.array(z.string()).describe("Liste des adresses email des participants à interroger (max 20)."),
      include_self: z.boolean().describe(
        "OBLIGATOIRE — décider selon l'intention. true si la réunion inclut l'utilisateur courant " +
          "(ex: 'trouve un créneau pour qu'on se voie avec Y'). false si on cherche uniquement la disponibilité " +
          "d'autres personnes (ex: 'quand est libre Alexandre ?')."
      ),
      duration_minutes: z.number().optional().describe("Durée souhaitée en minutes (défaut: 30, multiples de 30 recommandés)."),
      start_date: z.string().optional().describe("Début de la fenêtre de recherche (ISO 8601). Défaut: maintenant."),
      end_date: z.string().optional().describe("Fin de la fenêtre (ISO 8601). Défaut: 7 jours après start_date."),
      days_of_week: z.array(z.number()).optional().describe(
        "Jours autorisés (0=dimanche … 6=samedi). Ex: [2, 4] pour 'mardi et jeudi'. Si absent : lun-ven (ou lun-dim si include_weekends)."
      ),
      time_restriction: z.object({
        start: z.string().describe("Heure de début 'HH:MM' (ex: '15:00')."),
        end: z.string().describe("Heure de fin 'HH:MM' (ex: '17:00')."),
      }).optional().describe(
        "Fenêtre horaire stricte dans la journée. À utiliser quand l'utilisateur précise une plage : 'entre 15h et 17h', 'le matin'."
      ),
      working_hours_start: z.number().optional().describe("Heure de début de journée 0-23 (défaut: 9). Ignoré si time_restriction."),
      working_hours_end: z.number().optional().describe("Heure de fin de journée 0-23 (défaut: 18). Ignoré si time_restriction."),
      include_weekends: z.boolean().optional().describe("Inclure samedi/dimanche (défaut: false). Ignoré si days_of_week."),
      max_results: z.number().optional().describe("Nombre max de créneaux à retourner (défaut: 10)."),
    },
    withAuthHandling(async (args) => {
      const result = await findCommonSlotsImpl(graph, args);
      return ok(result);
    })
  );

  // ── ServiceDesk : contacts dans les tickets ──────────────────────

  const searchContactsInServicedesk = defTool(
    "search_contacts_in_servicedesk",
    "Recherche des PERSONNES dans les emails du ServiceDesk EPFL (tickets ServiceNow de 1234@epfl.ch). " +
      "Utile quand search_contacts ne trouve pas la personne, car certains échanges " +
      "passent uniquement par des tickets où la personne est mentionnée dans le corps. " +
      "Retourne les noms trouvés avec leur nombre de tickets.",
    { query: z.string().describe("Le nom (ou partie du nom) de la personne à chercher dans les tickets") },
    withAuthHandling(async ({ query }) => {
      const results = await graph.searchContactsInServiceDesk(query);
      if (results.length === 0) {
        return ok({ message: `Aucun contact trouvé pour "${query}" dans les emails ServiceDesk.`, contacts: [] });
      }
      return ok({ contacts: results });
    })
  );

  // ── Affichage de listes cliquables dans l'UI ─────────────────────

  const displayEmails = defTool(
    "display_emails",
    "Affiche dans l'interface une LISTE FILTRÉE d'emails sous forme de cartes cliquables. " +
      "À utiliser après avoir récupéré une liste via get_email_interactions / search_emails " +
      "et SÉLECTIONNÉ les emails réellement pertinents (par sujet, expéditeur, date, ou tout autre critère du user). " +
      "Tu fournis uniquement les refs courts (ex: ['ref_3', 'ref_7']) — l'UI génère automatiquement la liste. " +
      "Ne JAMAIS réécrire toi-même la liste des emails après cet appel : juste une phrase d'introduction.",
    {
      email_ids: z.array(z.string()).describe(
        "Liste ordonnée des refs des emails à afficher (ex: ['ref_3', 'ref_7']). " +
          "Doivent provenir d'un appel précédent dans CETTE conversation."
      ),
      context_label: z.string().optional().describe(
        "Optionnel : étiquette courte pour identifier le filtrage (ex: 'IA', 'budget 2025'). Affichée en en-tête."
      ),
    },
    async ({ email_ids, context_label }) => {
      const resolved: Array<{ id: string; subject: string; date: string; from: string; direction: "received" | "sent" }> = [];
      const missing: string[] = [];
      for (const ref of email_ids) {
        const meta = refs.resolve(ref);
        if (!meta) {
          missing.push(ref);
          continue;
        }
        resolved.push({
          id: meta.realId, // l'UI a besoin du vrai ID Graph pour ouvrir l'email
          subject: meta.subject,
          date: meta.date,
          from: meta.from,
          direction: meta.direction === "sent" ? "sent" : "received",
        });
      }
      console.log(`[tool] display_emails: ${resolved.length} résolus${missing.length ? `, ${missing.length} refs inconnus` : ""}`);
      if (resolved.length === 0) {
        return ok({ error: "Aucun email à afficher. Les refs fournis ne correspondent à aucun email vu dans cette conversation.", invalid_refs: missing });
      }
      emitUi("email_list", { name: context_label || null, emails: resolved });
      return ok({
        displayed: resolved.length,
        missing_refs: missing.length > 0 ? missing : undefined,
        note: "Liste affichée dans l'interface. Écris UNE phrase d'introduction, sans répéter les emails.",
      });
    }
  );

  // ── Pièces jointes ────────────────────────────────────────────────

  const readEmailAttachments = defTool(
    "read_email_attachments",
    "Lit et extrait le CONTENU TEXTE des pièces jointes d'UN email précis " +
      "(formats : PDF, DOCX, XLSX, PPTX, TXT, CSV, HTML ; max 20 Mo/fichier ; ~10 000 caractères extraits par fichier ; " +
      "images/inline ignorées ; PDF scannés non extraits — pas d'OCR côté serveur). " +
      "À utiliser UNIQUEMENT quand la pièce jointe est jugée IMPORTANTE pour répondre. " +
      "Les résultats d'emails marquent has_attachments:true. " +
      "NE PAS appeler en masse ni « au cas où » : chaque appel consomme du contexte. Un seul email par appel.",
    {
      email_id: z.string().describe(
        "Le ref court de l'email dont lire les pièces jointes (ex: 'ref_7'). " +
          "Doit provenir d'un résultat précédent de CETTE conversation."
      ),
    },
    withAuthHandling(async ({ email_id }) => {
      const meta = refs.resolve(email_id);
      if (!meta) {
        return ok({ error: `Ref introuvable: "${email_id}". Utilise un ref d'email vu plus tôt dans cette conversation.` });
      }
      const attachments = await graph.getMessageAttachments(meta.realId);
      const { texts, skipped } = await extractTextFromAttachments(attachments, 10000, (m) => console.log(`[attachments] ${m}`));

      if (texts.length === 0) {
        return ok({
          ref: email_id,
          attachments: [],
          skipped,
          note: "Aucune pièce jointe exploitable.",
        });
      }
      const MAX_ATTACHMENTS = 3;
      const returned = texts.slice(0, MAX_ATTACHMENTS);
      return ok({
        ref: email_id,
        attachment_count: texts.length,
        returned_count: returned.length,
        truncated: texts.length > MAX_ATTACHMENTS,
        skipped: skipped.length > 0 ? skipped : undefined,
        attachments: returned.map((a) => ({ name: a.name, chars: a.text.length, text: a.text })),
      });
    })
  );

  // ── Email actuellement ouvert dans Outlook ───────────────────────

  const getCurrentEmail = defTool(
    "get_current_email",
    "Lit l'email ACTUELLEMENT OUVERT dans Outlook (corps + pièces jointes : PDF, DOCX, XLSX, PPTX, TXT, CSV, HTML) " +
      "et retourne son contenu complet pour que TU le résumes ou l'analyses. " +
      "À utiliser dès que l'utilisateur parle de « cet email », « ce mail », « le message ouvert », " +
      "« ce qui est demandé dans ce mail » — sans qu'il ait besoin de préciser un contact ni un ref. " +
      "Ne prend AUCUN paramètre. Après l'appel, suis le champ \"instructions\" du résultat.",
    {},
    withAuthHandling(async () => {
      if (!currentEmail?.id) {
        return ok({
          error:
            "Aucun email ouvert dans Outlook (ou l'add-in n'a pas pu transmettre son identifiant). " +
            "Demande à l'utilisateur d'ouvrir l'email concerné, ou de te donner expéditeur/sujet pour une recherche.",
        });
      }
      console.log(`[tool] get_current_email: «${currentEmail.subject || "?"}»`);
      const email = await graph.getEmail(currentEmail.id);
      const body = email.body?.content
        ? bodySnippet(email.body.content, email.bodyPreview, 20000)
        : email.bodyPreview || "";

      let attachmentTexts: Array<{ name: string; text: string }> = [];
      let skipped: Array<{ name: string; reason: string }> = [];
      if (email.hasAttachments) {
        const raw = await graph.getMessageAttachments(currentEmail.id);
        const extraction = await extractTextFromAttachments(raw, 30000, (m) => console.log(`[attachments] ${m}`));
        attachmentTexts = extraction.texts;
        skipped = extraction.skipped;
      }

      if (!body.trim() && attachmentTexts.length === 0) {
        return ok({ error: "Email vide et aucune pièce jointe lisible — rien à résumer." });
      }

      return ok({
        subject: email.subject || "(sans objet)",
        from: email.from?.emailAddress?.name || email.from?.emailAddress?.address || null,
        date: email.receivedDateTime,
        body,
        attachments: attachmentTexts.map((a) => ({ name: a.name, chars: a.text.length, text: a.text })),
        attachments_analyzed: attachmentTexts.length,
        skipped_attachments: skipped.length > 0 ? skipped : undefined,
        instructions:
          "Résume cet email pour un membre du personnel dirigeant EPFL, en français, en combinant le CORPS et les PIÈCES JOINTES " +
          "(ne les traite pas séparément — synthétise l'ensemble). Structure en markdown avec exactement ces sections : " +
          "## Contexte / projet, ## Ce qui est demandé, ## Échéances, ## Points d'attention. " +
          "Reste factuel, n'invente rien, signale ce qui est ambigu ou absent. Si une section est vide, écris « Rien à signaler ».",
      });
    })
  );

  // ── Base de connaissances EPFL (KBs ServiceNow + site) ───────────

  const searchEpflKnowledge = defTool(
    "search_epfl_knowledge",
    "Recherche dans la BASE DE CONNAISSANCES EPFL : articles KB ServiceNow (procédures IT, " +
      "RH, administration — préfixés [KB]), incidents résolus ([INC]) et pages du site EPFL. " +
      "Résultats filtrés selon les droits de l'utilisateur connecté. " +
      "À utiliser pour les questions de type « comment faire X à l'EPFL », « quelle est la procédure pour Y », " +
      "« qui contacter pour Z » — PAS pour chercher dans les emails de l'utilisateur (utilise search_emails).",
    {
      query: z.string().describe("La question ou les mots-clés à chercher dans la base de connaissances"),
      top_k: z.number().optional().describe("Nombre de résultats (défaut: 8)"),
    },
    async ({ query, top_k }) => {
      if (!kbToken) {
        return ok({
          error: "kb_token_missing",
          message:
            "La recherche dans la base de connaissances n'est pas disponible : l'add-in n'a pas transmis " +
            "d'id_token Entra (mode dev token ?). Informe l'utilisateur et propose une alternative (search_emails).",
        });
      }
      const resp = await fetch(config.kbSearchUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${kbToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, rerank: true, top_k: top_k || 8 }),
      });
      if (resp.status === 401 || resp.status === 403) {
        return ok({
          error: "kb_auth_rejected",
          message:
            `Le service de recherche KB a refusé le token (${resp.status}). ` +
            "Le token de l'add-in n'est probablement pas encore autorisé côté hierarchical-search/ServiceNow. " +
            "Informe l'utilisateur que cette capacité nécessite une configuration supplémentaire.",
        });
      }
      if (!resp.ok) {
        return ok({ error: "kb_error", message: `Recherche KB indisponible (HTTP ${resp.status}).` });
      }
      const nodes = (await resp.json()) as Array<{
        title?: string;
        precise_content?: string;
        context_content?: string;
        score?: number;
        source_url?: string;
        header_path?: string;
      }>;
      console.log(`[tool] search_epfl_knowledge("${query}"): ${nodes.length} résultats`);
      return ok({
        count: nodes.length,
        results: nodes.map((n) => ({
          title: n.title,
          content: (n.precise_content || n.context_content || "").slice(0, 1500),
          url: n.source_url,
          section: n.header_path,
          score: n.score,
        })),
      });
    }
  );

  // ── Site EPFL : recherche arborescente (pages -> contenu -> contexte) ──
  //
  // Trois primitives à enchaîner. L'agent choisit lui-même les pages à ouvrir
  // entre l'étape 1 et l'étape 2 : la navigation dans l'arborescence du site
  // est un comportement émergent du tool-calling, il n'y a pas d'orchestrateur.

  /** Appel commun aux 3 routes coarse-to-fine. */
  async function epflSearchFetch(path: string, init: RequestInit = {}) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (kbToken) headers["Authorization"] = `Bearer ${kbToken}`;
    else if (config.epflSearch.apiKey) headers["X-API-Key"] = config.epflSearch.apiKey;
    else {
      return {
        error: "epfl_search_token_missing",
        message:
          "La recherche sur le site EPFL n'est pas disponible : aucun id_token Entra transmis. " +
          "Informe l'utilisateur et propose search_epfl_knowledge à la place.",
      };
    }

    const resp = await fetch(`${config.epflSearch.baseUrl}${path}`, { ...init, headers });
    if (resp.status === 401 || resp.status === 403) {
      return {
        error: "epfl_search_auth_rejected",
        message:
          `Le service de recherche a refusé le token (${resp.status}). Cette capacité ` +
          "nécessite une configuration supplémentaire — ne fabrique aucun résultat.",
      };
    }
    if (resp.status === 404) {
      return {
        error: "epfl_search_not_found",
        message: `Ressource introuvable (${path}).`,
      };
    }
    if (!resp.ok) {
      const body = await resp.text();
      return {
        error: "epfl_search_error",
        message: `Recherche indisponible (HTTP ${resp.status}) : ${body.slice(0, 200)}`,
      };
    }
    return await resp.json();
  }

  const lib = () => encodeURIComponent(config.epflSearch.library);

  const searchEpflPages = defTool(
    "search_epfl_pages",
    "ÉTAPE 1 — trouve QUELLES PAGES du site EPFL (www.epfl.ch, sti.epfl.ch, edu.epfl.ch) " +
      "traitent d'un sujet. Retourne des descripteurs de pages : titre, fil d'Ariane, résumé, URL — " +
      "PAS le contenu. C'est le point d'entrée OBLIGATOIRE pour toute question sur le site EPFL " +
      "(laboratoires, formations, cours du coursebook, services, procédures internes du site). " +
      "Lis les résumés, choisis les pages pertinentes, puis appelle search_epfl_content avec leurs " +
      "URLs pour lire le contenu. Un fil d'Ariane te dit où tu es dans l'arborescence : sers-t'en " +
      "pour élargir ou resserrer (ex. remonter d'un cours à toute une section).",
    {
      query: z.string().describe("Le sujet recherché, en langage naturel"),
      top_k: z.number().optional().describe("Nombre de pages à retourner (défaut: 20, max: 100)"),
    },
    async ({ query, top_k }) => {
      const data = await epflSearchFetch(`/pages/${lib()}`, {
        method: "POST",
        body: JSON.stringify({ query, top_k: top_k || 20 }),
      });
      if (!Array.isArray(data)) return ok(data);
      console.log(`[tool] search_epfl_pages("${query}"): ${data.length} pages`);
      return ok({
        count: data.length,
        hint: "Choisis les pages pertinentes et passe leurs `url` à search_epfl_content.",
        pages: data.map((p: Record<string, unknown>) => ({
          url: p.url,
          title: p.title,
          summary: p.summary,
          breadcrumb: p.breadcrumb,
        })),
      });
    }
  );

  const searchEpflContent = defTool(
    "search_epfl_content",
    "ÉTAPE 2 — lit le CONTENU des pages EPFL, en se limitant aux pages choisies. " +
      "EXIGE `path_prefixes` : passe les `url` retournées par search_epfl_pages. " +
      "N'appelle JAMAIS ce tool sans avoir fait search_epfl_pages avant — sans préfixes il échoue, " +
      "et c'est volontaire : chercher dans tout le site ramène du bruit d'autres facettes. " +
      "Un préfixe court élargit la recherche à toute une branche " +
      "(ex. 'www.epfl.ch/education/master' couvre tous les masters). " +
      "Retourne des extraits courts ; si un extrait est prometteur mais tronqué, appelle expand_passage.",
    {
      query: z.string().describe("Ce que tu cherches dans ces pages"),
      path_prefixes: z
        .array(z.string())
        .describe("URLs ou préfixes issus de search_epfl_pages (liste non vide)"),
      top_k: z.number().optional().describe("Nombre d'extraits (défaut: 10, max: 50)"),
    },
    async ({ query, path_prefixes, top_k }) => {
      if (!path_prefixes?.length) {
        return ok({
          error: "path_prefixes_manquant",
          message:
            "Appelle d'abord search_epfl_pages, puis passe ici les URLs des pages pertinentes.",
        });
      }
      const data = await epflSearchFetch(`/chunks/${lib()}`, {
        method: "POST",
        body: JSON.stringify({ query, path_prefixes, top_k: top_k || 10 }),
      });
      if (!Array.isArray(data)) return ok(data);
      console.log(
        `[tool] search_epfl_content("${query}", ${path_prefixes.length} préfixes): ${data.length} extraits`
      );
      return ok({
        count: data.length,
        hint: "Pour un extrait tronqué ou ambigu, appelle expand_passage avec son chunk_id.",
        passages: data.map((c: Record<string, unknown>) => ({
          chunk_id: c.chunk_id,
          text: c.text_512,
          url: c.url,
          title: c.title,
        })),
      });
    }
  );

  const expandPassage = defTool(
    "expand_passage",
    "ÉTAPE 3 (optionnelle) — élargit un extrait retourné par search_epfl_content à son " +
      "passage complet (section entière, quelques milliers de caractères). " +
      "À utiliser quand un extrait est manifestement coupé, quand un tableau apparaît partiel, " +
      "ou quand il te faut le contexte autour d'un chiffre ou d'une condition pour répondre " +
      "sans deviner. Inutile si l'extrait se suffit à lui-même.",
    {
      chunk_id: z.string().describe("Le chunk_id d'un extrait retourné par search_epfl_content"),
    },
    async ({ chunk_id }) => {
      const data = await epflSearchFetch(
        `/chunks/${lib()}/${encodeURIComponent(chunk_id)}/expand`
      );
      if (data?.error) return ok(data);
      console.log(`[tool] expand_passage(${chunk_id}): ${(data.text || "").length} chars`);
      return ok({ text: data.text, url: data.url });
    }
  );

  // ── Rapport détaillé (pipeline frontend délégué) ──────────────────

  const summarizeExchanges = defTool(
    "summarize_exchanges",
    "Lance le RAPPORT VÉRIFIABLE des échanges avec une ou plusieurs personnes : analyse approfondie " +
      "de TOUS les emails de la période, rapport structuré avec EMAILS SOURCES CLIQUABLES " +
      "+ document Word téléchargé automatiquement. Exécuté par l'interface (pas par toi) : le rapport " +
      "s'affiche en streaming dans la conversation après ta réponse.\n" +
      "QUAND L'UTILISER — quand l'utilisateur demande un résumé/point sur ses échanges avec quelqu'un, " +
      "pose-lui UNE SEULE question :\n" +
      "(a) un résumé rapide pour se rafraîchir la mémoire → N'UTILISE PAS ce tool ; improvise toi-même " +
      "à partir de get_email_interactions ;\n" +
      "(b) un rapport vérifiable avec liens cliquables vers chaque email source → appelle ce tool " +
      "DIRECTEMENT, sans autre question (période par défaut : 6 derniers mois, sauf si l'utilisateur " +
      "en a précisé une spontanément).",
    {
      people: z.array(z.object({
        name: z.string().describe("Nom complet de la personne"),
        email: z.string().describe("Adresse email exacte (résolue via search_contacts)"),
      })).describe("Les personnes à analyser"),
      focus: z.string().optional().describe(
        "Optionnel : angle d'attaque SI l'utilisateur en a exprimé un spontanément (ex: 'aspects budgétaires'). Vide sinon — ne pas le demander."
      ),
      language: z.string().optional().describe("Langue de rédaction (défaut: français)."),
      start_date: z.string().optional().describe("Début de période ISO 8601, SI précisé spontanément. Défaut: 6 derniers mois."),
      end_date: z.string().optional().describe("Fin de période ISO 8601. Défaut: aujourd'hui."),
    },
    async ({ people, focus, language, start_date, end_date }) => {
      if (!people?.length) {
        return ok({ error: "people requis (résous les contacts via search_contacts d'abord)." });
      }
      // Le vérifiable part TOUJOURS en mode approfondi (choix produit : pas de
      // second choix soft/deep imposé à l'utilisateur).
      console.log(`[tool] summarize_exchanges → délégué au frontend (${people.map((p: { name: string }) => p.name).join(", ")}, deep)`);
      emitUi("run_summarize_exchanges", { people, mode: "deep", focus, language, start_date, end_date });
      return ok({
        launched: true,
        note:
          "Le pipeline détaillé est lancé côté interface : le rapport va s'afficher en streaming " +
          "dans la conversation et le document Word se télécharger automatiquement. " +
          "NE RÉDIGE AUCUN résumé toi-même — conclus par UNE seule phrase courte " +
          "(ex: « Le rapport détaillé arrive ci-dessous. ») puis termine ton tour.",
      });
    }
  );

  // ── Skills (workflows guidés) ─────────────────────────────────────

  const loadSkill = defTool(
    "load_skill",
    "Charge les instructions détaillées d'un skill (workflow guidé) AVANT de traiter la demande. " +
      "À appeler dès que la demande correspond à un skill du catalogue (voir system prompt) — " +
      "les instructions du skill encodent les bonnes pratiques apprises (routage, filtrage, présentation).",
    {
      skill_id: z.enum(getSkillIds() as [string, ...string[]]).describe("L'identifiant du skill à charger"),
    },
    async ({ skill_id }) => {
      const content = await loadSkillContent(skill_id);
      console.log(`[tool] load_skill(${skill_id})`);
      return ok({ skill_id, instructions: content });
    }
  );

  // ── Assemblage par profil ─────────────────────────────────────────

  const { tools: clientToolInstances, descriptors: clientDescriptors } = buildClientTools(
    opts.clientTools || [],
    emitUi
  );

  const outlookTools = [
    searchContacts,
    getEmailInteractions,
    searchEmails,
    getCalendarEvents,
    findCommonSlots,
    searchContactsInServicedesk,
    displayEmails,
    readEmailAttachments,
    getCurrentEmail,
    summarizeExchanges,
    searchEpflKnowledge,
    // Recherche arborescente sur le site EPFL — complète search_epfl_knowledge
    // (qui reste le bon outil pour les KB ServiceNow et les incidents).
    searchEpflPages,
    searchEpflContent,
    expandPassage,
    loadSkill,
  ];
  // Profil dpo : tous les tools sont CLIENT (search_local, search_epfl,
  // search_web exécutés par l'extension) — leurs résultats alimentent ainsi le
  // corpus de citations [N] de l'UI (passages cliquables surlignés dans la
  // source), ce que le tool serveur search_epfl_knowledge court-circuitait.
  const dpoTools: typeof outlookTools = [];

  const tools = [...(profile === "dpo" ? dpoTools : outlookTools), ...clientToolInstances];

  // Descripteurs correspondant au toolset effectif du profil (mêmes noms que
  // `tools`) — consommés par les moteurs alternatifs via /internal/tool-exec.
  const activeNames = new Set(tools.map((t) => (t as { name: string }).name));
  const allDescriptors: ToolDescriptor[] = [
    ...descriptors.filter((d) => activeNames.has(d.name)),
    ...clientDescriptors,
  ];

  return {
    server: createSdkMcpServer({ name: "outlook", version: "0.1.0", tools }),
    allowedToolNames: tools.map((t) => `mcp__outlook__${(t as { name: string }).name}`),
    descriptors: allDescriptors,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatLocalDateTime(dateTime: string, timeZone: string): string {
  // Graph renvoie des heures "murales" dans le TZ demandé via le header Prefer,
  // sans suffixe Z/offset. On parse en forçant UTC puis on formate en UTC pour
  // afficher les composants tels quels (sans reconversion), en précisant le TZ.
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(dateTime) ? dateTime : `${dateTime}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return `${dateTime} (${timeZone})`;
  return d.toLocaleString("fr-CH", { timeZone: "UTC", dateStyle: "full", timeStyle: "short" }) + ` (${timeZone})`;
}

interface FindSlotsArgs {
  participants: string[];
  include_self: boolean;
  duration_minutes?: number;
  start_date?: string;
  end_date?: string;
  days_of_week?: number[];
  time_restriction?: { start: string; end: string };
  working_hours_start?: number;
  working_hours_end?: number;
  include_weekends?: boolean;
  max_results?: number;
}

/**
 * Algorithme de créneaux communs — port fidèle de l'exécuteur find_common_slots
 * d'agentTools.ts (scoring par tiers, fallback partiel, un créneau par jour
 * d'abord). Seule différence : l'email de l'utilisateur vient de /me (pas de
 * MSAL côté serveur).
 */
async function findCommonSlotsImpl(graph: GraphClient, args: FindSlotsArgs): Promise<Record<string, unknown>> {
  const durationMin = args.duration_minutes || 30;
  const maxResults = args.max_results || 10;
  const INTERVAL_MIN = 30;

  // Jours autorisés (convention JS getDay() : 0=dim..6=sam)
  let allowedDays: Set<number>;
  if (Array.isArray(args.days_of_week) && args.days_of_week.length > 0) {
    allowedDays = new Set(args.days_of_week.filter((d) => d >= 0 && d <= 6));
  } else {
    allowedDays = (args.include_weekends ?? false) ? new Set([0, 1, 2, 3, 4, 5, 6]) : new Set([1, 2, 3, 4, 5]);
  }

  // Fenêtre horaire dans la journée (minutes depuis minuit)
  const parseHHMM = (s: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!m) return null;
    const h = +m[1], mm = +m[2];
    if (h < 0 || h > 24 || mm < 0 || mm > 59) return null;
    return h * 60 + mm;
  };
  let dayStartMin: number;
  let dayEndMin: number;
  if (args.time_restriction?.start && args.time_restriction?.end) {
    const a = parseHHMM(args.time_restriction.start);
    const b = parseHHMM(args.time_restriction.end);
    if (a == null || b == null || a >= b) {
      return { error: `time_restriction invalide: '${args.time_restriction.start}'–'${args.time_restriction.end}' (format 'HH:MM', start < end).` };
    }
    dayStartMin = a;
    dayEndMin = b;
  } else {
    dayStartMin = (args.working_hours_start ?? 9) * 60;
    dayEndMin = (args.working_hours_end ?? 18) * 60;
  }

  // Participants (+ l'utilisateur connecté si include_self)
  const emails = [...args.participants.map((e) => e.trim()).filter(Boolean)];
  if (args.include_self) {
    const selfEmail = await graph.getMyEmail();
    if (selfEmail && !emails.some((e) => e.toLowerCase() === selfEmail.toLowerCase())) {
      emails.unshift(selfEmail);
    }
  }
  if (emails.length === 0) return { error: "Aucun participant fourni." };
  if (emails.length > 20) return { error: `Trop de participants (${emails.length}), max 20 supportés par getSchedule.` };

  // Fenêtre : défaut maintenant → +7j, alignée sur 30 min
  const now = new Date();
  const rawStart = args.start_date ? new Date(args.start_date) : now;
  const startDate = rawStart.getTime() < now.getTime() ? now : rawStart;
  const endDate = args.end_date ? new Date(args.end_date) : new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);

  const alignedStart = new Date(startDate);
  alignedStart.setSeconds(0, 0);
  alignedStart.setMinutes(Math.ceil(alignedStart.getMinutes() / INTERVAL_MIN) * INTERVAL_MIN);
  if (endDate.getTime() <= alignedStart.getTime()) {
    return { error: "Fenêtre temporelle invalide (end_date <= start_date)." };
  }

  console.log(`[tool] find_common_slots: ${emails.length} personne(s), ${Math.round((endDate.getTime() - alignedStart.getTime()) / 3600000)}h de fenêtre`);
  const schedules = await graph.getSchedule(emails, alignedStart, endDate, INTERVAL_MIN);

  const missing: string[] = [];
  const schedById = new Map<string, string>();
  for (const s of schedules) {
    if (s.error || !s.availabilityView) missing.push(s.scheduleId);
    else schedById.set(s.scheduleId.toLowerCase(), s.availabilityView);
  }

  const totalSlots = Math.floor((endDate.getTime() - alignedStart.getTime()) / 60000 / INTERVAL_MIN);
  const slotsNeeded = Math.max(1, Math.ceil(durationMin / INTERVAL_MIN));

  // Vue de dispo par participant ; données manquantes → considéré occupé.
  const participantViews = emails.map((email) => ({
    email,
    view: schedById.get(email.toLowerCase()) ?? "2".repeat(totalSlots),
  }));

  interface ScoredCandidate {
    start: Date;
    end: Date;
    freeEmails: string[];
    busyEmails: string[];
    score: number;
  }

  const all: ScoredCandidate[] = [];
  for (let k = 0; k + slotsNeeded <= totalSlots; k++) {
    const slotStart = new Date(alignedStart.getTime() + k * INTERVAL_MIN * 60000);
    const slotEnd = new Date(slotStart.getTime() + durationMin * 60000);
    if (!allowedDays.has(slotStart.getDay())) continue;
    if (slotEnd.getDate() !== slotStart.getDate() || slotEnd.getMonth() !== slotStart.getMonth()) continue;
    const startMinOfDay = slotStart.getHours() * 60 + slotStart.getMinutes();
    const endMinOfDay = slotEnd.getHours() * 60 + slotEnd.getMinutes();
    if (startMinOfDay < dayStartMin || endMinOfDay > dayEndMin) continue;

    const freeEmails: string[] = [];
    const busyEmails: string[] = [];
    for (const p of participantViews) {
      let isFree = true;
      for (let q = 0; q < slotsNeeded; q++) {
        if (p.view[k + q] !== "0") { isFree = false; break; }
      }
      if (isFree) freeEmails.push(p.email);
      else busyEmails.push(p.email);
    }
    all.push({ start: slotStart, end: slotEnd, freeEmails, busyEmails, score: freeEmails.length });
  }

  const fmtMin = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  const dayNames = ["dim", "lun", "mar", "mer", "jeu", "ven", "sam"];
  const allowedDaysLabel = [...allowedDays].sort().map((d) => dayNames[d]).join(",");
  const N = emails.length;

  if (all.length === 0) {
    return {
      participants: emails,
      total_participants: N,
      window_start: alignedStart.toISOString(),
      window_end: endDate.toISOString(),
      time_window: `${fmtMin(dayStartMin)}–${fmtMin(dayEndMin)}`,
      allowed_days: allowedDaysLabel,
      slots_found: 0,
      all_free_slot_found: false,
      fallback_mode: false,
      slots: [],
      note: "Aucun créneau ne tient dans la fenêtre temporelle/jours autorisés.",
    };
  }

  // Tiers par score pour le fallback (N libres, puis N-1, ...)
  const tiers = new Map<number, ScoredCandidate[]>();
  for (const c of all) {
    if (!tiers.has(c.score)) tiers.set(c.score, []);
    tiers.get(c.score)!.push(c);
  }
  const maxScore = Math.max(...tiers.keys());
  const allFreeAvailable = maxScore === N;

  // Dans un tier : d'abord un créneau par jour, puis remplissage chronologique.
  const pickFromTier = (tierCandidates: ScoredCandidate[], limit: number): ScoredCandidate[] => {
    const seenDays = new Set<string>();
    const firstPerDay: ScoredCandidate[] = [];
    const rest: ScoredCandidate[] = [];
    for (const c of tierCandidates) {
      const dayKey = c.start.toISOString().slice(0, 10);
      if (!seenDays.has(dayKey)) {
        seenDays.add(dayKey);
        firstPerDay.push(c);
      } else {
        rest.push(c);
      }
    }
    return [...firstPerDay, ...rest].slice(0, limit);
  };

  const result: ScoredCandidate[] = [];
  if (allFreeAvailable) {
    result.push(...pickFromTier(tiers.get(N)!, maxResults));
  } else {
    const sortedScores = [...tiers.keys()].sort((a, b) => b - a);
    for (const score of sortedScores) {
      const remaining = maxResults - result.length;
      if (remaining <= 0) break;
      result.push(...pickFromTier(tiers.get(score)!, remaining));
    }
  }

  return {
    participants: emails,
    include_self: args.include_self,
    duration_minutes: durationMin,
    window_start: alignedStart.toISOString(),
    window_end: endDate.toISOString(),
    time_window: `${fmtMin(dayStartMin)}–${fmtMin(dayEndMin)}`,
    allowed_days: allowedDaysLabel,
    total_participants: N,
    all_free_slot_found: allFreeAvailable,
    fallback_mode: !allFreeAvailable,
    best_score: maxScore,
    slots_found: result.length,
    missing_data: missing,
    slots: result.map((c) => ({
      start: c.start.toISOString(),
      end: c.end.toISOString(),
      startLocal: c.start.toLocaleString("fr-CH", { timeZone: config.timezone, dateStyle: "full", timeStyle: "short" }),
      endLocal: c.end.toLocaleString("fr-CH", { timeZone: config.timezone, timeStyle: "short" }),
      free_count: c.score,
      busy_count: c.busyEmails.length,
      free_participants: c.freeEmails,
      busy_participants: c.busyEmails,
    })),
  };
}

// (Les noms de tools autorisés sont désormais retournés par createAgentMcpServer,
// calculés depuis la liste effective du profil + tools client.)
