// L1 World Model tests (aliases and renumbering), on small samples of public ITA / SIR / DOL rows, names pseudonymized:
//   fixtures/sites.json    : the same ITA establishment in 2024 and 2025; 3 changed establishment_id, 2 did not (scripts/wm_fixture.py)
//   fixtures/agencies.json : one employer as named by SIR, DOL and ITA (scripts/wm_fixture_agencies.py)
// Run: npx tsx --test engine/world-model/l1.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decide, nameSimilarity } from "./index.ts";
import { L1_RESOLVER, importDolInspection, importIta, importSirReport, newL1World, proposeRenumbered, siteConclusion } from "./l1world.ts";

const fx = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const sites = fx("sites.json");
const agencies = fx("agencies.json");
const y24 = sites.pairs.map((p: any) => p.y2024);
const y25 = sites.pairs.map((p: any) => p.y2025);
const clock = () => new Date("2026-10-23T00:00:00.000Z");

test("re-importing the same data: empty entity diff, no new events", async () => {
  const w = newL1World(clock);
  await importIta(w, y24, 2024);
  const shape = w.stateShapeCanonical();
  const n = w.log().length;
  await importIta(w, y24, 2024);
  assert.equal(w.stateShapeCanonical(), shape);
  assert.equal(w.log().length, n);
});

test("importing 2024 then 2025: existing IDs never change; a renumbered establishment appears under its new ID", async () => {
  const w = newL1World(clock);
  await importIta(w, y24, 2024);
  const ids2024 = w.query("site").map((e) => e.id);
  await importIta(w, y25, 2025);
  for (const id of ids2024) assert.equal(w.entity(id)!.id, id, `${id} must not be renumbered`);
  const changed = sites.pairs.filter((p: any) => p.id_changed);
  for (const p of changed) assert.ok(w.entity(`site:ita:${p.y2025.establishment_id}`), "the new ID must appear");
  assert.equal(w.query("site").length, ids2024.length + changed.length);
  // importing 2025 again is still an empty diff
  const shape = w.stateShapeCanonical();
  await importIta(w, y25, 2025);
  assert.equal(w.stateShapeCanonical(), shape);
});

test("a renumbering is proposed, never auto-merged; after approval old and new IDs resolve to one establishment", async () => {
  const w = newL1World(clock);
  await importIta(w, y24, 2024);
  await importIta(w, y25, 2025);
  const props = await proposeRenumbered(w, y25);
  const changed = sites.pairs.filter((p: any) => p.id_changed);
  assert.equal(props.length, changed.length, "one proposal per renumbered establishment, none for the others");
  assert.ok(w.mergeQueue().every((p) => p.status === "pending"));
  const p0 = changed[0];
  const oldId = `site:ita:${p0.y2024.establishment_id}`, newId = `site:ita:${p0.y2025.establishment_id}`;
  assert.notEqual(w.entity(newId)!.id, w.entity(oldId)!.id, "two entities before approval");
  const prop = w.mergeQueue().find((p) => p.leftId === newId)!;
  await w.approveMerge(prop.id, "ehs-lead");
  assert.equal(w.entity(newId)!.id, oldId, "after approval the new ID resolves to the 2024 ID");
  assert.equal(w.entity(oldId)!.id, oldId, "the 2024 ID is unchanged");
  assert.ok(w.audit().some((a) => a.kind === "alias" && a.actor === "ehs-lead"));
});

test("three agencies' names: even very similar names only go to the queue (L1 setting), never auto-merge", () => {
  // SIR and DOL strings for one employer, similarity >= 0.85: the spec default auto-merges, the L1 setting only proposes
  const c = agencies.cases.find((x: any) => nameSimilarity(x.sir_employer, x.dol_estab_name) >= 0.85);
  assert.ok(c, "the sample has one SIR/DOL pair with similarity >= 0.85");
  const sim = nameSimilarity(c.sir_employer, c.dol_estab_name);
  assert.equal(decide(sim), "auto-merge");
  assert.equal(decide(sim, L1_RESOLVER.autoMergeAt, L1_RESOLVER.reviewLower), "review");
});

test("an unapproved merge appears in no conclusion; after approval the reports and inspections of the establishment update together", async () => {
  const w = newL1World(clock);
  // the case where SIR names the parent company while DOL and ITA name the subsidiary
  const c = agencies.cases.find((x: any) => x.parent_vs_subsidiary) ?? agencies.cases[0];
  await importIta(w, [c.ita], 2024);
  const siteId = `site:ita:${c.ita.establishment_id}`;
  const { emp: sirName } = await importSirReport(w, { sir_id: c.sir_id, employer: c.sir_employer, zip: c.ita.zip, event_date: c.event_date, amputation: true });
  const { emp: dolName } = await importDolInspection(w, { activity_nr: c.dol_activity_nr, estab_name: c.dol_estab_name, zip: c.ita.zip, open_date: "2024-06-01" });

  // two proposals (Linker evidence: referral -> inspection -> same ZIP and house number), neither approved yet
  const a = await w.proposeMerge(sirName.id, siteId, "UPA links this SIR report to a DOL inspection at the same zip and street", { kind: "agent", by: "linker", at: "2026-10-23T00:00:00.000Z" });
  const b = await w.proposeMerge(dolName.id, siteId, "DOL inspection site address = ITA site address", { kind: "agent", by: "linker", at: "2026-10-23T00:00:00.000Z" });
  const before = siteConclusion(w, siteId);
  assert.deepEqual(before.reports, [], "unapproved: no report under the establishment");
  assert.deepEqual(before.inspections, [], "unapproved: no inspection under the establishment");

  await w.approveMerge(a!.id, "ehs-lead");
  const mid = siteConclusion(w, siteId);
  assert.deepEqual(mid.reports, [`report:sir:${c.sir_id}`]);
  assert.deepEqual(mid.inspections, [], "only one approved: the other still does not count");

  await w.approveMerge(b!.id, "ehs-lead");
  const after = siteConclusion(w, siteId);
  assert.deepEqual(after.inspections, [`inspection:dol:${c.dol_activity_nr}`]);
  assert.ok(after.aliases.includes(c.sir_employer) && after.aliases.includes(c.dol_estab_name), "all three names became aliases of the establishment");
});

test("a rejected proposal changes no conclusion", async () => {
  const w = newL1World(clock);
  const c = agencies.cases[0];
  await importIta(w, [c.ita], 2024);
  const siteId = `site:ita:${c.ita.establishment_id}`;
  const { emp } = await importSirReport(w, { sir_id: c.sir_id, employer: c.sir_employer, zip: c.ita.zip, event_date: c.event_date, amputation: true });
  const p = await w.proposeMerge(emp.id, siteId, "name similar, address differs", { kind: "agent", by: "linker", at: "2026-10-23T00:00:00.000Z" });
  await w.rejectMerge(p!.id, "evaluator");
  assert.deepEqual(siteConclusion(w, siteId).reports, []);
});
