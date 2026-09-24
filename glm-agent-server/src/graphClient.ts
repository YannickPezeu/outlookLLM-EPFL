/**
 * Client Microsoft Graph côté Node — port compact de src/services/graphMailService.ts.
 *
 * Différence clé avec la version navigateur : pas de MSAL ici. Le token Graph
 * est obtenu par l'add-in (MSAL/NAA) et transmis à chaque requête ; il vit dans
 * l'instance GraphClient le temps de la requête, jamais persisté.
 *
 * Périmètre POC : search_contacts (annuaire + historique mail),
 * getAllInteractions, searchEmails. Pas de ServiceDesk ni de cache local
 * (voir graphMailService.ts pour la version complète).
 */
import { distance as levenshtein } from "fastest-levenshtein";
import { config } from "./config.js";

const GRAPH = config.graph.baseUrl;

// Adresse du ServiceDesk EPFL : les échanges via tickets ServiceNow arrivent
// TOUS de cette adresse — les emails "d'une personne" peuvent donc être des
// tickets où elle est requérante, mentionnée dans le corps seulement.
const SERVICEDESK_EMAIL = "1234@epfl.ch";

// ─── Types (sous-ensemble de graphMailService) ───────────────────────

export interface EmailMessage {
  id: string;
  subject: string;
  bodyPreview: string;
  body?: { contentType: string; content: string };
  from?: { emailAddress: { name: string; address: string } };
  toRecipients?: Array<{ emailAddress: { name: string; address: string } }>;
  receivedDateTime: string;
  sentDateTime?: string;
  hasAttachments?: boolean;
  conversationId?: string;
  webLink?: string;
}

export interface DateRange {
  startDate?: string;
  endDate?: string;
}

export interface CalendarEvent {
  id: string;
  subject: string;
  bodyPreview: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location?: { displayName: string };
  attendees: Array<{
    emailAddress: { name: string; address: string };
    type: string;
    status?: { response: string };
  }>;
  isOrganizer: boolean;
  organizer?: { emailAddress: { name: string; address: string } };
  seriesMasterId?: string;
}

export interface ScheduleInformation {
  scheduleId: string;
  availabilityView?: string;
  scheduleItems?: Array<{
    status: string;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
  }>;
  error?: { message: string; responseCode: string };
}

export interface GraphAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
  contentBytes?: string;
  "@odata.type"?: string;
}

interface GraphPagedResponse<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

interface GraphUser {
  displayName?: string;
  givenName?: string;
  surname?: string;
  mail?: string;
  userPrincipalName?: string;
  jobTitle?: string;
  department?: string;
}

export interface ContactHit {
  name: string;
  email: string;
  source?: string;
  jobTitle?: string;
  department?: string;
}

// ─── Fuzzy matching (copie de graphMailService) ──────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extrait des noms de personnes d'un corps d'email (fenêtre glissante 2-4 mots
 * + fuzzy match par mot) — port de graphMailService.extractNamesFromBody.
 */
function extractNamesFromBody(bodyText: string, query: string): string[] {
  const words = bodyText.split(/\s+/).filter((w) => w.length > 1);
  const normalizedQuery = removeDiacritics(query.toLowerCase());
  const queryWords = normalizedQuery.split(/\s+/).filter(Boolean);
  const found: string[] = [];

  for (let windowSize = 2; windowSize <= 4; windowSize++) {
    for (let i = 0; i <= words.length - windowSize; i++) {
      const window = words.slice(i, i + windowSize);
      const normalizedWindow = removeDiacritics(window.join(" ").toLowerCase());
      const windowParts = normalizedWindow.split(/\s+/);

      let allMatch = true;
      for (const qw of queryWords) {
        let wordMatched = false;
        for (const wp of windowParts) {
          const dist = levenshtein(qw, wp);
          const threshold = qw.length <= 3 ? 1 : qw.length <= 6 ? 2 : 3;
          if (dist <= threshold) {
            wordMatched = true;
            break;
          }
        }
        if (!wordMatched) {
          allMatch = false;
          break;
        }
      }

      if (allMatch) {
        const cleanName = window
          .map((w) => w.replace(/[^a-zA-ZÀ-ÿ\-]/g, ""))
          .filter((w) => w.length > 1)
          .join(" ");
        if (cleanName && !found.includes(cleanName)) found.push(cleanName);
      }
    }
  }
  return found;
}

function removeDiacritics(str: string): string {
  return str.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function scoreWordPart(qWord: string, part: string): number {
  if (part === qWord) return 100;
  if (part.startsWith(qWord)) return 90;
  if (qWord.startsWith(part)) return 85;
  if (part.includes(qWord)) return 80;

  const dist = levenshtein(qWord, part);
  const maxLen = Math.max(qWord.length, part.length);
  const threshold = qWord.length <= 3 ? 1 : qWord.length <= 6 ? 2 : 3;
  if (dist <= threshold) return 75 * (1 - dist / maxLen);

  if (qWord.length < part.length) {
    const prefixDist = levenshtein(qWord, part.slice(0, qWord.length));
    if (prefixDist <= 1) return 70 - prefixDist * 10;
  }
  return 0;
}

function fuzzyScore(query: string, contact: { name: string; email: string }): number {
  const fullQuery = removeDiacritics(query.toLowerCase().trim());
  const fullName = removeDiacritics(contact.name.toLowerCase());
  const emailUser = contact.email.split("@")[0].toLowerCase().replace(/[._-]/g, " ");

  if (fullName.includes(fullQuery)) return 100 - (fullName.length - fullQuery.length);
  if (emailUser.replace(/\s/g, "").includes(fullQuery.replace(/\s/g, ""))) return 95;

  const queryWords = fullQuery.split(/\s+/).filter(Boolean);
  const nameParts = fullName.split(/[\s\-._]+/).filter(Boolean);
  const emailParts = emailUser.split(/\s+/).filter(Boolean);
  const allParts = [...new Set([...nameParts, ...emailParts])];
  if (queryWords.length === 0 || allParts.length === 0) return 0;

  let totalScore = 0;
  let matchedWords = 0;
  for (const qWord of queryWords) {
    let best = 0;
    for (const part of allParts) best = Math.max(best, scoreWordPart(qWord, part));
    if (best > 0) matchedWords++;
    totalScore += best;
  }
  if (matchedWords === 0) return 0;
  const avgScore = totalScore / queryWords.length;
  return avgScore + (matchedWords === queryWords.length ? 10 : 0);
}

// ─── Helpers date (copie de graphMailService) ────────────────────────

function buildDateFilter(dateRange?: DateRange, field = "receivedDateTime"): string {
  if (!dateRange) return "";
  const parts: string[] = [];
  if (dateRange.startDate) parts.push(`${field} ge ${dateRange.startDate.slice(0, 10)}T00:00:00Z`);
  if (dateRange.endDate) parts.push(`${field} lt ${dateRange.endDate.slice(0, 10)}T00:00:00Z`);
  return parts.join(" and ");
}

function kqlDateClause(dateRange: DateRange | undefined, prop: "received" | "sent"): string {
  if (dateRange?.startDate && dateRange?.endDate) {
    return ` AND ${prop}:${dateRange.startDate.slice(0, 10)}..${dateRange.endDate.slice(0, 10)}`;
  }
  return "";
}

function filterByDate<T>(items: T[], dateField: keyof T, dateRange: DateRange): T[] {
  const start = dateRange.startDate ? new Date(dateRange.startDate).getTime() : -Infinity;
  const end = dateRange.endDate ? new Date(dateRange.endDate).getTime() : Infinity;
  return items.filter((item) => {
    const v = item[dateField];
    if (typeof v !== "string") return false;
    const t = new Date(v).getTime();
    return t >= start && t < end;
  });
}

// ─── Client ──────────────────────────────────────────────────────────

interface ScoredContact extends ContactHit {
  score: number;
  count?: number;
}

/**
 * Token Graph invalide/expiré (401). Remonté explicitement jusqu'au tool pour
 * que le modèle dise « reconnecte-toi » au lieu de « aucun résultat » —
 * une liste vide sur un 401 est un mensonge.
 */
export class GraphAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphAuthError";
  }
}

export class GraphClient {
  private directoryUnavailable = false;

  constructor(private token: string) {}

  private async graphFetch<T>(url: string, options?: RequestInit, throttleRetriesLeft = 3): Promise<T> {
    console.log(`[graph] ${options?.method || "GET"} ${url.split("?")[0]}`);
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(options?.headers as Record<string, string>),
      },
    });

    if (response.status === 429 && throttleRetriesLeft > 0) {
      const retryAfter = response.headers.get("Retry-After");
      const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN;
      const delayMs = !Number.isNaN(parsed) && parsed > 0
        ? Math.min(parsed * 1000, 10000)
        : Math.min(500 * Math.pow(2, 3 - throttleRetriesLeft), 8000);
      console.warn(`[graph] 429 throttled, retry in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
      return this.graphFetch<T>(url, options, throttleRetriesLeft - 1);
    }

    if (response.status === 401) {
      // Pas de recovery MSAL côté serveur : le token est fourni par l'add-in.
      throw new GraphAuthError("Token Microsoft Graph invalide ou expiré (401)");
    }
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Graph API error ${response.status}: ${errorBody.slice(0, 500)}`);
    }
    return response.json() as Promise<T>;
  }

  private async fetchAllPages<T>(url: string, maxItems: number): Promise<T[]> {
    const items: T[] = [];
    let nextUrl: string | undefined = url;
    while (nextUrl && items.length < maxItems) {
      const page: GraphPagedResponse<T> = await this.graphFetch<GraphPagedResponse<T>>(nextUrl);
      items.push(...page.value);
      nextUrl = page["@odata.nextLink"];
    }
    return items.slice(0, maxItems);
  }

  // ── Recherche de contacts (annuaire + historique mail, dedup-mergé) ──

  private async searchUsersInDirectory(query: string): Promise<ScoredContact[]> {
    if (this.directoryUnavailable) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];

    const q = trimmed.replace(/"/g, "");
    const clauses = [`"displayName:${q}"`, `"givenName:${q}"`, `"surname:${q}"`, `"mail:${q}"`].join(" OR ");
    const select = "displayName,givenName,surname,mail,userPrincipalName,jobTitle,department";
    const url = `${GRAPH}/users?$search=${encodeURIComponent(clauses)}&$select=${select}&$top=25&$count=true`;

    try {
      const resp = await this.graphFetch<GraphPagedResponse<GraphUser>>(url, {
        headers: { ConsistencyLevel: "eventual" },
      });
      const out: ScoredContact[] = [];
      for (const u of resp.value) {
        const email = u.mail || u.userPrincipalName;
        if (!email) continue;
        const name = u.displayName || [u.givenName, u.surname].filter(Boolean).join(" ") || email;
        const fScore = fuzzyScore(trimmed, { name, email });
        if (fScore <= 0) continue;
        out.push({ name, email, source: "directory", jobTitle: u.jobTitle, department: u.department, score: fScore + 8 });
      }
      return out;
    } catch (err) {
      if (err instanceof GraphAuthError) throw err;
      const msg = (err as Error).message;
      if (/Authorization_RequestDenied|insufficient|consent/i.test(msg)) {
        console.warn(`[graph] Annuaire indisponible (scope User.ReadBasic.All manquant)`);
        this.directoryUnavailable = true;
        return [];
      }
      console.warn(`[graph] searchUsersInDirectory failed: ${msg}`);
      return [];
    }
  }

  private async searchContactsViaMailHistory(query: string): Promise<ScoredContact[]> {
    const encodedQuery = encodeURIComponent(query);
    const receivedUrl = `${GRAPH}/me/messages?$search="from:${encodedQuery}"&$select=from&$top=30`;
    const sentUrl = `${GRAPH}/me/mailFolders/sentitems/messages?$search="to:${encodedQuery}"&$select=toRecipients&$top=30`;

    // Les erreurs transitoires sont avalées (liste vide), mais un 401 doit
    // remonter : sinon l'agent répond « aucun contact » sur un token expiré.
    const swallowUnlessAuth = (err: unknown) => {
      if (err instanceof GraphAuthError) throw err;
      return { value: [] as EmailMessage[] };
    };
    const [received, sent] = await Promise.all([
      this.graphFetch<GraphPagedResponse<EmailMessage>>(receivedUrl).catch(swallowUnlessAuth),
      this.graphFetch<GraphPagedResponse<EmailMessage>>(sentUrl).catch(swallowUnlessAuth),
    ]);

    const seen = new Map<string, { name: string; email: string; count: number }>();
    for (const msg of received.value) {
      const a = msg.from?.emailAddress;
      if (a?.address) {
        const k = a.address.toLowerCase();
        const e = seen.get(k);
        if (e) e.count++;
        else seen.set(k, { name: a.name, email: a.address, count: 1 });
      }
    }
    for (const msg of sent.value) {
      for (const r of msg.toRecipients || []) {
        const a = r.emailAddress;
        if (a?.address) {
          const k = a.address.toLowerCase();
          const e = seen.get(k);
          if (e) e.count++;
          else seen.set(k, { name: a.name, email: a.address, count: 1 });
        }
      }
    }

    const out: ScoredContact[] = [];
    for (const c of seen.values()) {
      const fScore = fuzzyScore(query, c);
      if (fScore > 0) out.push({ name: c.name, email: c.email, source: "email", score: fScore, count: c.count });
    }
    return out;
  }

  async searchContactsByName(query: string): Promise<ContactHit[]> {
    const [directoryHits, mailHits] = await Promise.all([
      this.searchUsersInDirectory(query),
      this.searchContactsViaMailHistory(query),
    ]);

    // Merge : avoir réellement correspondu avec quelqu'un est un signal fort →
    // bonus historique (comme graphMailService), sinon les homonymes annuaire
    // enterrent les vrais contacts.
    const byEmail = new Map<string, ScoredContact>();
    for (const c of directoryHits) byEmail.set(c.email.toLowerCase(), { ...c });
    for (const c of mailHits) {
      const k = c.email.toLowerCase();
      const historyBonus = 25 + Math.min(c.count ?? 1, 10);
      const existing = byEmail.get(k);
      if (existing) {
        existing.score = Math.max(existing.score, c.score) + historyBonus;
        existing.source = "directory+email";
      } else {
        byEmail.set(k, { ...c, score: c.score + historyBonus });
      }
    }

    return Array.from(byEmail.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 25)
      .map(({ name, email, source, jobTitle, department }) => ({
        name, email, source,
        ...(jobTitle ? { jobTitle } : {}),
        ...(department ? { department } : {}),
      }));
  }

  // ── Emails échangés avec un contact ──────────────────────────────

  async searchEmailsFromSender(senderEmail: string, maxResults: number, dateRange?: DateRange, includeBodies = true): Promise<EmailMessage[]> {
    // Sans les corps, la requête est BEAUCOUP plus rapide (le mode liste n'en a
    // pas besoin ; seuls le tri sémantique et la lecture de contenu les exigent).
    const select = `id,subject,bodyPreview,${includeBodies ? "body," : ""}from,receivedDateTime,hasAttachments,webLink,conversationId`;
    const search = `from:${senderEmail}${kqlDateClause(dateRange, "received")}`;
    const url = `${GRAPH}/me/messages?$search="${encodeURIComponent(search)}"&$select=${select}&$top=50`;
    const fetchCap = dateRange ? Math.max(maxResults * 20, 600) : maxResults;
    const results = await this.fetchAllPages<EmailMessage>(url, fetchCap);
    const dated = dateRange ? filterByDate(results, "receivedDateTime", dateRange) : results;
    dated.sort((a, b) => new Date(b.receivedDateTime).getTime() - new Date(a.receivedDateTime).getTime());
    return dated.slice(0, maxResults);
  }

  async searchEmailsSentTo(recipientEmail: string, maxResults: number, dateRange?: DateRange, includeBodies = true): Promise<EmailMessage[]> {
    const select = `id,subject,bodyPreview,${includeBodies ? "body," : ""}toRecipients,sentDateTime,receivedDateTime,hasAttachments,webLink,conversationId`;
    const search = `to:${recipientEmail}${kqlDateClause(dateRange, "sent")}`;
    const url = `${GRAPH}/me/mailFolders/sentitems/messages?$search="${encodeURIComponent(search)}"&$select=${select}&$top=50`;
    const fetchCap = dateRange ? Math.max(maxResults * 20, 600) : maxResults;
    const results = await this.fetchAllPages<EmailMessage>(url, fetchCap);
    const dated = dateRange ? filterByDate(results, "sentDateTime", dateRange) : results;
    dated.sort((a, b) => new Date(b.sentDateTime || b.receivedDateTime).getTime() - new Date(a.sentDateTime || a.receivedDateTime).getTime());
    return dated.slice(0, maxResults);
  }

  async getAllInteractions(email: string, maxPerDirection: number, dateRange?: DateRange, includeBodies = true) {
    const [received, sent] = await Promise.all([
      this.searchEmailsFromSender(email, maxPerDirection, dateRange, includeBodies),
      this.searchEmailsSentTo(email, maxPerDirection, dateRange, includeBodies),
    ]);
    return { received, sent };
  }

  // ── Calendrier & disponibilités ──────────────────────────────────

  async getCalendarView(startDateTime: string, endDateTime: string, maxResults = 50): Promise<CalendarEvent[]> {
    const url = `${GRAPH}/me/calendarView?startDateTime=${startDateTime}&endDateTime=${endDateTime}&$select=id,subject,bodyPreview,start,end,attendees,isOrganizer,organizer,seriesMasterId&$orderby=start/dateTime desc&$top=50`;
    return this.fetchAllPagesWithHeaders<CalendarEvent>(url, maxResults, {
      Prefer: `outlook.timezone="${config.timezone}"`,
    });
  }

  /**
   * Free/busy via /me/calendar/getSchedule (Calendars.Read délégué suffit).
   * availabilityView : 0=libre, 1=tentatif, 2=occupé, 3=absent, 4=ailleurs.
   */
  async getSchedule(emails: string[], startTime: Date, endTime: Date, availabilityViewInterval = 30): Promise<ScheduleInformation[]> {
    const url = `${GRAPH}/me/calendar/getSchedule`;
    const response = await this.graphFetch<{ value: ScheduleInformation[] }>(url, {
      method: "POST",
      body: JSON.stringify({
        schedules: emails,
        startTime: { dateTime: startTime.toISOString(), timeZone: "UTC" },
        endTime: { dateTime: endTime.toISOString(), timeZone: "UTC" },
        availabilityViewInterval,
      }),
    });
    return response.value;
  }

  private async fetchAllPagesWithHeaders<T>(url: string, maxItems: number, headers: Record<string, string>): Promise<T[]> {
    const items: T[] = [];
    let nextUrl: string | undefined = url;
    while (nextUrl && items.length < maxItems) {
      const page: GraphPagedResponse<T> = await this.graphFetch<GraphPagedResponse<T>>(nextUrl, { headers });
      items.push(...page.value);
      nextUrl = page["@odata.nextLink"];
    }
    return items.slice(0, maxItems);
  }

  // ── Pièces jointes & identité ────────────────────────────────────

  async getMessageAttachments(messageId: string): Promise<GraphAttachment[]> {
    const url = `${GRAPH}/me/messages/${messageId}/attachments`;
    const resp = await this.graphFetch<GraphPagedResponse<GraphAttachment>>(url);
    return resp.value;
  }

  /** Un email complet (corps inclus) par ID. */
  async getEmail(messageId: string): Promise<EmailMessage> {
    const url = `${GRAPH}/me/messages/${encodeURIComponent(messageId)}?$select=id,subject,body,bodyPreview,from,toRecipients,receivedDateTime,sentDateTime,hasAttachments,webLink`;
    return this.graphFetch<EmailMessage>(url);
  }

  private meEmail: string | null = null;

  /** Adresse du user connecté (équivalent serveur de getAccount().username). */
  async getMyEmail(): Promise<string | null> {
    if (this.meEmail) return this.meEmail;
    try {
      const me = await this.graphFetch<{ mail?: string; userPrincipalName?: string }>(`${GRAPH}/me?$select=mail,userPrincipalName`);
      this.meEmail = me.mail || me.userPrincipalName || null;
      return this.meEmail;
    } catch (err) {
      if (err instanceof GraphAuthError) throw err;
      return null;
    }
  }

  // ── ServiceDesk : recherche de contacts dans les tickets ─────────

  /**
   * Cherche des PERSONNES dans les emails ServiceDesk — port de
   * graphMailService.searchContactsInServiceDesk. Extrait les noms des corps
   * de tickets par fenêtre glissante + fuzzy match.
   */
  async searchContactsInServiceDesk(query: string): Promise<Array<{ name: string; ticketCount: number }>> {
    const encodedQuery = encodeURIComponent(query);
    const url = `${GRAPH}/me/messages?$search="from:${SERVICEDESK_EMAIL} ${encodedQuery}"&$select=id,subject,body,bodyPreview&$top=20`;

    let messages: EmailMessage[];
    try {
      messages = await this.fetchAllPages<EmailMessage>(url, 20);
    } catch (err) {
      if (err instanceof GraphAuthError) throw err;
      console.warn(`[graph] ServiceDesk contact search failed: ${(err as Error).message}`);
      return [];
    }

    const nameCounts = new Map<string, number>();
    for (const msg of messages) {
      const bodyText = msg.body?.content ? stripHtml(msg.body.content) : msg.bodyPreview || "";
      for (const name of extractNamesFromBody(bodyText, query)) {
        nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
      }
    }

    return Array.from(nameCounts.entries())
      .map(([name, ticketCount]) => ({ name, ticketCount }))
      .sort((a, b) => b.ticketCount - a.ticketCount)
      .slice(0, 5);
  }

  /**
   * Emails du ServiceDesk (1234@epfl.ch) qui MENTIONNENT une personne — port de
   * graphMailService.getServiceDeskEmailsForPerson. Une partie des échanges
   * avec quelqu'un passe par ServiceNow : l'expéditeur est le ServiceDesk, la
   * personne n'apparaît que dans le corps du ticket.
   */
  async getServiceDeskEmailsForPerson(personName: string, maxResults = 30, dateRange?: DateRange): Promise<EmailMessage[]> {
    const nameWords = personName.trim().split(/\s+/);
    if (nameWords.length === 0 || !nameWords[0]) return [];
    // Le corps est nécessaire ici : la vérification du nom se fait dedans.
    const select = "id,subject,body,bodyPreview,from,receivedDateTime,hasAttachments,webLink,conversationId";
    const search = `from:${SERVICEDESK_EMAIL} ${nameWords.join(" ")}${kqlDateClause(dateRange, "received")}`;
    const url = `${GRAPH}/me/messages?$search="${encodeURIComponent(search)}"&$select=${select}&$top=50`;

    try {
      const fetchCap = dateRange ? Math.max(maxResults * 20, 600) : maxResults;
      let allMessages = await this.fetchAllPages<EmailMessage>(url, fetchCap);
      if (dateRange) {
        allMessages = filterByDate(allMessages, "receivedDateTime", dateRange);
      }
      // Post-filtre : $search sans guillemets fait des matchs lâches — on
      // vérifie que TOUS les mots du nom apparaissent bien dans le corps.
      const filtered = allMessages.filter((msg) => {
        const bodyText = msg.body?.content
          ? stripHtml(msg.body.content).toLowerCase()
          : (msg.bodyPreview || "").toLowerCase();
        return nameWords.every((w) => bodyText.includes(w.toLowerCase()));
      });
      console.log(`[graph] ServiceDesk("${personName}"): ${allMessages.length} bruts, ${filtered.length} vérifiés`);
      return filtered.slice(0, maxResults);
    } catch (err) {
      if (err instanceof GraphAuthError) throw err;
      console.warn(`[graph] getServiceDeskEmailsForPerson failed: ${(err as Error).message}`);
      return [];
    }
  }

  // ── Recherche plein-texte ────────────────────────────────────────

  async searchEmails(query: string, maxResults = 20, dateRange?: DateRange, sender?: string): Promise<EmailMessage[]> {
    const select = "id,subject,bodyPreview,body,from,toRecipients,receivedDateTime,conversationId,hasAttachments";

    if (dateRange) {
      // $search + $filter incompatibles sur messages → $filter date + filtre texte client
      const dateFilter = buildDateFilter(dateRange);
      const url = `${GRAPH}/me/messages?$filter=${encodeURI(dateFilter)}&$orderby=receivedDateTime desc&$select=${select}&$top=50`;
      const results = await this.fetchAllPages<EmailMessage>(url, 1000);
      const lower = query.toLowerCase();
      const senderLower = sender?.toLowerCase();
      return results
        .filter((e) => {
          const textMatch = !lower ||
            e.subject?.toLowerCase().includes(lower) ||
            e.bodyPreview?.toLowerCase().includes(lower) ||
            e.body?.content?.toLowerCase().includes(lower) ||
            e.from?.emailAddress?.name?.toLowerCase().includes(lower) ||
            e.from?.emailAddress?.address?.toLowerCase().includes(lower);
          const senderMatch = !senderLower ||
            e.from?.emailAddress?.name?.toLowerCase().includes(senderLower) ||
            e.from?.emailAddress?.address?.toLowerCase().includes(senderLower);
          return textMatch && senderMatch;
        })
        .slice(0, maxResults);
    }

    const fromClause = sender ? `from:${/\s/.test(sender) ? `"${sender}"` : sender} ` : "";
    const kql = `${fromClause}${query}`.trim();
    const url = `${GRAPH}/me/messages?$search="${encodeURIComponent(kql)}"&$select=${select}&$top=50`;
    return this.fetchAllPages<EmailMessage>(url, maxResults);
  }
}
