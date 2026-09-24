/**
 * Skills — port serveur de src/skills/skillRegistry.ts.
 *
 * Les fichiers markdown sont lus depuis assets/skills/ du repo parent (même
 * source de vérité que l'add-in, pas de duplication).
 *
 * Catalogue RESTREINT aux skills dont tous les tools existent côté Ultra :
 * - show_emails, calendar_overview, schedule_meeting → compatibles
 * - summarize_emails / sujet_dossier / meeting_briefing / email_courant →
 *   exclus : ils reposent sur les pipelines LLM dédiés (summarize_exchanges,
 *   extract_topic_decisions, prepare_meeting, summarize_current_email) que le
 *   harness couvre nativement (l'agent synthétise lui-même) ou qui nécessitent
 *   le contexte Office.js du frontend.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// glm-agent-server/src → repo racine → assets/skills
const SKILLS_DIR = path.resolve(__dirname, "..", "..", "assets", "skills");

interface SkillMeta {
  id: string;
  description: string;
  file: string;
}

const SKILL_CATALOG: SkillMeta[] = [
  {
    id: "show_emails",
    description:
      "Quand l'utilisateur veut VOIR, MONTRER, AFFICHER ou TROUVER des emails — soit avec un contact, soit par sujet/mot-clé dans toute sa boîte (ex: 'trouve mes mails qui parlent de docling', 'le mail avec l'endpoint RCP')",
    file: "show-emails.md",
  },
  {
    id: "calendar_overview",
    description: "Quand l'utilisateur veut voir ses événements/réunions à venir",
    file: "calendar-overview.md",
  },
  {
    id: "schedule_meeting",
    description:
      "Quand l'utilisateur veut ORGANISER / PLANIFIER une réunion, ou TROUVER UN CRÉNEAU / une PLAGE / DISPONIBILITÉ commune à plusieurs personnes (croiser les agendas via leur free/busy)",
    file: "schedule-meeting.md",
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
  const content = await readFile(path.join(SKILLS_DIR, skill.file), "utf8");
  // Les skills mentionnent parfois des tools non portés côté Ultra — on prévient
  // le modèle plutôt que de le laisser appeler un tool inexistant.
  return (
    content +
    "\n\n---\nNOTE (mode Ultra) : les outils summarize_email_interactions, summarize_exchanges, " +
    "prepare_meeting et les outils *_topic_* n'existent pas ici. Si le skill y fait référence, " +
    "fais le travail équivalent toi-même avec get_email_interactions / search_emails puis ta propre synthèse."
  );
}
