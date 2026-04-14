import { ToolDefinition } from "./rcpApiService";
import {
  searchContactsByName,
  searchContactsInServiceDesk,
  getAllInteractions,
  getServiceDeskEmailsForPerson,
  searchEmails,
  getCalendarView,
  DateRange,
} from "./graphMailService";
import { batchEmbed, rankBySimilarity } from "./embeddingService";
import { getSkillCatalogForPrompt, getSkillIds, loadSkillContent } from "../skills/skillRegistry";

// ─── Tool Definitions (OpenAI function-calling format) ──────────────

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_contacts",
      description:
        "Recherche des contacts par nom dans les emails de l'utilisateur. " +
        "Gère les noms partiels, les accents manquants, etc. " +
        "Retourne une liste de contacts avec nom et adresse email. " +
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
        "Récupère la liste des emails échangés avec un contact (reçus, envoyés, et tickets ServiceDesk). " +
        "Retourne les sujets, dates et comptages. Nécessite le nom et l'adresse email. " +
        "Supporte le filtrage par période temporelle via start_date/end_date. " +
        "Si query est fourni, les emails sont triés par pertinence sémantique (embeddings) par rapport à la query.",
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
        "Par défaut, retourne les événements des 7 prochains jours.",
      parameters: {
        type: "object",
        properties: {
          start_date: {
            type: "string",
            description: "Date de début au format ISO 8601 (ex: 2025-01-15T00:00:00). Par défaut: maintenant.",
          },
          end_date: {
            type: "string",
            description: "Date de fin au format ISO 8601. Par défaut: 7 jours après start_date.",
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
      name: "show_emails",
      description:
        "Ouvre la recherche Outlook filtrée dans un nouvel onglet pour afficher les emails d'un contact. " +
        "Utiliser quand l'utilisateur veut VOIR/AFFICHER/MONTRER ses échanges (pas les résumer). " +
        "Retourne un lien cliquable que l'utilisateur peut ouvrir. " +
        "Supporte le filtrage par période temporelle via start_date/end_date.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Le nom complet du contact",
          },
          email: {
            type: "string",
            description: "L'adresse email du contact",
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
        required: ["name", "email"],
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
type ToolExecutor = (args: Record<string, unknown>, log: LogFn) => Promise<string>;

function extractDateRange(args: Record<string, unknown>): DateRange | undefined {
  const startDate = args.start_date as string | undefined;
  const endDate = args.end_date as string | undefined;
  return (startDate || endDate) ? { startDate, endDate } : undefined;
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
    const dateRange = extractDateRange(args);
    const query = args.query as string | undefined;

    // Default to last 6 months if no date range specified
    const effectiveDateRange = dateRange || {
      startDate: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString(),
      endDate: new Date().toISOString(),
    };
    const usingDefault = !dateRange;

    // Skip direct email search if no email address (ServiceDesk-only contacts)
    const [{ received, sent }, serviceDeskEmails] = await Promise.all([
      email ? getAllInteractions(email, undefined, effectiveDateRange) : Promise.resolve({ received: [], sent: [] }),
      getServiceDeskEmailsForPerson(name, undefined, effectiveDateRange),
    ]);

    log(`Emails collectés: ${received.length} reçus, ${sent.length} envoyés, ${serviceDeskEmails.length} ServiceDesk${usingDefault ? " (limité aux 6 derniers mois par défaut)" : ""}`);

    // Merge all emails into a unified list
    const allEmails = [
      ...received.map((e) => ({ ...e, direction: "received" as const, displayDate: e.receivedDateTime })),
      ...sent.map((e) => ({ ...e, direction: "sent" as const, displayDate: e.sentDateTime || e.receivedDateTime })),
      ...serviceDeskEmails.map((e) => ({ ...e, direction: "servicedesk" as const, displayDate: e.receivedDateTime, subject: `[ServiceNow] ${e.subject}` })),
    ];

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

    // Semantic search via embeddings if query is provided
    if (query && topEmails.length > 0) {
      log(`Recherche sémantique: "${query}" sur ${topEmails.length} emails...`);
      const texts = topEmails.map((e) => {
        const body = e.body?.content
          ? e.body.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 2000)
          : e.bodyPreview?.slice(0, 500) || "";
        return `${e.subject} ${body}`;
      });
      const [queryEmbeddings, ...itemEmbeddings] = await batchEmbed([query, ...texts]);
      const ranked = rankBySimilarity(queryEmbeddings, itemEmbeddings);
      const topN = Math.min(30, topEmails.length);
      topEmails = ranked.slice(0, topN).map((r) => topEmails[r.index]);
      log(`Top ${topN} emails par pertinence sélectionnés (score max: ${ranked[0]?.score.toFixed(3)})`);
    }

    // Sort by date descending
    topEmails.sort((a, b) => new Date(b.displayDate).getTime() - new Date(a.displayDate).getTime());

    for (const e of topEmails.slice(0, 10)) {
      const tag = e.direction === "sent" ? "envoyé" : e.direction === "servicedesk" ? "ServiceNow" : "reçu";
      log(`  [${tag}] ${e.displayDate?.slice(0, 10)} | ${e.subject}`);
    }

    const emailSummaries = topEmails.slice(0, 30).map((e) => ({
      id: e.id,
      subject: e.subject,
      date: e.displayDate,
      direction: e.direction,
      preview: e.bodyPreview?.slice(0, 200),
    }));

    return JSON.stringify({
      total_count: allEmails.length,
      returned_count: emailSummaries.length,
      query: query || null,
      default_period: usingDefault ? "6 derniers mois" : null,
      capped: capped ? `Limité à 500 emails sur ${allEmails.length} total` : null,
      emails: emailSummaries,
    });
  },

  async get_calendar_events(args, _log) {
    const now = new Date();
    const startDate = (args.start_date as string) || now.toISOString();
    const endDate =
      (args.end_date as string) ||
      new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const events = await getCalendarView(startDate, endDate);

    const eventSummaries = events.map((e) => ({
      subject: e.subject,
      start: e.start.dateTime,
      end: e.end.dateTime,
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
      from: e.from?.emailAddress?.name || e.from?.emailAddress?.address,
      date: e.receivedDateTime,
      preview: e.bodyPreview?.slice(0, 200),
    }));

    return JSON.stringify({ results, count: emails.length });
  },

  async show_emails(args, log) {
    const name = args.name as string;
    const email = args.email as string;
    const dateRange = extractDateRange(args);

    const [{ received, sent }, serviceDeskEmails] = await Promise.all([
      email ? getAllInteractions(email, undefined, dateRange) : Promise.resolve({ received: [], sent: [] }),
      getServiceDeskEmailsForPerson(name, undefined, dateRange),
    ]);

    // Build a unified list sorted by date
    const allEmails = [
      ...received.map((e) => ({
        id: e.id,
        subject: e.subject,
        date: e.receivedDateTime,
        from: e.from?.emailAddress?.name || e.from?.emailAddress?.address || "?",
        direction: "received" as const,
      })),
      ...sent.map((e) => ({
        id: e.id,
        subject: e.subject,
        date: e.sentDateTime || e.receivedDateTime,
        from: "Moi",
        direction: "sent" as const,
      })),
      ...serviceDeskEmails.map((e) => ({
        id: e.id,
        subject: `[ServiceNow] ${e.subject}`,
        date: e.receivedDateTime,
        from: "ServiceDesk",
        direction: "received" as const,
      })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    log(`show_emails: ${allEmails.length} emails (${received.length} reçus, ${sent.length} envoyés, ${serviceDeskEmails.length} ServiceDesk)`);

    return JSON.stringify({
      type: "email_list",
      name,
      email,
      emails: allEmails,
      count: allEmails.length,
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
  log?: LogFn
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
    return await executor(args, toolLog);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Agent] Tool ${toolName} error:`, message);
    return JSON.stringify({ error: `Erreur lors de l'exécution de ${toolName}: ${message}` });
  }
}
