// ─── Skill Registry ────────────────────────────────────────────────
// Skills are .md files in assets/skills/, served as static files.
// The registry maps skill IDs to metadata; content is fetched at runtime.

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  file: string; // filename in assets/skills/
}

export const SKILL_CATALOG: SkillMeta[] = [
  {
    id: "show_emails",
    name: "Afficher les emails d'un contact",
    description:
      "Quand l'utilisateur veut VOIR, MONTRER ou AFFICHER ses emails avec quelqu'un",
    file: "show-emails.md",
  },
  {
    id: "summarize_emails",
    name: "Résumer les échanges avec un contact",
    description:
      "Quand l'utilisateur veut un RÉSUMÉ de ses échanges email avec quelqu'un",
    file: "summarize-emails.md",
  },
  {
    id: "calendar_overview",
    name: "Consulter le calendrier",
    description:
      "Quand l'utilisateur veut voir ses événements/réunions à venir",
    file: "calendar-overview.md",
  },
  {
    id: "meeting_prep",
    name: "Préparer une réunion",
    description:
      "Quand l'utilisateur veut PRÉPARER une réunion, obtenir un BRIEFING, ou se renseigner avant un rendez-vous",
    file: "meeting-prep.md",
  },
];

export function getSkillCatalogForPrompt(): string {
  return SKILL_CATALOG.map((s) => `- ${s.id}: ${s.description}`).join("\n");
}

export function getSkillIds(): string[] {
  return SKILL_CATALOG.map((s) => s.id);
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
