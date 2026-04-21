import { AgentMessage } from "../../../src/services/rcpApiService";

export interface ToolCallScenario {
  name: string;
  description?: string;
  history: AgentMessage[];
  nextUserMessage: string;
  expected: {
    tool: string | null;
    argsCheck?: (args: Record<string, unknown>) => boolean;
  };
}

function calendarEventsResult(events: Array<{ id?: string; subject: string; startLocal: string; endLocal: string }>): string {
  return JSON.stringify({
    events: events.map((e, i) => ({
      id: e.id ?? `evt_${i}`,
      subject: e.subject,
      start: e.startLocal,
      end: e.endLocal,
      startLocal: e.startLocal,
      endLocal: e.endLocal,
      attendees: [],
      isOrganizer: false,
    })),
    count: events.length,
  });
}

// Tool result simulant un appel PARTIEL du calendrier (seulement la prochaine réunion ou les 2 bordures
// visibles) — Prep prez Add-in Outlook existe dans le vrai calendrier mais n'est PAS dans ce résultat.
// Ainsi, pour répondre correctement à une question sur un intervalle ou "la suivante", le modèle
// doit rappeler get_calendar_events (sinon il répondrait factuellement faux depuis le contexte).
const APERTUS_ONLY = calendarEventsResult([
  { subject: "Apertus Brownbag", startLocal: "mardi 21 avril 2026 à 12:10 (Europe/Zurich)", endLocal: "mardi 21 avril 2026 à 12:55 (Europe/Zurich)" },
]);

const APERTUS_AND_DEMO = calendarEventsResult([
  { subject: "Apertus Brownbag", startLocal: "mardi 21 avril 2026 à 12:10 (Europe/Zurich)", endLocal: "mardi 21 avril 2026 à 12:55 (Europe/Zurich)" },
  { subject: "Démo assistant GenAI pour adjoints VPs", startLocal: "mardi 21 avril 2026 à 15:00 (Europe/Zurich)", endLocal: "mardi 21 avril 2026 à 15:30 (Europe/Zurich)" },
]);

export const SCENARIOS: ToolCallScenario[] = [
  {
    name: "first_meeting_fresh",
    description: "Cold start: aucune histoire, question calendrier → doit appeler get_calendar_events.",
    history: [],
    nextUserMessage: "quelle est ma prochaine réunion ?",
    expected: { tool: "get_calendar_events" },
  },

  {
    name: "followup_la_suivante",
    description: "Après un premier tool call et une réponse, puis un refus, 'la suivante ?' doit RAPPELER l'outil (cas empiriquement raté par Gemma 4 26B).",
    history: [
      { role: "user", content: "quelle est ma prochaine réunion ?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_aaaaaaaaa", type: "function", function: { name: "get_calendar_events", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_aaaaaaaaa", content: APERTUS_ONLY },
      { role: "assistant", content: "Ta prochaine réunion est Apertus Brownbag, aujourd'hui de 12:10 à 12:55." },
      { role: "user", content: "j'y vais pas" },
      { role: "assistant", content: "D'accord, c'est noté." },
    ],
    nextUserMessage: "j'ai quand la suivante ?",
    expected: { tool: "get_calendar_events" },
  },

  {
    name: "followup_entre_les_deux",
    description: "Après avoir obtenu deux réunions, 'j'ai rien entre les 2 ?' doit déclencher un NOUVEAU tool call pour vérifier l'intervalle.",
    history: [
      { role: "user", content: "quelle est ma prochaine réunion ?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_bbbbbbbbb", type: "function", function: { name: "get_calendar_events", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_bbbbbbbbb", content: APERTUS_AND_DEMO },
      { role: "assistant", content: "Apertus Brownbag (12:10-12:55) puis Démo assistant GenAI (15:00-15:30)." },
    ],
    nextUserMessage: "j'ai rien entre les 2 ?",
    expected: { tool: "get_calendar_events" },
  },

  {
    name: "verify_suggestion",
    description: "Après une affirmation, 'vérifie stp' doit provoquer un re-tool-call.",
    history: [
      { role: "user", content: "j'ai quoi entre 13h et 15h ?" },
      { role: "assistant", content: "Tu n'as rien entre 13h et 15h." },
    ],
    nextUserMessage: "vérifie stp",
    expected: { tool: "get_calendar_events" },
  },

  {
    name: "liste_journee",
    description: "Lister toutes les réunions de la journée → get_calendar_events.",
    history: [],
    nextUserMessage: "liste toutes mes réunions de la journée stp",
    expected: { tool: "get_calendar_events" },
  },

  {
    name: "no_tool_acknowledgment",
    description: "Acquittement simple après une réponse calendrier → PAS de tool call.",
    history: [
      { role: "user", content: "ma prochaine réunion ?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_ccccccccc", type: "function", function: { name: "get_calendar_events", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_ccccccccc", content: APERTUS_ONLY },
      { role: "assistant", content: "Apertus Brownbag à 12:10." },
    ],
    nextUserMessage: "j'y vais pas",
    expected: { tool: null },
  },

  {
    name: "no_tool_thanks",
    description: "Remerciement simple → pas de tool call.",
    history: [
      { role: "user", content: "ma prochaine réunion ?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_ddddddddd", type: "function", function: { name: "get_calendar_events", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_ddddddddd", content: APERTUS_ONLY },
      { role: "assistant", content: "Apertus Brownbag à 12:10." },
    ],
    nextUserMessage: "merci !",
    expected: { tool: null },
  },

  {
    name: "contact_lookup",
    description: "Question sur un contact nommé → search_contacts.",
    history: [],
    nextUserMessage: "tu peux me retrouver l'adresse email de Pascal Bangerter ?",
    expected: { tool: "search_contacts" },
  },

  {
    name: "theme_question",
    description: "Question « qui travaille sur X ? » → identify_topic_participants.",
    history: [],
    nextUserMessage: "qui travaille sur l'IA à l'EPFL ?",
    expected: { tool: "identify_topic_participants" },
  },

  {
    name: "project_status",
    description: "Question « où on en est de X ? » → summarize_topic_status.",
    history: [],
    nextUserMessage: "tu peux me dire où on en est du recrutement pour mon binôme ?",
    expected: { tool: "summarize_topic_status" },
  },

  {
    name: "period_meetings",
    description: "Réunions d'une période explicite → get_calendar_events avec start_date/end_date.",
    history: [],
    nextUserMessage: "mes réunions de la semaine prochaine stp",
    expected: {
      tool: "get_calendar_events",
      argsCheck: (args) => typeof args.start_date === "string" && typeof args.end_date === "string",
    },
  },
];
