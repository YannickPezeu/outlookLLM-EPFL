// Test de fumée du serveur Node, contre RCP, DANS l'image construite.
// Lancé par run-smoke.ps1 : le serveur tourne dans le même conteneur.
//  1. il démarre et annonce le bon modèle ;
//  2. son proxy RCP traduit l'en-tête de réflexion coupée en
//     `reasoning_effort: low` (harness Claude Code) — sans bloc de réflexion.
// Garder l'en-tête aligné sur REASONING_HEADER (src/agent.ts).
const REASONING_HEADER = "x-agent-reasoning-effort";
const key = process.env.RCP_API_KEY;

async function waitHealth(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch("http://127.0.0.1:8790/health");
      if (r.ok) return r.json();
    } catch {}
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("le serveur ne répond pas sur /health");
}

const cases = [
  ["démarrage, modèle annoncé", async () => {
    const h = await waitHealth();
    if (!/GLM-5\.3-Flash/.test(h.model)) throw new Error(`modèle inattendu : ${h.model}`);
  }],
  // `low` RÉDUIT la réflexion, il ne la supprime pas toujours : RCP renvoie
  // parfois un bloc de 3 caractères (4 à 10 jetons de sortie en tout, contre
  // ~45 sans l'en-tête — mesuré le 24.09.2026). On vérifie donc la réduction,
  // pas l'absence. Surtout pas `none` : il déverse la réflexion dans la réponse.
  ["proxy : réflexion coupée → réflexion réduite", async () => {
    const r = await fetch("http://127.0.0.1:8791/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        authorization: `Bearer ${key}`,
        "x-api-key": key,
        [REASONING_HEADER]: "low",
      },
      body: JSON.stringify({
        model: "zai-org/GLM-5.3-Flash",
        max_tokens: 400,
        messages: [{ role: "user", content: "Combien font 17 x 23 ? Réponds juste par le nombre." }],
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    const blocks = j.content ?? [];
    const thinking = blocks.filter((b) => b.type === "thinking").map((b) => b.thinking ?? "").join("");
    const out = j.usage?.output_tokens ?? 0;
    if (out > 25 || thinking.length > 30) {
      throw new Error(`réflexion non réduite (${out} jetons, ${thinking.length} car. de réflexion) : l'en-tête n'est pas traduit`);
    }
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
    if (!text.includes("391")) throw new Error(`réponse inattendue : ${text.slice(0, 120)}`);
  }],
];

let failed = 0;
for (const [name, fn] of cases) {
  const t = Date.now();
  try {
    await fn();
    console.log(`  OK    ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failed++;
    console.log(`  ÉCHEC ${name} : ${e.message}`);
  }
}
console.log(`${cases.length - failed}/${cases.length} cas passés`);
process.exit(failed ? 1 : 0);
