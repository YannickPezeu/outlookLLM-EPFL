import { ToolDefinition, summarizeInteractions, chatCompletion, ChatMessage } from "./rcpApiService";
import { config } from "../config";
import {
  searchContactsByName,
  searchContactsInServiceDesk,
  getAllInteractions,
  getServiceDeskEmailsForPerson,
  searchEmails,
  searchEmailsByKeyword,
  getRecentEmails,
  getRecentSentEmails,
  getCalendarView,
  getEmailsBatch,
  getSchedule,
  getMessageAttachments,
  getEmail,
  DateRange,
} from "./graphMailService";
import { getAccount } from "./authService";
import { batchEmbed, rankBySimilarity } from "./embeddingService";
import { cleanEmailBodyFull, cleanEmailBody } from "./cleanEmailBody";
import { getSkillCatalogForPrompt, getSkillIds, loadSkillContent } from "../skills/skillRegistry";
import { prepareMeeting } from "./meetingPrepService";
import { GraphMailDataSource } from "./graphMailDataSource";
import { resolveEmailRef, resolveEmailRefMetadata } from "./emailRefs";
import { extractTextFromAttachments } from "./attachmentService";

// ─── Tool Definitions (OpenAI function-calling format) ──────────────

// Tools whose call+result stays in the conversation history for subsequent turns.
// Enable for small, structured results that users typically ask follow-ups about
// (calendar events, contacts). Do NOT enable for large results (email searches,
// identify_topic_participants, summarize_topic_status, summaries) — the assistant's
// text already summarizes those and keeping the raw payload would bloat context.
export const PRESERVED_TOOLS = new Set<string>([
  "get_calendar_events",
  "search_contacts",
  // Keep the open email's body + attachments in context so the user can ask
  // follow-up questions about it ("et la méthodo ?", "rédige une réponse").
  "summarize_current_email",
  // Keep load_skill calls in history so the agent loop can re-derive which skills
  // (and thus which tools) are active on subsequent turns, and so the loaded
  // playbook stays resident in context.
  "load_skill",
]);

// Progressive tool disclosure: the only tools exposed before any skill is loaded.
// Everything else is unlocked by loading the matching skill (see skillRegistry).
export const CORE_TOOL_NAMES = ["load_skill", "search_contacts"];

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_contacts",
      description:
        "Recherche des contacts par nom dans l'annuaire EPFL ET dans les emails de l'utilisateur. " +
        "Trouve n'importe quel collaborateur EPFL même sans historique d'échange. " +
        "Gère les noms partiels, les accents manquants, etc. " +
        "Retourne une liste de contacts avec nom, email, et le cas échéant fonction/département. " +
        "TOUJOURS utiliser cet outil avant les autres quand l'utilisateur mentionne un contact par nom.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Le nom (ou partie du nom) du contact à rechercher",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_email_interactions",
      description:
        "Récupère les emails échangés avec un contact (reçus, envoyés, et tickets ServiceDesk). " +
        "Nécessite le nom et l'adresse email. Supporte le filtrage par période via start_date/end_date.\n" +
        "DEUX MODES selon la présence de 'query' :\n" +
        "• SANS query → affiche directement dans l'interface la LISTE COMPLÈTE des emails sous forme de cartes cliquables " +
        "(rendues par l'UI — tu n'as PAS à les réécrire). À utiliser quand l'utilisateur veut VOIR / MONTRER / LISTER " +
        "ses emails avec un contact, sans critère de contenu. Le filtrage par dates reste possible.\n" +
        "• AVEC query → trie les emails par pertinence sémantique (embeddings) et te retourne leurs refs+sujets+previews " +
        "pour que TU sélectionnes les pertinents, puis appelles display_emails. À utiliser dès qu'il y a un critère de contenu " +
        "(sujet, thème, mot-clé).",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Le nom complet du contact (pour chercher dans les tickets ServiceDesk)",
          },
          email: {
            type: "string",
            description: "L'adresse email exacte du contact",
          },
          start_date: {
            type: "string",
            description: "Date de début pour filtrer les emails (format ISO 8601, ex: 2023-05-01T00:00:00Z). Optionnel.",
          },
          end_date: {
            type: "string",
            description: "Date de fin pour filtrer les emails (format ISO 8601, ex: 2023-06-01T00:00:00Z). Optionnel.",
          },
          query: {
            type: "string",
            description: "Recherche sémantique : filtre les emails par pertinence par rapport à cette query (ex: 'intelligence artificielle', 'budget'). Optionnel.",
          },
        },
        required: ["name", "email"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_calendar_events",
      description:
        "Récupère les événements du calendrier dans une période donnée. " +
        "Par défaut, retourne les événements des 7 prochains jours. " +
        "OBLIGATOIRE pour toute question sur les réunions, rendez-vous, agenda ou disponibilités — " +
        "ne jamais répondre sans appeler cet outil, même pour un simple 'ma prochaine réunion' ou 'la suivante'.",
      parameters: {
        type: "object",
        properties: {
          start_date: {
            type: "string",
            description:
              "Date de début au format ISO 8601 en heure LOCALE de l'utilisateur (ex: 2025-01-15T00:00:00). Par défaut: maintenant.",
          },
          end_date: {
            type: "string",
            description:
              "Date de fin au format ISO 8601 en heure LOCALE. Par défaut: 7 jours après start_date. " +
              "Utilise une fenêtre LARGE : ne cale JAMAIS end_date sur l'heure exacte supposée d'un événement " +
              "(la borne est exclusive et l'heure donnée par l'utilisateur est souvent approximative). " +
              "Pour chercher un événement « aujourd'hui » ou « dans X min », couvre toute la journée (jusqu'à 23:59).",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_emails",
      description:
        "Recherche plein-texte dans les emails de l'utilisateur. " +
        "Cherche dans les sujets, corps et expéditeurs. " +
        "Supporte le filtrage par période temporelle via start_date/end_date.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Le texte à rechercher dans les emails",
          },
          max_results: {
            type: "number",
            description: "Nombre maximum de résultats (défaut: 100)",
          },
          start_date: {
            type: "string",
            description: "Date de début pour filtrer les emails (format ISO 8601, ex: 2023-05-01T00:00:00Z). Optionnel.",
          },
          end_date: {
            type: "string",
            description: "Date de fin pour filtrer les emails (format ISO 8601, ex: 2023-06-01T00:00:00Z). Optionnel.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_contacts_in_servicedesk",
      description:
        "Recherche un contact dans les emails ServiceNow/ServiceDesk. " +
        "Utile quand search_contacts ne trouve pas la personne, car certains échanges " +
        "passent par le ServiceDesk (expéditeur: 1234@epfl.ch) et le vrai nom de la personne " +
        "n'apparaît que dans le corps du mail. " +
        "Retourne les noms trouvés et le nombre de tickets associés.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Le nom (ou partie du nom) de la personne à rechercher dans les tickets ServiceDesk",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "summarize_email_interactions",
      description:
        "Génère un RÉSUMÉ / SYNTHÈSE structuré(e) des échanges email avec un contact. " +
        "À utiliser UNIQUEMENT quand l'utilisateur demande explicitement un résumé, une synthèse, " +
        "un point, un bilan des échanges (mots-clés : RÉSUME, SYNTHÉTISE, FAIS-MOI UN POINT, BILAN). " +
        "Déduplique par conversation (garde le dernier Re: de chaque thread), " +
        "nettoie le HTML, et produit un résumé IA incluant les sujets abordés, " +
        "les décisions prises, les points en suspens, et une liste de to-dos pour la suite. " +
        "Nécessite le nom et l'adresse email du contact. " +
        "NE PAS utiliser quand l'utilisateur veut juste VOIR / AFFICHER / LISTER les emails — " +
        "dans ce cas utiliser get_email_interactions (sans query) à la place.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Le nom complet du contact",
          },
          email: {
            type: "string",
            description: "L'adresse email exacte du contact",
          },
          start_date: {
            type: "string",
            description: "Date de début (format ISO 8601). Optionnel, défaut: 6 derniers mois.",
          },
          end_date: {
            type: "string",
            description: "Date de fin (format ISO 8601). Optionnel.",
          },
          query: {
            type: "string",
            description: "Filtre sémantique optionnel : ne résumer que les emails pertinents à ce sujet (ex: 'budget', 'projet NLP').",
          },
        },
        required: ["name", "email"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "display_emails",
      description:
        "Affiche dans l'interface une LISTE FILTRÉE d'emails sous forme de cartes cliquables. " +
        "À utiliser après avoir récupéré une liste via get_email_interactions / search_emails " +
        "et SÉLECTIONNÉ les emails réellement pertinents (par sujet, expéditeur, date, ou tout autre critère du user). " +
        "Tu fournis uniquement les refs courts (ex: ['ref_3', 'ref_7']) — l'UI génère automatiquement la liste. " +
        "Ne JAMAIS écrire toi-même les liens markdown des emails après cet appel : juste une phrase d'introduction. " +
        "Préférer cette voie à la rédaction manuelle de [Sujet](email:ref_X) — c'est beaucoup plus rapide.",
      parameters: {
        type: "object",
        properties: {
          email_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Liste ordonnée des refs des emails à afficher (ex: ['ref_3', 'ref_7', 'ref_12']). " +
              "Doivent provenir d'un appel précédent dans CETTE conversation (get_email_interactions, search_emails, etc.).",
          },
          context_label: {
            type: "string",
            description:
              "Optionnel : étiquette courte pour identifier le filtrage (ex: 'IA', 'Patrick Saladino', 'budget 2025'). Affiché en en-tête.",
          },
        },
        required: ["email_ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_email_attachments",
      description:
        "Lit et extrait le CONTENU TEXTE des pièces jointes d'UN email précis " +
        "(formats supportés : PDF, DOCX, TXT, CSV, HTML ; max 5 Mo/fichier ; ~10 000 caractères extraits par fichier ; " +
        "les images et éléments inline sont ignorés). " +
        "À utiliser UNIQUEMENT quand la pièce jointe est jugée IMPORTANTE pour répondre " +
        "(ex: l'utilisateur demande ce que contient un document, ou un fichier est central dans la conversation). " +
        "Les résultats d'emails marquent has_attachments:true quand un email a des pièces jointes. " +
        "NE PAS appeler en masse ni « au cas où » : chaque appel consomme du contexte. Un seul email par appel.",
      parameters: {
        type: "object",
        properties: {
          email_id: {
            type: "string",
            description:
              "Le ref court de l'email dont lire les pièces jointes (ex: 'ref_7'). " +
              "Doit provenir d'un résultat précédent de CETTE conversation (get_email_interactions, search_emails, summarize_email_interactions…).",
          },
        },
        required: ["email_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "summarize_current_email",
      description:
        "Lit l'email ACTUELLEMENT OUVERT dans Outlook (corps + pièces jointes : PDF, DOCX, TXT, CSV, HTML) et retourne son contenu complet pour que TU le résumes. " +
        "À utiliser dès que l'utilisateur demande de résumer / analyser / expliquer « cet email », « ce mail », « le message ouvert », « ce qui est demandé dans ce mail » et ses pièces jointes — sans qu'il ait besoin de préciser un contact ni un ref. " +
        "Ne prend AUCUN paramètre. Après l'appel, rédige le résumé structuré en suivant le champ \"instructions\" du résultat.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "prepare_meeting",
      description:
        "Lance le pipeline complet de préparation de réunion pour un événement calendrier. " +
        "Analyse les emails échangés avec chaque participant (embedding sémantique + reranking LLM), " +
        "puis génère un briefing structuré. " +
        "IMPORTANT : nécessite un event_id obtenu via get_calendar_events. " +
        "Ce processus prend 30-60 secondes.",
      parameters: {
        type: "object",
        properties: {
          event_id: {
            type: "string",
            description: "L'identifiant de l'événement calendrier (obtenu via get_calendar_events)",
          },
        },
        required: ["event_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_common_slots",
      description:
        "Trouve des créneaux horaires de réunion en consultant le free/busy des participants via l'API Graph getSchedule. " +
        "Ne voit PAS le détail des événements des collègues, seulement libre/occupé/tentatif/absent. " +
        "Par défaut cherche sur 7 jours en heures ouvrées (9h–18h, lun–ven), créneaux de 30 min. " +
        "Comportement : (1) si des créneaux où TOUT LE MONDE est libre existent, ils sont retournés en priorité " +
        "(`all_free_slot_found: true`). (2) Sinon, FALLBACK automatique : retourne les meilleurs créneaux disponibles " +
        "ordonnés par nombre de personnes libres (`fallback_mode: true`, `best_score` = nb max de libres trouvé). " +
        "Chaque créneau indique `free_participants` et `busy_participants` — utilise ces listes pour expliquer à l'utilisateur " +
        "qui est libre et qui ne l'est pas, afin qu'il puisse arbitrer (ex: 'le lundi 10 à 14h tout le monde est libre sauf Alice'). " +
        "Usage typique : 'trouve un créneau avec X et Y' (include_self=true) ou 'quand est libre Alexandre ?' (include_self=false).",
      parameters: {
        type: "object",
        properties: {
          participants: {
            type: "array",
            items: { type: "string" },
            description: "Liste des adresses email des participants à interroger (max 20).",
          },
          include_self: {
            type: "boolean",
            description:
              "OBLIGATOIRE — décider en fonction de l'intention utilisateur. " +
              "true si la réunion doit inclure l'utilisateur courant (ex: 'organise une réunion avec X et moi', " +
              "'trouve un créneau pour qu'on se voie avec Y'). " +
              "false si on cherche uniquement la disponibilité d'autres personnes sans inclure l'utilisateur " +
              "(ex: 'quand est libre Alexandre ?', 'donne-moi les slots libres de X cette semaine').",
          },
          duration_minutes: {
            type: "number",
            description: "Durée souhaitée du créneau en minutes (défaut: 30, multiples de 30 recommandés).",
          },
          start_date: {
            type: "string",
            description: "Début de la fenêtre de recherche (ISO 8601). Défaut: maintenant.",
          },
          end_date: {
            type: "string",
            description: "Fin de la fenêtre de recherche (ISO 8601). Défaut: 7 jours après start_date.",
          },
          days_of_week: {
            type: "array",
            items: { type: "number" },
            description:
              "Liste des jours autorisés (0=dimanche, 1=lundi, 2=mardi, 3=mercredi, 4=jeudi, 5=vendredi, 6=samedi). " +
              "Ex: [1, 5] pour 'uniquement lundi et vendredi', [2, 4] pour 'mardi et jeudi'. " +
              "Si absent, utilise include_weekends pour décider lun-ven vs lun-dim.",
          },
          time_restriction: {
            type: "object",
            description:
              "Fenêtre horaire stricte dans la journée (override working_hours_*). " +
              "À utiliser quand l'utilisateur précise une plage : 'entre 15h et 17h', 'le matin (8h-12h)'. " +
              "Format 'HH:MM'. Le créneau entier doit tenir dans cette fenêtre.",
            properties: {
              start: { type: "string", description: "Heure de début 'HH:MM' (ex: '15:00')." },
              end: { type: "string", description: "Heure de fin 'HH:MM' (ex: '17:00')." },
            },
            required: ["start", "end"],
          },
          working_hours_start: {
            type: "number",
            description: "Heure de début de journée par défaut, 0-23 (défaut: 9). Ignoré si time_restriction est fourni.",
          },
          working_hours_end: {
            type: "number",
            description: "Heure de fin de journée par défaut, 0-23 (défaut: 18). Ignoré si time_restriction est fourni.",
          },
          include_weekends: {
            type: "boolean",
            description: "Inclure samedi et dimanche (défaut: false). Ignoré si days_of_week est fourni.",
          },
          max_results: {
            type: "number",
            description: "Nombre maximum de créneaux candidats à retourner (défaut: 10).",
          },
        },
        required: ["participants", "include_self"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "identify_topic_participants",
      description:
        "CARTOGRAPHIE LES PERSONNES impliquées sur un sujet/thème dans les emails. " +
        "Identifie qui travaille sur le sujet, leur rôle, leur positionnement et leurs contributions. " +
        "Utiliser quand l'utilisateur pose une question comme 'qui travaille sur X ?', " +
        "'quels sont les acteurs sur le thème Y ?', 'qui est impliqué dans Z ?'. " +
        "NE PAS utiliser pour un point d'avancement chronologique (« où on en est de X ? ») — " +
        "utiliser summarize_topic_status à la place.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "Description RICHE et détaillée du sujet pour le classement sémantique (embeddings). " +
              "Inclure synonymes et termes associés. Ex: 'intelligence artificielle, IA, machine learning, LLM, " +
              "modèles de langage, deep learning, ChatGPT, Copilot' plutôt que juste 'IA'.",
          },
          max_people: {
            type: "number",
            description: "Nombre maximum de personnes à analyser (défaut: 10)",
          },
        },
        required: ["topic"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "summarize_topic_status",
      description:
        "POINT D'AVANCEMENT CHRONOLOGIQUE sur un sujet/projet en cours : où on en est, " +
        "dernières évolutions datées, prochaines étapes, points bloquants. " +
        "Couvre à la fois les emails reçus et envoyés par l'utilisateur. " +
        "Utiliser quand l'utilisateur demande 'où on en est de X ?', 'état d'avancement de Y ?', " +
        "'fais-moi un point sur le projet Z', 'résume l'avancée du dossier W'. " +
        "NE PAS confondre avec identify_topic_participants qui cartographie les PERSONNES impliquées.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "Description RICHE et détaillée du sujet/projet pour le classement sémantique (embeddings). " +
              "Inclure synonymes et termes associés. Ex: 'recrutement binôme, candidat assistant, offre d'emploi, " +
              "CV, entretien, embauche, RH' plutôt que juste 'recrutement'.",
          },
          months: {
            type: "number",
            description: "Nombre de mois à remonter (défaut: 6)",
          },
          max_emails: {
            type: "number",
            description: "Nombre maximum d'emails à analyser après ranking sémantique (défaut: 30)",
          },
        },
        required: ["topic"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "load_skill",
      description:
        "Charge les instructions détaillées d'un skill (workflow) pour savoir exactement comment répondre à la demande de l'utilisateur. " +
        "TOUJOURS appeler cet outil EN PREMIER quand la demande correspond à un skill disponible.\n" +
        "Skills disponibles :\n" +
        getSkillCatalogForPrompt(),
      parameters: {
        type: "object",
        properties: {
          skill_id: {
            type: "string",
            description: "L'identifiant du skill à charger",
            enum: getSkillIds(),
          },
        },
        required: ["skill_id"],
      },
    },
  },
];

// ─── Tool Executors ─────────────────────────────────────────────────

type LogFn = (msg: string) => void;
export type ToolProgressFn = (detail: string) => void;
export type ToolStreamFn = (chunk: string) => void;
type ToolExecutor = (
  args: Record<string, unknown>,
  log: LogFn,
  onProgress?: ToolProgressFn,
  onStream?: ToolStreamFn,
  signal?: AbortSignal
) => Promise<string>;

const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;

function extractDateRange(args: Record<string, unknown>): DateRange | undefined {
  const startDate = args.start_date as string | undefined;
  const endDate = args.end_date as string | undefined;
  return (startDate || endDate) ? { startDate, endDate } : undefined;
}

/**
 * Convertit une borne temporelle fournie par le LLM en string UTC pour Graph.
 *
 * Graph /calendarView interprète startDateTime/endDateTime SANS offset comme de
 * l'UTC (le header Prefer: outlook.timezone ne change QUE le format des dates
 * retournées, pas l'interprétation des bornes). Or le LLM produit des heures
 * locales naïves (ex: "2026-06-04T13:30:00" = heure de Zurich, GMT+2).
 *
 * new Date() parse une string ISO sans offset comme heure LOCALE du navigateur,
 * donc .toISOString() la convertit correctement en UTC. Si un offset/Z est déjà
 * présent, la conversion reste correcte.
 */
function toGraphUtc(dateTime: string): string {
  const d = new Date(dateTime);
  if (Number.isNaN(d.getTime())) return dateTime; // fallback: laisse Graph trancher
  return d.toISOString();
}

function formatLocalDateTime(dateTime: string, timeZone: string): string {
  // Graph renvoie des heures "murales" dans le TZ demandé via le header Prefer,
  // sans suffixe Z/offset. On parse en forçant UTC puis on formate en UTC pour
  // afficher les composants tels quels (sans reconversion), en précisant le TZ.
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(dateTime) ? dateTime : `${dateTime}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return `${dateTime} (${timeZone})`;
  return d.toLocaleString("fr-CH", {
    timeZone: "UTC",
    dateStyle: "full",
    timeStyle: "short",
  }) + ` (${timeZone})`;
}

const executors: Record<string, ToolExecutor> = {
  async search_contacts(args, log) {
    const query = args.query as string;
    const contacts = await searchContactsByName(query);
    if (contacts.length === 0) {
      return JSON.stringify({ message: `Aucun contact trouvé pour "${query}".`, contacts: [] });
    }
    return JSON.stringify({ contacts });
  },

  async get_email_interactions(args, log) {
    const name = args.name as string;
    const email = args.email as string;
    const explicitRange = extractDateRange(args);
    const query = args.query as string | undefined;

    // Two modes, depending on whether a content filter (query) was given:
    //  • no query → "show all": collect everything (all-time unless dates given)
    //    and hand the full clickable list straight to the UI (email_list marker).
    //  • query → semantic search: bound the pool (default 6 months), rank by
    //    relevance, return ref summaries so the LLM can pick + call display_emails.
    const dateRange = explicitRange || (query
      ? { startDate: new Date(Date.now() - SIX_MONTHS_MS).toISOString(), endDate: new Date().toISOString() }
      : undefined);
    const usingDefault = !explicitRange && !!query;

    // Per-direction cap. The default (30) is too low for "show all" over a wide
    // range — it would keep only the 30 most recent and silently drop the rest of
    // the period. Use a high cap so the full clickable list (and the semantic pool)
    // covers the whole range.
    const MAX_PER_DIRECTION = 200;

    // Skip direct email search if no email address (ServiceDesk-only contacts)
    const [{ received, sent }, serviceDeskEmails] = await Promise.all([
      email ? getAllInteractions(email, MAX_PER_DIRECTION, dateRange) : Promise.resolve({ received: [], sent: [] }),
      getServiceDeskEmailsForPerson(name, MAX_PER_DIRECTION, dateRange),
    ]);

    log(`Emails collectés: ${received.length} reçus, ${sent.length} envoyés, ${serviceDeskEmails.length} ServiceDesk${usingDefault ? " (limité aux 6 derniers mois par défaut)" : ""}`);

    // Merge all emails into a unified list
    const allEmails = [
      ...received.map((e) => ({ ...e, direction: "received" as const, displayDate: e.receivedDateTime })),
      ...sent.map((e) => ({ ...e, direction: "sent" as const, displayDate: e.sentDateTime || e.receivedDateTime })),
      ...serviceDeskEmails.map((e) => ({ ...e, direction: "servicedesk" as const, displayDate: e.receivedDateTime, subject: `[ServiceNow] ${e.subject}` })),
    ];

    // ── No query → render the full clickable list directly in the UI ──
    // (this is the former show_emails behaviour, folded in as the default mode)
    if (!query) {
      const list = allEmails
        .map((e) => ({
          id: e.id,
          subject: e.subject,
          date: e.displayDate,
          from: e.direction === "sent" ? "Moi"
            : e.direction === "servicedesk" ? "ServiceDesk"
            : (e as any).from?.emailAddress?.name || (e as any).from?.emailAddress?.address || "?",
          direction: e.direction === "sent" ? ("sent" as const) : ("received" as const),
        }))
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      log(`Liste affichée: ${list.length} emails`);
      return JSON.stringify({ type: "email_list", name, email, emails: list, count: list.length });
    }

    // ── Query → semantic ranking, return ref summaries for the LLM to filter ──
    let topEmails = allEmails;

    // Cap at 500 emails for embeddings
    const MAX_EMAILS_FOR_EMBEDDINGS = 500;
    let capped = false;
    if (topEmails.length > MAX_EMAILS_FOR_EMBEDDINGS) {
      topEmails.sort((a, b) => new Date(b.displayDate).getTime() - new Date(a.displayDate).getTime());
      topEmails = topEmails.slice(0, MAX_EMAILS_FOR_EMBEDDINGS);
      capped = true;
      log(`Cap appliqué: ${allEmails.length} emails réduits à ${MAX_EMAILS_FOR_EMBEDDINGS} (les plus récents)`);
    }

    if (topEmails.length > 0) {
      log(`Recherche sémantique: "${query}" sur ${topEmails.length} emails...`);
      const texts = topEmails.map((e) => {
        const body = e.body?.content
          ? e.body.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 4000)
          : e.bodyPreview?.slice(0, 500) || "";
        return `${e.subject} ${body}`;
      });
      const [queryEmbeddings, ...itemEmbeddings] = await batchEmbed([query, ...texts]);
      const ranked = rankBySimilarity(queryEmbeddings, itemEmbeddings);
      const topN = Math.min(100, topEmails.length);
      topEmails = ranked.slice(0, topN).map((r) => topEmails[r.index]);
      log(`Top ${topN} emails par pertinence sélectionnés (score max: ${ranked[0]?.score.toFixed(3)})`);
    }

    // Sort by date descending
    topEmails.sort((a, b) => new Date(b.displayDate).getTime() - new Date(a.displayDate).getTime());

    for (const e of topEmails.slice(0, 10)) {
      const tag = e.direction === "sent" ? "envoyé" : e.direction === "servicedesk" ? "ServiceNow" : "reçu";
      log(`  [${tag}] ${e.displayDate?.slice(0, 10)} | ${e.subject}`);
    }

    const emailSummaries = topEmails.slice(0, 100).map((e) => ({
      id: e.id,
      subject: e.subject,
      date: e.displayDate,
      direction: e.direction,
      from: e.direction === "sent"
        ? "Moi"
        : (e as any).from?.emailAddress?.name || (e as any).from?.emailAddress?.address || "?",
      preview: e.bodyPreview?.slice(0, 200),
      has_attachments: !!(e as any).hasAttachments,
    }));

    return JSON.stringify({
      total_count: allEmails.length,
      returned_count: emailSummaries.length,
      query,
      default_period: usingDefault ? "6 derniers mois" : null,
      capped: capped ? `Limité à 500 emails sur ${allEmails.length} total` : null,
      emails: emailSummaries,
    });
  },

  async get_calendar_events(args, _log) {
    const now = new Date();
    const startDate = toGraphUtc((args.start_date as string) || now.toISOString());
    const endDate = toGraphUtc(
      (args.end_date as string) ||
        new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
    );

    const events = await getCalendarView(startDate, endDate);

    const eventSummaries = events.map((e) => ({
      id: e.id,
      subject: e.subject,
      start: e.start.dateTime,
      end: e.end.dateTime,
      startLocal: formatLocalDateTime(e.start.dateTime, e.start.timeZone),
      endLocal: formatLocalDateTime(e.end.dateTime, e.end.timeZone),
      location: e.location?.displayName,
      attendees: e.attendees.map((a) => ({
        name: a.emailAddress.name,
        email: a.emailAddress.address,
      })),
      isOrganizer: e.isOrganizer,
    }));

    return JSON.stringify({ events: eventSummaries, count: events.length });
  },

  async search_emails(args, _log) {
    const query = args.query as string;
    const maxResults = (args.max_results as number) || 100;
    const dateRange = extractDateRange(args);
    const emails = await searchEmails(query, maxResults, dateRange);

    const results = emails.map((e) => ({
      id: e.id,
      subject: e.subject,
      from: e.from?.emailAddress?.name || e.from?.emailAddress?.address || "?",
      date: e.receivedDateTime,
      direction: "received" as const,
      preview: e.bodyPreview?.slice(0, 200),
      has_attachments: !!(e as any).hasAttachments,
    }));

    return JSON.stringify({ results, count: emails.length });
  },

  async summarize_email_interactions(args, log, _onProgress, onStream, signal) {
    const name = args.name as string;
    const email = args.email as string;
    const dateRange = extractDateRange(args);
    const query = args.query as string | undefined;

    // Only use a date range when the user asked for one, OR when we need a broad
    // pool for semantic ranking (query case). Otherwise the fast $search path
    // returns ~30 most-recent emails in one request per flow, no client-side
    // filtering of a 1000-email pull needed.
    const effectiveDateRange = dateRange || (query
      ? {
          startDate: new Date(Date.now() - SIX_MONTHS_MS).toISOString(),
          endDate: new Date().toISOString(),
        }
      : undefined);

    const fastPath = !effectiveDateRange;
    log(`Collecte des emails avec ${name}${fastPath ? " (rapide, ~30 par flux)" : " (large, peut prendre 10-30s)"}...`);
    if (email) log(`  → Recherche des emails reçus/envoyés avec ${email}...`);
    log(`  → Recherche des tickets ServiceDesk mentionnant ${name}...`);

    // Log page-level progress so the UI doesn't sit silent during the 20+
    // paginated Graph fetches. Each callback fires as a new page of 50 arrives.
    const directOnPage = (direction: "received" | "sent", n: number) => {
      if (n % 200 === 0) log(`  · Emails ${direction === "received" ? "reçus" : "envoyés"} en cours : ${n} chargés...`);
    };
    const serviceDeskOnPage = (n: number) => {
      if (n % 200 === 0) log(`  · ServiceDesk en cours : ${n} emails chargés (avant filtrage par nom)...`);
    };

    // Wrap each Graph fetch so we log individual completions as they come in.
    const directPromise = email
      ? getAllInteractions(email, undefined, effectiveDateRange, directOnPage).then((r) => {
          log(`  ✓ Emails directs récupérés : ${r.received.length} reçus + ${r.sent.length} envoyés`);
          return r;
        })
      : Promise.resolve({ received: [] as Awaited<ReturnType<typeof getAllInteractions>>["received"], sent: [] as Awaited<ReturnType<typeof getAllInteractions>>["sent"] });

    const serviceDeskPromise = getServiceDeskEmailsForPerson(name, undefined, effectiveDateRange, serviceDeskOnPage).then(
      (sd) => {
        log(`  ✓ Tickets ServiceDesk récupérés : ${sd.length}`);
        return sd;
      }
    );

    const [{ received, sent }, serviceDeskEmails] = await Promise.all([
      directPromise,
      serviceDeskPromise,
    ]);

    // Merge all emails
    const allEmails = [
      ...received.map((e) => ({
        id: e.id, subject: e.subject, body: e.body?.content || e.bodyPreview || "",
        date: e.receivedDateTime, direction: "received" as const,
        conversationId: (e as any).conversationId as string | undefined,
        hasAttachments: !!e.hasAttachments,
      })),
      ...sent.map((e) => ({
        id: e.id, subject: e.subject, body: e.body?.content || e.bodyPreview || "",
        date: e.sentDateTime || e.receivedDateTime, direction: "sent" as const,
        conversationId: (e as any).conversationId as string | undefined,
        hasAttachments: !!e.hasAttachments,
      })),
      ...serviceDeskEmails.map((e) => ({
        id: e.id, subject: `[ServiceNow] ${e.subject}`, body: e.body?.content || e.bodyPreview || "",
        date: e.receivedDateTime, direction: "servicedesk" as const,
        conversationId: (e as any).conversationId as string | undefined,
        hasAttachments: false,
      })),
    ];

    log(`${allEmails.length} emails collectés (${received.length} reçus, ${sent.length} envoyés, ${serviceDeskEmails.length} ServiceDesk)`);

    // Dédup par conversation : on garde le plus récent de chaque thread
    // (avant embeddings / relecture body / prompt LLM pour réduire le volume)
    const sortedAll = [...allEmails].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
    const seenConv = new Set<string>();
    const deduped = sortedAll.filter((e) => {
      if (!e.conversationId) return true;
      if (seenConv.has(e.conversationId)) return false;
      seenConv.add(e.conversationId);
      return true;
    });
    if (deduped.length < allEmails.length) {
      log(`Dédup par conversation : ${allEmails.length} → ${deduped.length} emails (un par thread)`);
    }

    let emailsToSummarize = deduped;
    // Selection depends on intent:
    //   - query → semantic ranking, cap 25
    //   - explicit date range (no query) → temporal sampling across the period,
    //     cap 50 so each month gets a fair share
    //   - nothing → most recent, cap 25
    const CAP_RECENT = 25;
    const CAP_PERIOD = 50;

    if (query && emailsToSummarize.length > 0) {
      log(`Filtrage sémantique: "${query}"...`);
      const texts = emailsToSummarize.map((e) => `${e.subject} ${e.body.replace(/<[^>]+>/g, " ").slice(0, 2000)}`);
      const [queryEmb, ...itemEmbs] = await batchEmbed([query, ...texts]);
      const ranked = rankBySimilarity(queryEmb, itemEmbs);
      const topN = Math.min(CAP_RECENT, emailsToSummarize.length);
      emailsToSummarize = ranked.slice(0, topN).map((r) => emailsToSummarize[r.index]);
      log(`Top ${topN} emails par pertinence sélectionnés`);
    } else if (dateRange && emailsToSummarize.length > CAP_PERIOD) {
      // Temporal sampling: bin by month over the user's date range, keep top
      // (CAP_PERIOD / bins) most recent per bin → balanced coverage of the period.
      const start = new Date(dateRange.startDate || deduped[deduped.length - 1].date).getTime();
      const end = new Date(dateRange.endDate || deduped[0].date).getTime();
      const months = Math.max(1, Math.min(12, Math.round((end - start) / (30 * 24 * 60 * 60 * 1000))));
      const binSize = (end - start) / months;
      const perBin = Math.ceil(CAP_PERIOD / months);
      const bins: typeof deduped[] = Array.from({ length: months }, () => []);
      for (const e of deduped) {
        const t = new Date(e.date).getTime();
        const idx = Math.min(months - 1, Math.max(0, Math.floor((t - start) / binSize)));
        bins[idx].push(e);
      }
      const sampled: typeof deduped = [];
      for (const bin of bins) {
        bin.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        sampled.push(...bin.slice(0, perBin));
      }
      sampled.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      emailsToSummarize = sampled.slice(0, CAP_PERIOD);
      log(`Échantillonnage temporel : ${deduped.length} → ${emailsToSummarize.length} emails (${months} tranches, ~${perBin}/tranche)`);
    } else if (emailsToSummarize.length > CAP_RECENT) {
      emailsToSummarize = emailsToSummarize.slice(0, CAP_RECENT);
      log(`Cap appliqué : ${deduped.length} emails → ${CAP_RECENT} plus récents`);
    }

    // Read full body for emails that only have bodyPreview
    const needFullBody = emailsToSummarize.filter((e) => !e.body || e.body.length < 300);
    if (needFullBody.length > 0) {
      log(`Lecture du contenu complet de ${needFullBody.length} emails...`);
      const fullEmails = await getEmailsBatch(needFullBody.map((e) => e.id));
      const fullById = new Map(fullEmails.map((f) => [f.id, f]));
      for (const e of emailsToSummarize) {
        const full = fullById.get(e.id);
        if (full?.body?.content) e.body = full.body.content;
      }
    }

    // Compact list of attachment-bearing emails (refs + subject only, NO content)
    // so the agent can selectively read the important ones via read_email_attachments.
    // Capped to avoid bloating the tool result. replaceEmailIdsWithRefs() mints refs.
    const attachmentsAvailable = emailsToSummarize
      .filter((e) => e.hasAttachments)
      .slice(0, 15)
      .map((e) => ({
        id: e.id,
        subject: e.subject,
        date: e.date,
        direction: e.direction,
      }));

    log(`Génération du résumé (${emailsToSummarize.length} emails, streaming=${!!onStream})...`);

    // Synthesis uses the user-chosen model from Settings (falls back to default
    // when none stored). Pass undefined so chatCompletionStream picks cfg.model.
    const summary = await summarizeInteractions(
      name, email, emailsToSummarize, onStream, undefined, signal
    );

    return JSON.stringify({
      name,
      email,
      emails_analyzed: emailsToSummarize.length,
      emails_total: allEmails.length,
      query: query || null,
      already_displayed: !!onStream,
      attachments_available: attachmentsAvailable.length > 0 ? attachmentsAvailable : undefined,
      summary,
    });
  },

  async display_emails(args, log) {
    const refs = (args.email_ids as string[]) || [];
    const contextLabel = (args.context_label as string | undefined) || undefined;

    const resolved: Array<{
      id: string;
      subject: string;
      date: string;
      from: string;
      direction: "received" | "sent";
    }> = [];
    const missing: string[] = [];

    for (const ref of refs) {
      const meta = resolveEmailRefMetadata(ref);
      if (!meta) {
        missing.push(ref);
        continue;
      }
      resolved.push({
        id: meta.realId,
        subject: meta.subject,
        date: meta.date,
        from: meta.from,
        direction: meta.direction,
      });
    }

    log(`display_emails: ${resolved.length} emails résolus${missing.length ? `, ${missing.length} refs introuvables (${missing.join(", ")})` : ""}`);

    if (resolved.length === 0) {
      return JSON.stringify({
        error: "Aucun email à afficher. Les refs fournis ne correspondent à aucun email vu dans cette conversation.",
        invalid_refs: missing,
      });
    }

    return JSON.stringify({
      type: "email_list",
      name: contextLabel || null,
      emails: resolved,
      count: resolved.length,
      missing_refs: missing.length > 0 ? missing : undefined,
    });
  },

  async read_email_attachments(args, log) {
    const ref = args.email_id as string;
    const realId = resolveEmailRef(ref);
    if (!realId) {
      return JSON.stringify({
        error: `Ref introuvable: "${ref}". Utilise un ref d'email vu plus tôt dans cette conversation.`,
      });
    }

    log(`Lecture des pièces jointes de ${ref}...`);
    const attachments = await getMessageAttachments(realId);
    const texts = await extractTextFromAttachments(attachments as any);

    if (texts.length === 0) {
      return JSON.stringify({
        ref,
        attachments: [],
        note: "Aucune pièce jointe exploitable (formats supportés : PDF, DOCX, TXT, CSV, HTML ; max 5 Mo ; images/inline ignorées).",
      });
    }

    // Hard cap to protect the context window: at most 3 attachments per call
    // (each already truncated to ~10k chars by extractTextFromAttachments).
    const MAX_ATTACHMENTS = 3;
    const returned = texts.slice(0, MAX_ATTACHMENTS);
    log(
      `${texts.length} pièce(s) jointe(s) extraite(s)` +
        (texts.length > MAX_ATTACHMENTS ? `, ${MAX_ATTACHMENTS} retournées (cap contexte)` : "")
    );

    return JSON.stringify({
      ref,
      attachment_count: texts.length,
      returned_count: returned.length,
      truncated: texts.length > MAX_ATTACHMENTS,
      attachments: returned.map((a) => ({ name: a.name, chars: a.text.length, text: a.text })),
    });
  },

  async summarize_current_email(_args, log) {
    const OfficeRef = (window as any).Office;
    const item = OfficeRef?.context?.mailbox?.item;
    if (!item || !item.itemId) {
      return JSON.stringify({
        error: "Aucun email ouvert dans Outlook. Demande à l'utilisateur d'ouvrir un email, puis réessaie.",
      });
    }
    if (String(item.itemType).toLowerCase().includes("appointment")) {
      return JSON.stringify({
        error: "L'élément ouvert est un événement calendrier, pas un email. Pour préparer une réunion, utilise prepare_meeting.",
      });
    }

    let restId = item.itemId as string;
    try {
      restId = OfficeRef.context.mailbox.convertToRestId(
        item.itemId,
        OfficeRef.MailboxEnums.RestVersion.v2_0
      );
    } catch {
      // conversion failed — use the original id
    }

    log("Lecture de l'email ouvert...");
    const email = await getEmail(restId);
    const body = cleanEmailBody(email.body?.content || "");

    let attachments: { name: string; text: string }[] = [];
    if (email.hasAttachments) {
      log("Lecture des pièces jointes...");
      const raw = await getMessageAttachments(restId);
      // Generous per-attachment budget: a single open email fits Kimi's 256k ctx.
      attachments = await extractTextFromAttachments(raw as any, 500000);
      log(`  ✓ ${attachments.length} pièce(s) jointe(s) exploitable(s)`);
    }

    if (!body.trim() && attachments.length === 0) {
      return JSON.stringify({
        error: "Email vide et aucune pièce jointe lisible — rien à résumer.",
      });
    }

    return JSON.stringify({
      subject: email.subject || "(sans objet)",
      from: email.from?.emailAddress?.name || email.from?.emailAddress?.address || null,
      body,
      attachments,
      attachments_analyzed: attachments.length,
      instructions:
        "Résume cet email pour un membre du personnel dirigeant EPFL, en français, en combinant le CORPS et les PIÈCES JOINTES " +
        "(ne les traite pas séparément — synthétise l'ensemble). Structure en markdown avec exactement ces sections : " +
        "## Contexte / projet, ## Ce qui est demandé, ## Échéances, ## Points d'attention. " +
        "Reste factuel, n'invente rien, signale ce qui est ambigu ou absent. Si une section est vide, écris « Rien à signaler ».",
    });
  },

  async prepare_meeting(args, log, onProgress, onStream) {
    const eventId = args.event_id as string;

    log("Démarrage de la préparation de réunion...");
    onProgress?.("Démarrage...");

    const ds = new GraphMailDataSource();

    const result = await prepareMeeting(
      ds,
      eventId,
      (progress) => {
        log(`[${progress.phase}] ${progress.message}${progress.detail ? ` — ${progress.detail}` : ""}`);
        onProgress?.(`${progress.message} (${progress.percent}%)`);
      },
      // Phase 8 streams the final briefing token-by-token. Forward it straight to
      // the UI so it appears live instead of accumulating invisibly (~40s blank),
      // and flag already_displayed below so the agent doesn't re-emit the whole
      // briefing on its next turn (which previously caused a double generation).
      (chunk) => onStream?.(chunk)
    );

    return JSON.stringify({
      event: result.event.subject,
      participants: result.participants.map((p) => p.name),
      participantCount: result.participants.length,
      emailsAnalyzed: result.participantBriefings.reduce((sum, b) => sum + b.emailCount, 0),
      already_displayed: true,
      briefing: result.finalBriefing,
    });
  },

  async find_common_slots(args, log) {
    const participantsArg = (args.participants as string[]) || [];
    const durationMin = (args.duration_minutes as number) || 30;
    const includeSelf = args.include_self as boolean | undefined;
    if (typeof includeSelf !== "boolean") {
      return JSON.stringify({ error: "Paramètre 'include_self' obligatoire (true/false)." });
    }
    const maxResults = (args.max_results as number) || 10;
    const INTERVAL_MIN = 30;

    // Resolve allowed days-of-week (JS getDay() convention: 0=Sun..6=Sat)
    const dowArg = args.days_of_week as number[] | undefined;
    let allowedDays: Set<number>;
    if (Array.isArray(dowArg) && dowArg.length > 0) {
      allowedDays = new Set(dowArg.filter((d) => d >= 0 && d <= 6));
    } else {
      const includeWeekends = (args.include_weekends as boolean) ?? false;
      allowedDays = includeWeekends ? new Set([0, 1, 2, 3, 4, 5, 6]) : new Set([1, 2, 3, 4, 5]);
    }

    // Resolve in-day time window (in minutes-since-midnight)
    const parseHHMM = (s: string): number | null => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(s);
      if (!m) return null;
      const h = +m[1], mm = +m[2];
      if (h < 0 || h > 24 || mm < 0 || mm > 59) return null;
      return h * 60 + mm;
    };
    let dayStartMin: number;
    let dayEndMin: number;
    const tr = args.time_restriction as { start?: string; end?: string } | undefined;
    if (tr && tr.start && tr.end) {
      const a = parseHHMM(tr.start);
      const b = parseHHMM(tr.end);
      if (a == null || b == null || a >= b) {
        return JSON.stringify({ error: `time_restriction invalide: '${tr.start}'–'${tr.end}' (format 'HH:MM' attendu, start < end).` });
      }
      dayStartMin = a;
      dayEndMin = b;
    } else {
      const whStart = (args.working_hours_start as number) ?? 9;
      const whEnd = (args.working_hours_end as number) ?? 18;
      dayStartMin = whStart * 60;
      dayEndMin = whEnd * 60;
    }

    // Build final participants list (optionally add the signed-in user)
    const emails = [...participantsArg.map((e) => e.trim()).filter(Boolean)];
    const selfEmail = getAccount()?.username;
    if (includeSelf && selfEmail && !emails.some((e) => e.toLowerCase() === selfEmail.toLowerCase())) {
      emails.unshift(selfEmail);
    }
    if (emails.length === 0) {
      return JSON.stringify({ error: "Aucun participant fourni." });
    }
    if (emails.length > 20) {
      return JSON.stringify({ error: `Trop de participants (${emails.length}), max 20 supportés par getSchedule.` });
    }

    // Window: default now → now+7d, aligned to 30-min boundary
    const now = new Date();
    const rawStart = args.start_date ? new Date(args.start_date as string) : now;
    const startDate = rawStart.getTime() < now.getTime() ? now : rawStart;
    const endDate = args.end_date
      ? new Date(args.end_date as string)
      : new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);

    const alignedStart = new Date(startDate);
    alignedStart.setSeconds(0, 0);
    const mins = alignedStart.getMinutes();
    alignedStart.setMinutes(Math.ceil(mins / INTERVAL_MIN) * INTERVAL_MIN);

    if (endDate.getTime() <= alignedStart.getTime()) {
      return JSON.stringify({ error: "Fenêtre temporelle invalide (end_date <= start_date)." });
    }

    log(`Consultation free/busy de ${emails.length} personne(s) sur ${Math.round((endDate.getTime() - alignedStart.getTime()) / 3600000)}h...`);

    const schedules = await getSchedule(emails, alignedStart, endDate, INTERVAL_MIN);

    const missing: string[] = [];
    const schedById = new Map<string, string>();
    for (const s of schedules) {
      if (s.error || !s.availabilityView) {
        missing.push(s.scheduleId);
        log(`  ⚠ ${s.scheduleId}: ${s.error?.message || "pas de données free/busy"}`);
      } else {
        schedById.set(s.scheduleId.toLowerCase(), s.availabilityView);
      }
    }

    const totalSlots = Math.floor((endDate.getTime() - alignedStart.getTime()) / 60000 / INTERVAL_MIN);
    const slotsNeeded = Math.max(1, Math.ceil(durationMin / INTERVAL_MIN));

    // Per-participant availability views; missing data → treat as fully busy.
    const participantViews = emails.map((email) => ({
      email,
      view: schedById.get(email.toLowerCase()) ?? "2".repeat(totalSlots),
    }));

    interface ScoredCandidate {
      start: Date;
      end: Date;
      freeEmails: string[];
      busyEmails: string[];
      score: number; // === freeEmails.length
    }

    // Walk every valid start position, score each by how many participants are
    // free for the FULL duration (cells [k, k+slotsNeeded)). Apply day/time
    // window filters before scoring so we only retain useful candidates.
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
      return JSON.stringify({
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
      });
    }

    // Bucket by score so we can walk highest → lowest in the fallback case.
    const tiers = new Map<number, ScoredCandidate[]>();
    for (const c of all) {
      if (!tiers.has(c.score)) tiers.set(c.score, []);
      tiers.get(c.score)!.push(c);
    }
    const maxScore = Math.max(...tiers.keys());
    const allFreeAvailable = maxScore === N;

    // Within a tier: prefer one slot per day first, then chronological filler.
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
      // Everyone-free slots exist: only return those (fallback not needed).
      result.push(...pickFromTier(tiers.get(N)!, maxResults));
    } else {
      // No slot fits everyone — walk down score tiers (N-1, N-2, ...).
      const sortedScores = [...tiers.keys()].sort((a, b) => b - a);
      for (const score of sortedScores) {
        const remaining = maxResults - result.length;
        if (remaining <= 0) break;
        result.push(...pickFromTier(tiers.get(score)!, remaining));
      }
    }

    log(
      `${result.length} créneau(x) ${allFreeAvailable ? "tous-libres" : `partiels (max ${maxScore}/${N} libres)`} retournés` +
      (missing.length > 0 ? ` — ${missing.length} agenda(s) inaccessibles : ${missing.join(", ")}` : "")
    );

    return JSON.stringify({
      participants: emails,
      include_self: includeSelf,
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
        startLocal: c.start.toLocaleString("fr-CH", { dateStyle: "full", timeStyle: "short" }),
        endLocal: c.end.toLocaleString("fr-CH", { timeStyle: "short" }),
        free_count: c.score,
        busy_count: c.busyEmails.length,
        free_participants: c.freeEmails,
        busy_participants: c.busyEmails,
      })),
    });
  },

  async identify_topic_participants(args, log) {
    const topic = args.topic as string;
    const maxPeople = (args.max_people as number) || 10;
    const LOOKBACK_MONTHS = 6;
    const MAX_FETCH = 2000;
    const TOP_N = 200;
    const MAX_EMAILS_PER_PERSON = 5;

    // Step 1: Get ALL emails from last N months (inbox only)
    log(`Récupération des emails reçus sur les ${LOOKBACK_MONTHS} derniers mois (cap: ${MAX_FETCH})...`);
    const allRecentEmails = await getRecentEmails(LOOKBACK_MONTHS, MAX_FETCH);

    if (allRecentEmails.length === 0) {
      return JSON.stringify({ message: `Aucun email trouvé sur les ${LOOKBACK_MONTHS} derniers mois.`, people: [] });
    }
    const cappedNote = allRecentEmails.length >= MAX_FETCH ? ` (cap atteint — période peut être incomplète)` : "";
    log(`${allRecentEmails.length} emails récupérés${cappedNote}`);

    // Step 2: Identify all correspondents
    const byPerson = new Map<string, { name: string; email: string; allEmails: typeof allRecentEmails }>();
    for (const e of allRecentEmails) {
      const addr = e.from?.emailAddress?.address?.toLowerCase();
      if (!addr) continue;
      const name = e.from?.emailAddress?.name || addr;
      if (!byPerson.has(addr)) {
        byPerson.set(addr, { name, email: addr, allEmails: [] });
      }
      byPerson.get(addr)!.allEmails.push(e);
    }
    log(`${byPerson.size} correspondants distincts identifiés`);

    // Step 3: Embed ALL emails → top N by similarity to topic
    log(`Classement sémantique (embeddings) de ${allRecentEmails.length} emails sur le sujet...`);
    const emailTexts = allRecentEmails.map((e) => `${e.subject} ${e.bodyPreview}`);
    const allTexts = [topic, ...emailTexts];
    const embeddings = await batchEmbed(allTexts);
    const queryEmbedding = embeddings[0];
    const emailEmbeddings = embeddings.slice(1);
    const ranked = rankBySimilarity(queryEmbedding, emailEmbeddings);
    const topRanked = ranked.slice(0, TOP_N);
    log(`Top ${topRanked.length} emails sélectionnés (score max: ${topRanked[0]?.score.toFixed(3)}, min: ${topRanked[topRanked.length - 1]?.score.toFixed(3)})`);

    // Step 4: Group top-N emails by sender, keeping ranking order (score-desc)
    const topByPerson = new Map<string, Array<{ email: typeof allRecentEmails[number]; score: number }>>();
    for (const r of topRanked) {
      const e = allRecentEmails[r.index];
      const addr = e.from?.emailAddress?.address?.toLowerCase();
      if (!addr) continue;
      if (!topByPerson.has(addr)) topByPerson.set(addr, []);
      topByPerson.get(addr)!.push({ email: e, score: r.score });
    }

    // For each survivor, take their TOP-scored emails from the top-N (not the most recent)
    const survivors = [...topByPerson.entries()]
      .map(([addr, items]) => {
        const person = byPerson.get(addr)!;
        const topEmails = items.slice(0, MAX_EMAILS_PER_PERSON).map((i) => i.email);
        return { ...person, topCount: items.length, topEmails };
      })
      .sort((a, b) => b.topCount - a.topCount)
      .slice(0, maxPeople);

    log(`${topByPerson.size} correspondants dans le top ${TOP_N}, analyse des ${survivors.length} principaux`);

    // Step 5: Read full body for survivors' top-scored emails
    const allEmailIds = survivors.flatMap((p) => p.topEmails.map((e) => e.id));
    log(`Lecture du contenu complet de ${allEmailIds.length} emails...`);
    const fullEmails = await getEmailsBatch(allEmailIds);
    const fullById = new Map(fullEmails.map((f) => [f.id, f]));

    // Step 6: Build digest per person, send to LLM
    const personDigests = survivors.map((person) => {
      const emailDigest = person.topEmails.map((e) => {
        const full = fullById.get(e.id);
        const body = full?.body?.content ? cleanEmailBodyFull(full.body.content).slice(0, 1500) : e.bodyPreview;
        const date = new Date(e.receivedDateTime).toLocaleDateString("fr-FR");
        return `[${date}] Sujet: ${e.subject}\n${body}`;
      }).join("\n---\n");
      return `### ${person.name} (${person.email}) — ${person.topCount} emails pertinents dans le top ${TOP_N}, ${person.allEmails.length} emails total\n${emailDigest}`;
    }).join("\n\n");

    const today = new Date().toLocaleDateString("fr-FR", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          `Tu es un assistant expert en analyse d'échanges email. Nous sommes le ${today}. ` +
          `On te donne des emails échangés par plusieurs personnes autour du sujet "${topic}". ` +
          "Certaines personnes listées peuvent ne PAS être réellement pertinentes pour ce sujet " +
          "(faux positifs du moteur de recherche). Ignore-les et ne les mentionne pas.\n\n" +
          "Pour chaque personne RÉELLEMENT impliquée dans le sujet, indique :\n" +
          "- **Rôle** : son rôle par rapport à ce sujet (décideur, exécutant, conseiller, observateur...)\n" +
          "- **Positionnement** : sa position/opinion sur le sujet\n" +
          "- **Contributions clés** : ses apports concrets (décisions, propositions, livrables)\n\n" +
          "Réponds en français avec un résumé structuré par personne. Sois concis et factuel. " +
          "Ne liste que les personnes véritablement pertinentes.",
      },
      {
        role: "user",
        content: `Sujet exploré : "${topic}"\n\n${personDigests}\n\nAnalyse le rôle et le positionnement de chaque personne réellement impliquée.`,
      },
    ];

    log(`Analyse des rôles par le LLM...`);
    const response = await chatCompletion(messages);
    const analysis = response.choices?.[0]?.message?.content || "Analyse non disponible.";

    return JSON.stringify({
      topic,
      people_found: topByPerson.size,
      people_analyzed: survivors.length,
      emails_total: allRecentEmails.length,
      emails_ranked: topRanked.length,
      people: survivors.map((p) => ({ name: p.name, email: p.email, emails_in_top_ranked: p.topCount })),
      analysis,
    });
  },

  async summarize_topic_status(args, log) {
    const topic = args.topic as string;
    const months = (args.months as number) || 6;
    const maxEmails = (args.max_emails as number) || 30;
    const MAX_FETCH_PER_DIRECTION = 2000;

    // Step 1: fetch received + sent in parallel
    log(`Récupération des emails des ${months} derniers mois (reçus + envoyés, cap: ${MAX_FETCH_PER_DIRECTION} par direction)...`);
    const [received, sent] = await Promise.all([
      getRecentEmails(months, MAX_FETCH_PER_DIRECTION),
      getRecentSentEmails(months, MAX_FETCH_PER_DIRECTION),
    ]);
    const capNote = (received.length >= MAX_FETCH_PER_DIRECTION || sent.length >= MAX_FETCH_PER_DIRECTION)
      ? " (cap atteint — période peut être incomplète)" : "";
    log(`${received.length} reçus, ${sent.length} envoyés${capNote}`);

    // Step 2: merge + dedupe by id, normalize direction
    const byId = new Map<string, {
      id: string;
      subject: string;
      bodyPreview: string;
      date: string;
      direction: "received" | "sent";
      from: string;
    }>();
    for (const e of received) {
      byId.set(e.id, {
        id: e.id,
        subject: e.subject,
        bodyPreview: e.bodyPreview,
        date: e.receivedDateTime,
        direction: "received",
        from: e.from?.emailAddress?.name || e.from?.emailAddress?.address || "?",
      });
    }
    for (const e of sent) {
      if (byId.has(e.id)) continue;
      byId.set(e.id, {
        id: e.id,
        subject: e.subject,
        bodyPreview: e.bodyPreview,
        date: e.receivedDateTime,
        direction: "sent",
        from: "Moi",
      });
    }
    const allEmails = [...byId.values()];
    if (allEmails.length === 0) {
      return JSON.stringify({ message: "Aucun email trouvé sur la période.", topic, timeline: [] });
    }

    // Step 3: semantic ranking against topic
    log(`Classement sémantique (embeddings) de ${allEmails.length} emails sur le sujet...`);
    const texts = allEmails.map((e) => `${e.subject} ${e.bodyPreview}`);
    const embeddings = await batchEmbed([topic, ...texts]);
    const ranked = rankBySimilarity(embeddings[0], embeddings.slice(1));
    const topN = Math.min(maxEmails, allEmails.length);
    const survivors = ranked.slice(0, topN).map((r) => allEmails[r.index]);
    log(`Top ${topN} emails sélectionnés (score max: ${ranked[0]?.score.toFixed(3)}, min: ${ranked[topN - 1]?.score.toFixed(3)})`);

    // Step 4: read full body for survivors
    log(`Lecture du contenu complet des ${survivors.length} emails...`);
    const fullEmails = await getEmailsBatch(survivors.map((e) => e.id));
    const fullById = new Map(fullEmails.map((f) => [f.id, f]));

    // Step 5: sort chronologically ascending (oldest first) for timeline narrative
    survivors.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // Step 6: build digest + synthesize
    const digest = survivors.map((e) => {
      const full = fullById.get(e.id);
      const body = full?.body?.content
        ? cleanEmailBodyFull(full.body.content).slice(0, 1500)
        : e.bodyPreview;
      const date = new Date(e.date).toLocaleDateString("fr-FR");
      const tag = e.direction === "sent" ? "ENVOYÉ par moi" : `REÇU de ${e.from}`;
      return `[${date}] [${tag}] Sujet: ${e.subject}\n${body}`;
    }).join("\n---\n");

    const today = new Date().toLocaleDateString("fr-FR", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          `Tu es un assistant expert en suivi de dossiers et projets. Nous sommes le ${today}. ` +
          `On te donne les emails (reçus ET envoyés par l'utilisateur) échangés autour du sujet "${topic}", ` +
          "triés du plus ancien au plus récent. Certains emails peuvent ne PAS être réellement liés au sujet " +
          "(faux positifs du moteur de recherche). Ignore-les silencieusement.\n\n" +
          "Produis un POINT D'AVANCEMENT structuré en français avec ces sections :\n" +
          "## Point actuel\n" +
          "Une à deux phrases qui résument où on en est aujourd'hui.\n\n" +
          "## Dernières évolutions\n" +
          "Bullets datés (format JJ/MM) en ordre chronologique, max 8 points, en se concentrant sur " +
          "les événements clés (décisions, envois, réponses reçues, changements d'état).\n\n" +
          "## Prochaines étapes\n" +
          "Ce qui est attendu ensuite, idéalement avec qui doit faire quoi.\n\n" +
          "## En attente / blocages\n" +
          "Tout point qui coince, question sans réponse, relance nécessaire. Mettre \"Rien d'identifié\" si absent.\n\n" +
          "Sois concis et factuel. Ne reproduis pas le texte brut des emails — synthétise.",
      },
      {
        role: "user",
        content: `Sujet : "${topic}"\n\nEmails (ordre chronologique) :\n\n${digest}\n\nFais le point d'avancement.`,
      },
    ];

    log(`Génération du point d'avancement par le LLM...`);
    const response = await chatCompletion(messages);
    const analysis = response.choices?.[0]?.message?.content || "Analyse non disponible.";

    return JSON.stringify({
      topic,
      period_months: months,
      emails_total: allEmails.length,
      emails_analyzed: survivors.length,
      timeline: survivors.map((e) => ({
        date: e.date,
        direction: e.direction,
        from: e.from,
        subject: e.subject,
      })),
      analysis,
    });
  },

  async load_skill(args, log) {
    const skillId = args.skill_id as string;
    const content = await loadSkillContent(skillId);
    log(`Skill chargé: ${skillId}`);
    return JSON.stringify({ skill_id: skillId, instructions: content });
  },

  async search_contacts_in_servicedesk(args, _log) {
    const query = args.query as string;
    const results = await searchContactsInServiceDesk(query);
    if (results.length === 0) {
      return JSON.stringify({
        message: `Aucun contact trouvé pour "${query}" dans les emails ServiceDesk.`,
        contacts: [],
      });
    }
    return JSON.stringify({ contacts: results });
  },
};

/**
 * Execute a tool by name with the given arguments.
 * Returns a JSON string result (or error message).
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  log?: LogFn,
  onProgress?: ToolProgressFn,
  onStream?: ToolStreamFn,
  signal?: AbortSignal
): Promise<string> {
  const executor = executors[toolName];
  if (!executor) {
    return JSON.stringify({ error: `Outil inconnu: ${toolName}` });
  }

  const toolLog: LogFn = (msg) => {
    console.log(`[Tool:${toolName}] ${msg}`);
    log?.(`[${toolName}] ${msg}`);
  };

  try {
    return await executor(args, toolLog, onProgress, onStream, signal);
  } catch (err) {
    // Let abort propagate so the agent loop can bail cleanly.
    if (err instanceof Error && err.name === "AbortError") throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Agent] Tool ${toolName} error:`, message);
    return JSON.stringify({ error: `Erreur lors de l'exécution de ${toolName}: ${message}` });
  }
}
