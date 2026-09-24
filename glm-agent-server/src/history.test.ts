import { test } from "node:test";
import assert from "node:assert/strict";
import { HISTORY_MAX_CHARS, withHistory } from "./history.js";

test("sans historique, le message part tel quel", () => {
  assert.equal(withHistory("Q ?", []), "Q ?");
});

test("l'historique précède la nouvelle demande, dans l'ordre", () => {
  const out = withHistory("Et ensuite ?", [
    { role: "user", content: "Premier" },
    { role: "assistant", content: "Réponse un" },
    { role: "user", content: "Deuxième" },
  ]);
  assert.ok(out.indexOf("Utilisateur : Premier") < out.indexOf("Assistant : Réponse un"));
  assert.ok(out.indexOf("Assistant : Réponse un") < out.indexOf("Utilisateur : Deuxième"));
  assert.ok(out.trimEnd().endsWith("Nouvelle demande de l'utilisateur :\nEt ensuite ?"));
});

test("les entrées vides ou mal formées sont ignorées", () => {
  const out = withHistory("Q", [
    { role: "user", content: "   " },
    { role: "assistant", content: 42 },
    {} as { role?: string; content?: unknown },
  ]);
  assert.equal(out, "Q");
});

test("au-delà du plafond, on garde les messages les plus RÉCENTS", () => {
  const big = "x".repeat(HISTORY_MAX_CHARS / 2);
  const out = withHistory("Q", [
    { role: "user", content: "ANCIEN " + big },
    { role: "assistant", content: "MILIEU " + big },
    { role: "user", content: "RÉCENT" },
  ]);
  assert.ok(out.includes("RÉCENT"));
  assert.ok(out.includes("MILIEU"));
  assert.ok(!out.includes("ANCIEN"));
});

test("un document joint de 250 000 jetons (~1 M caractères) tient dans le plafond", () => {
  const doc = "d".repeat(1_000_000);
  const out = withHistory("Q", [
    { role: "user", content: "Voici le doc " + doc },
    { role: "assistant", content: "Lu." },
  ]);
  assert.ok(out.includes("Voici le doc"));
});
