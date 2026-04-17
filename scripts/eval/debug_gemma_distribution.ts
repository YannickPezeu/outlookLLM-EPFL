import "./node_shims";
import { cleanEmailBody } from "../../src/services/cleanEmailBody";
const Database = require("better-sqlite3");
const db = new Database("data/mock-mailbox-large.sqlite", { readonly: true });

const rcpUrl = process.env.RCP_API_ENDPOINT || "https://inference.rcp.epfl.ch/v1";
const rcpKey = process.env.RCP_API_KEY!;
const model = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : "google/gemma-4-E2B-it-bfloat16";

const eventIdArg = process.argv.includes("--event") ? process.argv[process.argv.indexOf("--event") + 1] : null;
const eventId = eventIdArg || db.prepare("SELECT DISTINCT event_id FROM email_event_scores LIMIT 1").get().event_id;
const eventInfo = db.prepare("SELECT subject, body_preview, start_date_time, attendees_json FROM calendar_events WHERE id = ?").get(eventId) as any;
const getProj = db.prepare("SELECT pp.project_id FROM calendar_events ce, json_each(ce.attendees_json) je, project_participants pp WHERE json_extract(je.value, '$.emailAddress.address') = pp.participant_email AND ce.id = ? GROUP BY pp.project_id ORDER BY COUNT(*) DESC LIMIT 1");
const eventProjectId = (getProj.get(eventId) as any)?.project_id;

const attendees = JSON.parse(eventInfo.attendees_json || "[]");
const participants = attendees.map((a: any) => a.emailAddress?.name || "").filter(Boolean).join(", ");

const rows = db.prepare(`
  SELECT ees.email_id, ees.embedding_score, m.subject, m.body_content, m.body_preview,
         m.project_id, COALESCE(m.relevance_score, 0) as relevance, m.from_name
  FROM email_event_scores ees JOIN messages m ON m.id = ees.email_id
  WHERE ees.event_id = ? AND m.received_date_time < ?
  ORDER BY ees.embedding_score DESC LIMIT 200
`).all(eventId, eventInfo.start_date_time) as any[];

const SYSTEM_PROMPT = `Bonjour, je te demande ton aide d'expert pour filtrer des emails avant une réunion.

CONTEXTE : Les participants à cette réunion travaillent sur PLUSIEURS projets différents. Tu vas recevoir des emails échangés avec ces participants — certains concernent DIRECTEMENT la réunion, d'autres concernent leurs AUTRES projets et ne sont PAS pertinents.

CRITÈRE PRINCIPAL : L'email parle-t-il SPÉCIFIQUEMENT du sujet de cette réunion ? Un email sur un autre sujet, même envoyé par un participant, doit recevoir un score bas.

Échelle :
- 9-10 : Indispensable. Directement lié au sujet de la réunion. Décisions, résultats, problèmes critiques.
- 7-8 : Très utile. Avancées concrètes sur le sujet de la réunion.
- 5-6 : Lien indirect. Mentionne le sujet mais surtout de la logistique.
- 3-4 : Autre sujet mais même participants. Réunion différente, projet différent.
- 1-2 : Sans rapport avec la réunion. Autre projet des mêmes personnes.
- 0 : Spam ou totalement hors sujet.

EXEMPLES pour une réunion "Expansion GPU Cluster" :
- Score 9 : "Les H100 arrivent le 15 mars. Budget approuvé à 1.2M CHF." → directement le sujet
- Score 7 : "Point avancement installation des racks dans BC 410" → avancée concrète
- Score 3 : "Disponibilité GPUs pour notre projet de robotique" → autre projet, même infra
- Score 2 : "Redesign du site web de la faculté — réunion mardi" → complètement autre sujet
- Score 1 : "Résultats du sondage bien-être étudiant" → rien à voir

IMPORTANT : Ne te laisse pas tromper par le fait qu'un email mentionne des mots-clés similaires (GPU, cluster, budget). Si c'est pour UN AUTRE PROJET que celui de la réunion, score 2-4 maximum.

Réponds UNIQUEMENT en JSON : [{"index":0,"score":7},{"index":1,"score":3}, ...]`;

async function callLLM(prompt: string): Promise<string> {
  const resp = await fetch(`${rcpUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${rcpKey}` },
    body: JSON.stringify({ model, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }], temperature: 0.1, max_tokens: 4096 }),
  });
  const json = await resp.json() as any;
  return json.choices?.[0]?.message?.content || "";
}

(async () => {
  console.log(`Event: ${eventInfo.subject} | Project: ${eventProjectId}\n`);

  const gemmaScores = new Map<string, number>();

  for (let i = 0; i < rows.length; i += 30) {
    const batch = rows.slice(i, i + 30);
    const emailsStr = batch.map((e: any, idx: number) => {
      const clean = e.body_content ? cleanEmailBody(e.body_content) : e.body_preview;
      return `[${idx}] Sujet: ${e.subject}\n${clean}`;
    }).join("\n\n---\n\n");

    const prompt = `## Réunion\nSujet : ${eventInfo.subject}\nParticipants : ${participants}\n\n## Emails à noter\n\n${emailsStr}\n\nNote chaque email de 0 à 10.`;
    try {
      const text = await callLLM(prompt);
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const arr = JSON.parse(match[0]) as Array<{ index: number; score: number }>;
        for (const s of arr) {
          if (typeof s.index === "number" && s.index >= 0 && s.index < batch.length)
            gemmaScores.set(batch[s.index].email_id, s.score);
        }
      }
    } catch (err) {
      console.log(`  Batch ${Math.floor(i / 30) + 1} PARSE ERROR, skipping`);
    }
    console.log(`  Batch ${Math.floor(i / 30) + 1}/${Math.ceil(rows.length / 30)}: ${gemmaScores.size} scored`);
  }

  // Distribution of Gemma scores
  const hist = new Map<number, number>();
  for (const s of gemmaScores.values()) hist.set(s, (hist.get(s) || 0) + 1);
  console.log("\nGemma score distribution:");
  for (let i = 0; i <= 10; i++) console.log(`  ${i}: ${(hist.get(i) || 0).toString().padStart(4)}`);

  // Breakdown by category
  const cats = { thisProjectHigh: 0, thisProjectMed: 0, thisProjectLow: 0, otherProject: 0, noise: 0 };
  const gemmaByCategory = {
    thisProjectHigh: [] as number[],
    thisProjectMed: [] as number[],
    thisProjectLow: [] as number[],
    otherProject: [] as number[],
    noise: [] as number[],
  };

  for (const r of rows) {
    const gs = gemmaScores.get(r.email_id);
    if (gs === undefined) continue;
    if (!r.project_id) { cats.noise++; gemmaByCategory.noise.push(gs); }
    else if (r.project_id === eventProjectId) {
      if (r.relevance >= 7) { cats.thisProjectHigh++; gemmaByCategory.thisProjectHigh.push(gs); }
      else if (r.relevance >= 5) { cats.thisProjectMed++; gemmaByCategory.thisProjectMed.push(gs); }
      else { cats.thisProjectLow++; gemmaByCategory.thisProjectLow.push(gs); }
    } else { cats.otherProject++; gemmaByCategory.otherProject.push(gs); }
  }

  const avg = (a: number[]) => a.length > 0 ? (a.reduce((s, v) => s + v, 0) / a.length).toFixed(1) : "n/a";
  const dist = (a: number[]) => {
    const h = new Map<number, number>();
    for (const v of a) h.set(v, (h.get(v) || 0) + 1);
    return Array.from(h.entries()).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(" ");
  };

  console.log("\nGemma scores by email category:");
  console.log(`  This project (GT>=7):  n=${cats.thisProjectHigh}  avg=${avg(gemmaByCategory.thisProjectHigh)}  dist: ${dist(gemmaByCategory.thisProjectHigh)}`);
  console.log(`  This project (GT 5-6): n=${cats.thisProjectMed}   avg=${avg(gemmaByCategory.thisProjectMed)}  dist: ${dist(gemmaByCategory.thisProjectMed)}`);
  console.log(`  This project (GT<5):   n=${cats.thisProjectLow}   avg=${avg(gemmaByCategory.thisProjectLow)}  dist: ${dist(gemmaByCategory.thisProjectLow)}`);
  console.log(`  Other projects:        n=${cats.otherProject}  avg=${avg(gemmaByCategory.otherProject)}  dist: ${dist(gemmaByCategory.otherProject)}`);
  console.log(`  Noise:                 n=${cats.noise}   avg=${avg(gemmaByCategory.noise)}  dist: ${dist(gemmaByCategory.noise)}`);

  db.close();
})();
