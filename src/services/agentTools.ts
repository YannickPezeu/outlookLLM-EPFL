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
  getCalendarView,
  getEmailsBatch,
  DateRange,
} from "./graphMailService";
import { batchEmbed, rankBySimilarity } from "./embeddingService";
import { cleanEmailBodyFull } from "./cleanEmailBody";
import { getSkillCatalogForPrompt, getSkillIds, loadSkillContent } from "../skills/skillRegistry";
import { prepareMeeting } from "./meetingPrepService";
import { GraphMailDataSource } from "./graphMailDataSource";

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
      name: "summarize_email_interactions",
      description:
        "Génère un résumé structuré des échanges email avec un contact. " +
        "Déduplique par conversation (garde le dernier Re: de chaque thread), " +
        "nettoie le HTML, et produit un résumé IA incluant les sujets abordés, " +
        "les décisions prises, les points en suspens, et une liste de to-dos pour la suite. " +
        "Nécessite le nom et l'adresse email du contact. " +
        "Utiliser get_email_interactions si on veut juste la LISTE des emails sans résumé.",
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
      name: "explore_topic",
      description:
        "Explore un sujet/thème dans les emails de l'utilisateur. " +
        "Identifie les personnes impliquées, leur rôle et leur positionnement sur ce sujet. " +
        "Cherche les emails pertinents, les classe par correspondant, et résume le rôle de chacun. " +
        "Utiliser quand l'utilisateur pose une question comme 'qui travaille sur X ?', " +
        "'quels sont les acteurs sur le thème Y ?', 'qui est impliqué dans Z ?'.",
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
type ToolExecutor = (args: Record<string, unknown>, log: LogFn, onProgress?: ToolProgressFn) => Promise<string>;

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
      id: e.id,
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

  async summarize_email_interactions(args, log) {
    const name = args.name as string;
    const email = args.email as string;
    const dateRange = extractDateRange(args);
    const query = args.query as string | undefined;

    // Default to last 6 months if no date range specified
    const effectiveDateRange = dateRange || {
      startDate: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString(),
      endDate: new Date().toISOString(),
    };

    log(`Collecte des emails avec ${name}...`);

    const [{ received, sent }, serviceDeskEmails] = await Promise.all([
      email ? getAllInteractions(email, undefined, effectiveDateRange) : Promise.resolve({ received: [], sent: [] }),
      getServiceDeskEmailsForPerson(name, undefined, effectiveDateRange),
    ]);

    // Merge all emails
    const allEmails = [
      ...received.map((e) => ({
        id: e.id, subject: e.subject, body: e.body?.content || e.bodyPreview || "",
        date: e.receivedDateTime, direction: "received" as const,
        conversationId: (e as any).conversationId as string | undefined,
      })),
      ...sent.map((e) => ({
        id: e.id, subject: e.subject, body: e.body?.content || e.bodyPreview || "",
        date: e.sentDateTime || e.receivedDateTime, direction: "sent" as const,
        conversationId: (e as any).conversationId as string | undefined,
      })),
      ...serviceDeskEmails.map((e) => ({
        id: e.id, subject: `[ServiceNow] ${e.subject}`, body: e.body?.content || e.bodyPreview || "",
        date: e.receivedDateTime, direction: "servicedesk" as const,
        conversationId: (e as any).conversationId as string | undefined,
      })),
    ];

    log(`${allEmails.length} emails collectés (${received.length} reçus, ${sent.length} envoyés, ${serviceDeskEmails.length} ServiceDesk)`);

    let emailsToSummarize = allEmails;

    // Semantic filtering if query is provided
    if (query && emailsToSummarize.length > 0) {
      log(`Filtrage sémantique: "${query}"...`);
      const texts = emailsToSummarize.map((e) => `${e.subject} ${e.body.replace(/<[^>]+>/g, " ").slice(0, 2000)}`);
      const [queryEmb, ...itemEmbs] = await batchEmbed([query, ...texts]);
      const ranked = rankBySimilarity(queryEmb, itemEmbs);
      const topN = Math.min(50, emailsToSummarize.length);
      emailsToSummarize = ranked.slice(0, topN).map((r) => emailsToSummarize[r.index]);
      log(`Top ${topN} emails par pertinence sélectionnés`);
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

    log(`Génération du résumé (${emailsToSummarize.length} emails)...`);

    const summary = await summarizeInteractions(
      name, email, emailsToSummarize, undefined, config.rcp.synthesisModel
    );

    return JSON.stringify({
      name,
      email,
      emails_analyzed: emailsToSummarize.length,
      emails_total: allEmails.length,
      query: query || null,
      summary,
    });
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

  async prepare_meeting(args, log, onProgress) {
    const eventId = args.event_id as string;

    log("Démarrage de la préparation de réunion...");
    onProgress?.("Démarrage...");

    const ds = new GraphMailDataSource();
    let briefingText = "";

    const result = await prepareMeeting(
      ds,
      eventId,
      (progress) => {
        log(`[${progress.phase}] ${progress.message}${progress.detail ? ` — ${progress.detail}` : ""}`);
        onProgress?.(`${progress.message} (${progress.percent}%)`);
      },
      (chunk) => {
        briefingText += chunk;
      }
    );

    return JSON.stringify({
      event: result.event.subject,
      participants: result.participants.map((p) => p.name),
      participantCount: result.participants.length,
      emailsAnalyzed: result.participantBriefings.reduce((sum, b) => sum + b.emailCount, 0),
      briefing: result.finalBriefing,
    });
  },

  async explore_topic(args, log) {
    const topic = args.topic as string;
    const maxPeople = (args.max_people as number) || 10;

    // Step 1: Get ALL emails from last 6 months
    log(`Récupération des emails des 6 derniers mois...`);
    const allRecentEmails = await getRecentEmails(6, 2000);

    if (allRecentEmails.length === 0) {
      return JSON.stringify({ message: "Aucun email trouvé sur les 6 derniers mois.", people: [] });
    }
    log(`${allRecentEmails.length} emails récupérés`);

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
    log(`${byPerson.size} correspondants identifiés`);

    // Step 3: Embed ALL emails → top 200 by similarity to topic
    log(`Embedding de ${allRecentEmails.length} emails...`);
    const emailTexts = allRecentEmails.map((e) => `${e.subject} ${e.bodyPreview}`);
    const allTexts = [topic, ...emailTexts];
    const embeddings = await batchEmbed(allTexts);
    const queryEmbedding = embeddings[0];
    const emailEmbeddings = embeddings.slice(1);
    const ranked = rankBySimilarity(queryEmbedding, emailEmbeddings);
    const top200 = ranked.slice(0, 200);
    log(`Top ${top200.length} emails par pertinence sémantique`);

    // Step 4: Which correspondents survived in top 200?
    const survivorEmailIds = new Map<string, Set<string>>();
    for (const r of top200) {
      const e = allRecentEmails[r.index];
      const addr = e.from?.emailAddress?.address?.toLowerCase();
      if (!addr) continue;
      if (!survivorEmailIds.has(addr)) survivorEmailIds.set(addr, new Set());
      survivorEmailIds.get(addr)!.add(e.id);
    }

    // For each survivor, take the 5 most recent emails (from their full list, not just top200)
    const survivors = [...survivorEmailIds.entries()]
      .map(([addr, topIds]) => {
        const person = byPerson.get(addr)!;
        const recent5 = person.allEmails
          .sort((a, b) => new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime())
          .slice(0, 5);
        return { ...person, topCount: topIds.size, recentEmails: recent5 };
      })
      .sort((a, b) => b.topCount - a.topCount)
      .slice(0, maxPeople);

    log(`${survivorEmailIds.size} correspondants dans le top 200, analyse des ${survivors.length} principaux...`);

    // Step 5: Read full body for survivors' recent emails
    const allEmailIds = survivors.flatMap((p) => p.recentEmails.map((e: any) => e.id));
    const fullEmails = await getEmailsBatch(allEmailIds);
    const fullById = new Map(fullEmails.map((f) => [f.id, f]));

    // Step 6: Build digest per person, send to LLM
    const personDigests = survivors.map((person) => {
      const emailDigest = person.recentEmails.map((e: any) => {
        const full = fullById.get(e.id);
        const body = full?.body?.content ? cleanEmailBodyFull(full.body.content).slice(0, 1500) : e.bodyPreview;
        const date = new Date(e.receivedDateTime).toLocaleDateString("fr-FR");
        return `[${date}] Sujet: ${e.subject}\n${body}`;
      }).join("\n---\n");
      return `### ${person.name} (${person.email}) — ${person.topCount} emails pertinents dans le top 200, ${person.allEmails.length} emails total\n${emailDigest}`;
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
    const response = await chatCompletion(messages, config.rcp.synthesisModel);
    const analysis = response.choices?.[0]?.message?.content || "Analyse non disponible.";

    return JSON.stringify({
      topic,
      people_found: survivorEmailIds.size,
      people_analyzed: survivors.length,
      emails_total: allRecentEmails.length,
      emails_ranked: top200.length,
      people: survivors.map((p) => ({ name: p.name, email: p.email, emails_in_top200: p.topCount })),
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
  onProgress?: ToolProgressFn
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
    return await executor(args, toolLog, onProgress);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Agent] Tool ${toolName} error:`, message);
    return JSON.stringify({ error: `Erreur lors de l'exécution de ${toolName}: ${message}` });
  }
}
