import { ToolDefinition } from "./rcpApiService";
import {
  searchContactsByName,
  searchContactsInServiceDesk,
  getAllInteractions,
  getServiceDeskEmailsForPerson,
  searchEmails,
  getCalendarView,
} from "./graphMailService";
import { summarizeInteractions } from "./rcpApiService";

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
        "Retourne les sujets, dates et comptages. Nécessite le nom et l'adresse email.",
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
        },
        required: ["name", "email"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "summarize_email_interactions",
      description:
        "Génère un résumé structuré des échanges email avec un contact. " +
        "Inclut les sujets principaux, actions en cours, décisions prises et points en suspens. " +
        "Cet outil peut prendre un moment car il analyse le contenu des emails.",
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
        "Cherche dans les sujets, corps et expéditeurs.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Le texte à rechercher dans les emails",
          },
          max_results: {
            type: "number",
            description: "Nombre maximum de résultats (défaut: 20)",
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
        "Retourne un lien cliquable que l'utilisateur peut ouvrir.",
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
        },
        required: ["name", "email"],
      },
    },
  },
];

// ─── Tool Executors ─────────────────────────────────────────────────

type LogFn = (msg: string) => void;
type ToolExecutor = (args: Record<string, unknown>, log: LogFn) => Promise<string>;

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

    // Skip direct email search if no email address (ServiceDesk-only contacts)
    const [{ received, sent }, serviceDeskEmails] = await Promise.all([
      email ? getAllInteractions(email) : Promise.resolve({ received: [], sent: [] }),
      getServiceDeskEmailsForPerson(name),
    ]);

    log(`Emails collectés: ${received.length} reçus, ${sent.length} envoyés, ${serviceDeskEmails.length} ServiceDesk`);
    for (const e of received.slice(0, 10)) {
      log(`  [reçu] ${e.receivedDateTime?.slice(0, 10)} | ${e.from?.emailAddress?.name || "?"} | ${e.subject}`);
    }
    for (const e of sent.slice(0, 10)) {
      log(`  [envoyé] ${(e.sentDateTime || e.receivedDateTime)?.slice(0, 10)} | ${e.subject}`);
    }
    for (const e of serviceDeskEmails.slice(0, 10)) {
      log(`  [ServiceNow] ${e.receivedDateTime?.slice(0, 10)} | ${e.subject}`);
    }

    const receivedSummary = received.slice(0, 20).map((e) => ({
      subject: e.subject,
      date: e.receivedDateTime,
      preview: e.bodyPreview?.slice(0, 150),
    }));
    const sentSummary = sent.slice(0, 20).map((e) => ({
      subject: e.subject,
      date: e.sentDateTime || e.receivedDateTime,
      preview: e.bodyPreview?.slice(0, 150),
    }));
    const serviceDeskSummary = serviceDeskEmails.slice(0, 20).map((e) => ({
      subject: `[ServiceNow] ${e.subject}`,
      date: e.receivedDateTime,
      preview: e.bodyPreview?.slice(0, 150),
    }));

    return JSON.stringify({
      received_count: received.length,
      sent_count: sent.length,
      servicedesk_count: serviceDeskEmails.length,
      recent_received: receivedSummary,
      recent_sent: sentSummary,
      recent_servicedesk: serviceDeskSummary,
    });
  },

  async summarize_email_interactions(args, log) {
    const name = args.name as string;
    const email = args.email as string;

    const [{ received, sent }, serviceDeskEmails] = await Promise.all([
      email ? getAllInteractions(email) : Promise.resolve({ received: [], sent: [] }),
      getServiceDeskEmailsForPerson(name),
    ]);

    log(`Résumé — emails collectés: ${received.length} reçus, ${sent.length} envoyés, ${serviceDeskEmails.length} ServiceDesk`);
    for (const e of received) {
      log(`  [reçu] ${e.receivedDateTime?.slice(0, 10)} | ${e.from?.emailAddress?.name || "?"} | ${e.subject}`);
    }
    for (const e of sent) {
      log(`  [envoyé] ${(e.sentDateTime || e.receivedDateTime)?.slice(0, 10)} | ${e.subject}`);
    }
    for (const e of serviceDeskEmails) {
      log(`  [ServiceNow] ${e.receivedDateTime?.slice(0, 10)} | ${e.subject}`);
    }

    if (received.length === 0 && sent.length === 0 && serviceDeskEmails.length === 0) {
      return JSON.stringify({ message: `Aucun email trouvé avec ${name} (${email}).` });
    }

    const receivedData = received.map((e) => ({
      subject: e.subject,
      body: e.body?.content || e.bodyPreview || "",
      date: e.receivedDateTime,
    }));

    const serviceDeskData = serviceDeskEmails.map((e) => ({
      subject: `[ServiceNow] ${e.subject}`,
      body: e.body?.content || e.bodyPreview || "",
      date: e.receivedDateTime,
    }));

    const sentData = sent.map((e) => ({
      subject: e.subject,
      body: e.body?.content || e.bodyPreview || "",
      date: e.sentDateTime || e.receivedDateTime,
    }));

    const allReceived = [...receivedData, ...serviceDeskData];
    log(`Total emails envoyés au LLM pour résumé: ${allReceived.length + sentData.length}`);

    const summary = await summarizeInteractions(name, email, allReceived, sentData);
    return JSON.stringify({
      summary,
      email_count: {
        received: received.length,
        sent: sent.length,
        servicedesk: serviceDeskEmails.length,
      },
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
    const maxResults = (args.max_results as number) || 20;
    const emails = await searchEmails(query, maxResults);

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

    const [{ received, sent }, serviceDeskEmails] = await Promise.all([
      email ? getAllInteractions(email) : Promise.resolve({ received: [], sent: [] }),
      getServiceDeskEmailsForPerson(name),
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
