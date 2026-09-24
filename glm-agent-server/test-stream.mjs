// Débogage : includePartialMessages émet-il des stream_event ?
import { query } from "@anthropic-ai/claude-agent-sdk";

// Jamais de clé en dur : ce fichier est versionné.
if (!process.env.RCP_API_KEY) throw new Error("RCP_API_KEY manquante");

const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith("ANTHROPIC_")) delete env[k];
Object.assign(env, {
  ANTHROPIC_BASE_URL: "http://127.0.0.1:8791",
  ANTHROPIC_AUTH_TOKEN: process.env.RCP_API_KEY,
  ANTHROPIC_MODEL: "zai-org/GLM-5.3-Flash",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
});

for await (const m of query({
  prompt: "Compte de 1 à 3 en toutes lettres.",
  options: {
    model: "zai-org/GLM-5.3-Flash",
    systemPrompt: "Tu réponds en français.",
    maxTurns: 2,
    env,
    settingSources: [],
    includePartialMessages: true,
  },
})) {
  if (m.type === "stream_event") {
    console.log("STREAM:", JSON.stringify(m.event).slice(0, 300));
  } else {
    console.log("MSG:", m.type);
  }
}
