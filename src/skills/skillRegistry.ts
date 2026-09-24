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
  // Hidden skills are NOT advertised in the catalog the agent uses for automatic
  // routing — it will never pick them on its own. They remain loadable only when
  // the user explicitly names the skill (the id stays in load_skill's enum).
  hidden?: boolean;
}

export const SKILL_CATALOG: SkillMeta[] = [
  {
    id: "show_emails",
    name: "Afficher / rechercher des emails",
    description:
      "Quand l'utilisateur veut VOIR, MONTRER, AFFICHER ou TROUVER des emails — soit avec un contact, soit par sujet/mot-clé dans toute sa boîte (ex: 'trouve mes mails qui parlent de docling', 'le mail avec l'endpoint RCP')",
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
      "Quand l'utilisateur veut un RÉSUMÉ de ses échanges email avec quelqu'un, ou FAIRE LE POINT / " +
      "résumer LA SITUATION vis-à-vis d'une PERSONNE (ou de plusieurs personnes nommées) — ex: " +
      "'résume la situation avec Sandrine', 'fais le point sur mes échanges avec X et Y'. " +
      "Pour un SUJET/dossier/projet (pas une personne nommée) → sujet_dossier.",
    file: "summarize-emails.md",
    tools: [
      "summarize_exchanges",
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
    name: "Cartographier / faire le point / relevé des décisions sur un sujet",
    description:
      "Quand l'utilisateur veut, à propos d'un SUJET/DOSSIER/PROJET (thème, pas une personne) : " +
      "le RELEVÉ DES DÉCISIONS prises et/ou OÙ EN EST le dossier (rapport Word vérifiable + synthèse), " +
      "OU savoir QUI est impliqué. Si la demande nomme une PERSONNE (« la situation avec Sandrine ») → " +
      "summarize_emails à la place.",
    file: "sujet-dossier.md",
    tools: [
      "count_topic_emails",
      "extract_topic_decisions",
      "identify_topic_participants",
      "search_contacts_in_servicedesk",
    ],
  },
  {
    id: "secret_skill_for_dev",
    name: "[DEV] Rapport Word des décisions sur un sujet",
    description:
      "[DEV/TEST] Quand l'utilisateur veut un RELEVÉ EXHAUSTIF ET VÉRIFIABLE des DÉCISIONS prises sur un " +
      "sujet/dossier, sous forme de RAPPORT WORD avec un lien cliquable vers chaque email source " +
      "(ex: « toutes les décisions prises sur Apertus », demande DPO/audit). Couvre potentiellement des centaines d'emails.",
    file: "secret_skill_for_dev.md",
    tools: ["count_topic_emails", "extract_topic_decisions"],
    // Caché du routage automatique : ne se charge que si l'utilisateur demande
    // explicitement « le skill secret dev » (id présent dans l'enum de load_skill).
    hidden: true,
  },
];

export function getSkillCatalogForPrompt(): string {
  // Hidden skills are excluded so the agent never routes to them automatically.
  return SKILL_CATALOG.filter((s) => !s.hidden)
    .map((s) => `- ${s.id}: ${s.description}`)
    .join("\n");
}

export function getSkillIds(): string[] {
  // All ids stay in load_skill's enum (incl. hidden) so a user can load a hidden
  // skill by naming it explicitly — it just isn't advertised in the catalog.
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
  let content = await resp.text();

  // Inject the user's runtime scheduling preference (the .md is a static asset and
  // can't read it). Resolves include_self when the request has no explicit signal.
  if (skillId === "schedule_meeting") {
    const { getMeetingSelfDefault } = await import("../services/rcpApiService");
    const pref = getMeetingSelfDefault();
    let prefSection: string;
    if (pref === "include") {
      prefSection =
        "L'utilisateur a configuré qu'il **participe PAR DÉFAUT** aux réunions qu'il organise. " +
        "En l'absence de signal explicite (« avec moi » / « sans moi ») dans la demande, utilise " +
        "`include_self=true` **sans poser de question**, et mentionne brièvement l'hypothèse dans ta " +
        "réponse (ex: « en te comptant dans la réunion… »).";
    } else if (pref === "exclude") {
      prefSection =
        "L'utilisateur a configuré qu'il **ne participe PAS par défaut** aux réunions qu'il organise " +
        "(il planifie généralement pour d'autres). En l'absence de signal explicite (« avec moi » / " +
        "« sans moi ») dans la demande, utilise `include_self=false` **sans poser de question**, et " +
        "mentionne brièvement l'hypothèse dans ta réponse (ex: « sans te compter dans la réunion… »).";
    } else {
      prefSection =
        "L'utilisateur **n'a PAS configuré** sa participation par défaut. En l'absence de signal " +
        "explicite (« avec moi » / « sans moi ») dans la demande, tu DOIS lui **demander s'il fait " +
        "partie de la réunion** avant d'appeler `find_common_slots`. Indique-lui aussi qu'il peut " +
        "régler ce défaut dans l'onglet **Config** pour ne plus avoir à répondre à chaque fois.";
    }
    content +=
      "\n\n## Préférence de participation (réglages utilisateur)\n" +
      "RAPPEL DE PRIORITÉ : un signal explicite dans la demande (« avec moi », « sans moi », " +
      "« quand est libre X ? ») l'emporte TOUJOURS sur le défaut ci-dessous.\n" +
      prefSection;
  }

  return content;
}
