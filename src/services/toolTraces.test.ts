import { test } from "node:test";
import assert from "node:assert/strict";
import { applyToolProgress, appendTraceStep, type ToolTrace } from "./toolTraces";

const call = (traces: ToolTrace[], name: string, args = "{}") =>
  applyToolProgress(traces, name, "calling", args);

test("un appel ouvre une trace, sa fin la clôt", () => {
  let t = call([], "search_contacts", '{"query":"Chiara"}');
  assert.equal(t[0].status, "calling");
  t = applyToolProgress(t, "search_contacts", "done");
  assert.equal(t[0].status, "done");
});

// Régression du 24.09.2026 : deux search_emails en parallèle, et la bulle
// « Actions de l'agent » tournait après la réponse finale.
test("deux appels parallèles du même outil se clôturent tous les deux", () => {
  let t = call([], "search_emails", '{"query":"Chiara contrat"}');
  t = call(t, "search_emails", '{"query":"contrat exemple"}');
  t = applyToolProgress(t, "search_emails", "done");
  t = applyToolProgress(t, "search_emails", "done");
  assert.deepEqual(t.map((x) => x.status), ["done", "done"]);
});

test("une erreur garde son message, les autres traces ne bougent pas", () => {
  let t = call([], "read_email_attachments");
  t = call(t, "display_emails");
  t = applyToolProgress(t, "read_email_attachments", "error", "Session expirée");
  assert.equal(t[0].status, "error");
  assert.equal(t[0].errorMsg, "Session expirée");
  assert.equal(t[1].status, "calling");
});

test("une fin pour un outil inconnu ne change rien", () => {
  const t = call([], "search_emails");
  assert.equal(applyToolProgress(t, "autre_outil", "done"), t);
});

test("les étapes de journal vont à la dernière trace de l'outil", () => {
  let t = call([], "search_emails");
  t = call(t, "search_emails");
  t = appendTraceStep(t, "search_emails", "12 résultats");
  assert.deepEqual(t[0].steps, []);
  assert.deepEqual(t[1].steps, ["12 résultats"]);
});
