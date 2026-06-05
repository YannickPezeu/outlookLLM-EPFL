// ─── Skill Registry ────────────────────────────────────────────────
// Skills are .md files in assets/skills/, served as static files.
// The registry maps skill IDs to metadata; content is fetched at runtime.

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  file: string; // filename in assets/skills/
  // Tools unlocked when this skill is loaded (progressive tool disclosure).
  tools: string[];
}

export const SKILL_CATALOG: SkillMeta[] = [
  {
    id: "show_emails",
    name: "Afficher les emails d'un contact",
    description:
      "Quand l'utilisateur veut VOIR, MONTRER ou AFFICHER ses emails avec quelqu'un",
    file: "show-emails.md",
    tools: [
      "get_email_interactions",
      "display_emails",
      "search_contacts_in_servicedesk",
      "search_emails",
    ],
  },
  {
    id: "summarize_emails",
    name: "Résumer les échanges avec un contact",
    description:
      "Quand l'utilisateur veut un RÉSUMÉ de ses échanges email avec quelqu'un",
    file: "summarize-emails.md",
    tools: [
      "summarize_email_interactions",
      "read_email_attachments",
      "search_contacts_in_servicedesk",
    ],
  },
  {
    id: "calendar_overview",
    name: "Consulter le calendrier",
    description:
      "Quand l'utilisateur veut voir ses événements/réunions à venir",
    file: "calendar-overview.md",
    tools: ["get_calendar_events"],
  },
  {
    id: "meeting_briefing",
    name: "Construire un briefing pour une réunion",
    description:
      "Quand l'utilisateur veut un BRIEFING / une SYNTHÈSE pour SE PRÉPARER à un rendez-vous EXISTANT (analyse des échanges email avec les participants). PAS pour organiser/trouver une date.",
    file: "meeting-prep.md",
    tools: ["get_calendar_events", "prepare_meeting"],
  },
  {
    id: "schedule_meeting",
    name: "Organiser une réunion / trouver un créneau",
    description:
      "Quand l'utilisateur veut ORGANISER / PLANIFIER une réunion, ou TROUVER UN CRÉNEAU / une PLAGE / DISPONIBILITÉ commune à plusieurs personnes (croiser les agendas via leur free/busy)",
    file: "schedule-meeting.md",
    tools: ["find_common_slots", "get_calendar_events"],
  },
  {
    id: "email_courant",
    name: "Résumer l'email ouvert",
    description:
      "Quand l'utilisateur veut RÉSUMER / analyser / expliquer l'email actuellement ouvert (corps + pièces jointes)",
    file: "email-courant.md",
    tools: ["summarize_current_email"],
  },
  {
    id: "sujet_dossier",
    name: "Cartographier / faire le point sur un sujet",
    description:
      "Quand l'utilisateur veut savoir QUI est impliqué sur un sujet, ou OÙ EN EST un dossier/projet",
    file: "sujet-dossier.md",
    tools: [
      "identify_topic_participants",
      "summarize_topic_status",
      "search_contacts_in_servicedesk",
    ],
  },
];

export function getSkillCatalogForPrompt(): string {
  return SKILL_CATALOG.map((s) => `- ${s.id}: ${s.description}`).join("\n");
}

export function getSkillIds(): string[] {
  return SKILL_CATALOG.map((s) => s.id);
}

/** Tools unlocked by a skill (progressive disclosure). [] if unknown. */
export function getSkillTools(skillId: string): string[] {
  return SKILL_CATALOG.find((s) => s.id === skillId)?.tools ?? [];
}

export async function loadSkillContent(skillId: string): Promise<string> {
  const skill = SKILL_CATALOG.find((s) => s.id === skillId);
  if (!skill) {
    throw new Error(`Skill inconnu: ${skillId}. Disponibles: ${getSkillIds().join(", ")}`);
  }

  // Build base path from current page URL (works for all deployment environments)
  const pagePath = window.location.pathname;
  const basePath = pagePath.substring(0, pagePath.lastIndexOf("/") + 1);

  const resp = await fetch(`${basePath}assets/skills/${skill.file}`);
  if (!resp.ok) {
    throw new Error(`Impossible de charger le skill ${skillId}: HTTP ${resp.status}`);
  }
  return resp.text();
}
