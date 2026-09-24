import { test } from "node:test";
import assert from "node:assert/strict";
import { RefStore } from "./emailRefs.js";

const meta = (id: string) => ({
  realId: id,
  subject: `Sujet ${id}`,
  date: "2026-09-24",
  from: "chiara.tanteri@epfl.ch",
  direction: "received" as const,
});

// Mode sans état : la table des refs part au client en fin de tour et revient
// au tour suivant. « Ouvre le 3e mail » doit retrouver le même vrai ID.
test("la table survit à l'aller-retour JSON", () => {
  const a = new RefStore();
  const r1 = a.makeRef(meta("AAA"));
  const r2 = a.makeRef(meta("BBB"));
  const b = RefStore.fromJSON(JSON.parse(JSON.stringify(a.toJSON())));
  assert.equal(b.resolve(r1)?.realId, "AAA");
  assert.equal(b.resolve(r2)?.realId, "BBB");
});

test("après restauration, un email déjà vu garde son ref, un nouveau n'écrase rien", () => {
  const a = new RefStore();
  const r1 = a.makeRef(meta("AAA"));
  const b = RefStore.fromJSON(a.toJSON());
  assert.equal(b.makeRef(meta("AAA")), r1);
  const r2 = b.makeRef(meta("CCC"));
  assert.notEqual(r2, r1);
  assert.equal(b.resolve(r1)?.realId, "AAA");
});

test("une table absente ou corrompue donne une table vide, sans planter", () => {
  for (const bad of [undefined, null, "x", { refs: null }, { refs: { ref_0: { nope: 1 } } }]) {
    const s = RefStore.fromJSON(bad);
    assert.equal(s.resolve("ref_0"), undefined);
    assert.equal(s.makeRef(meta("Z")), "ref_0");
  }
});
