import { ToolDefinition } from "./rcpApiService";
import {
  searchContactsByName,
  getAllInteractions,
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
        "Récupère la liste des emails échangés avec un contact (reçus et envoyés). " +
        "Retourne les sujets, dates et comptages. Nécessite l'adresse email exacte.",
      parameters: {
        type: "object",
        properties: {
          email: {
            type: "string",
            description: "L'adresse email exacte du contact",
          },
        },
        required: ["email"],
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
];

// ─── Tool Executors ─────────────────────────────────────────────────

type ToolExecutor = (args: Record<string, unknown>) => Promise<string>;

const executors: Record<string, ToolExecutor> = {
  async search_contacts(args) {
    const query = args.query as string;
    const contacts = await searchContactsByName(query);
    if (contacts.length === 0) {
      return JSON.stringify({ message: `Aucun contact trouvé pour "${query}".`, contacts: [] });
    }
    return JSON.stringify({ contacts });
  },

  async get_email_interactions(args) {
    const email = args.email as string;
    const { received, sent } = await getAllInteractions(email);

    // Return summary info (subjects, dates) — not full bodies to stay within token limits
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

    return JSON.stringify({
      received_count: received.length,
      sent_count: sent.length,
      recent_received: receivedSummary,
      recent_sent: sentSummary,
    });
  },

  async summarize_email_interactions(args) {
    const name = args.name as string;
    const email = args.email as string;
    const { received, sent } = await getAllInteractions(email);

    if (received.length === 0 && sent.length === 0) {
      return JSON.stringify({ message: `Aucun email trouvé avec ${name} (${email}).` });
    }

    const receivedData = received.map((e) => ({
      subject: e.subject,
      body: e.body?.content || e.bodyPreview || "",
      date: e.receivedDateTime,
    }));
    const sentData = sent.map((e) => ({
      subject: e.subject,
      body: e.body?.content || e.bodyPreview || "",
      date: e.sentDateTime || e.receivedDateTime,
    }));

    // Non-streaming call — we're inside the agent loop
    const summary = await summarizeInteractions(name, email, receivedData, sentData);
    return JSON.stringify({
      summary,
      email_count: { received: received.length, sent: sent.length },
    });
  },

  async get_calendar_events(args) {
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

  async search_emails(args) {
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
};

/**
 * Execute a tool by name with the given arguments.
 * Returns a JSON string result (or error message).
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  const executor = executors[toolName];
  if (!executor) {
    return JSON.stringify({ error: `Outil inconnu: ${toolName}` });
  }

  try {
    return await executor(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Agent] Tool ${toolName} error:`, message);
    return JSON.stringify({ error: `Erreur lors de l'exécution de ${toolName}: ${message}` });
  }
}
