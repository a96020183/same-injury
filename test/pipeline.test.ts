// Whole agent loop on the bundled sample (replayed Zetaris answers, offline model stubs). No network.
process.env.SAMPLE_MODE = "true";
process.env.L1_MODEL_OFFLINE = "true";
process.env.L1_RUNS_DIR = (await import("node:os")).tmpdir() + "/l1-test-runs";

import { test } from "node:test";
import assert from "node:assert/strict";

const { Run } = await import("../app/run.ts");
const { ModelUnavailable } = await import("../app/llm.ts");

async function toReview(patch?: (r: InstanceType<typeof Run>) => void) {
  const r = new Run();
  await r.start();
  assert.equal(r.phase, "awaiting_usl", r.error);
  patch?.(r);
  await r.approveUsl("test admin");
  assert.equal(r.phase, "review", r.error);
  return r;
}
const ev = (r: InstanceType<typeof Run>) => r.trace.events;

// the opening pair as generated (scripts/gen_synthetic.py): its plant, case and 301 answer key
const FEATURED = JSON.parse((await import("node:fs")).readFileSync(new URL("../sample/seed1003/intro.json", import.meta.url), "utf8")).featured as { site: string; case: string };
const FORM = Object.values(JSON.parse((await import("node:fs")).readFileSync(new URL("../sample/seed1003/scans/truth_plant_d.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>)
  .find((t) => t.site === FEATURED.site && t.case_no === FEATURED.case)!;

test("discovery: Evaluator rejects a wrong date format, Planner revises it, USL waits for a person", async () => {
  const r = new Run();
  // force one wrong first guess so the reject -> re-plan loop is exercised whatever the recorded model did
  const real = r.ctx.models.chat.bind(r.ctx.models);
  r.ctx.models.chat = async (lane, msgs, o) => {
    const rep = await real(lane, msgs, o);
    if (o.tag !== "discovery.classify.plant_b") return rep;
    return { ...rep, text: rep.text.replace(/dd\/MM\/yyyy/g, "MM/dd/yyyy") };
  };
  await r.start();
  const e = ev(r);
  // which table the first map gets wrong depends on the model (recorded Nemotron: plant D's date format; offline stub: plant B's)
  const rej = e.findIndex((x) => x.agent === "verifier" && x.kind === "reject" && !x.lane);
  assert.ok(rej >= 0, "the Evaluator rejects at least one field map");
  assert.ok(e.slice(rej).some((x) => x.agent === "planner" && x.kind === "replan"), "the Planner revises it");
  assert.equal(r.discovery!.tables.filter((t) => t.role === "incident_log").length, 5, "four plant systems and the synthetic test system");
  assert.ok(r.discovery!.tables.some((t) => t.role === "other"), "distractor tables recognised");
  assert.ok(!r.ctx.sql.receipts.some((x) => /^COMPILE USL/.test(x.sql)), "nothing compiled before approval");
  assert.equal(r.phase, "awaiting_usl");
});

test("matching: both directions, branches on confidence, conclusions only after a person approves identity", async () => {
  // the recorded Nemotron settles the opening thumb in one call; force one "not enough" so the re-plan loop is exercised
  const r = await toReview((run) => {
    const real = run.ctx.models.chat.bind(run.ctx.models);
    run.ctx.models.chat = async (lane, msgs, o) => {
      const rep = await real(lane, msgs, o);
      // the forced reply cites every receipt the lane holds and says what the DOL inspection means, as the Verifier requires
      const ids = () => (JSON.parse(String(msgs[1].content)).evidence ?? []).map((x: { id: string }) => x.id);
      return /^evaluator\.L\d+\.r1$/.test(o.tag) ? { ...rep, text: JSON.stringify({ verdict: "insufficient", reason: "The DOL inspection places the report; the narratives still need reading.", need: ["narrative_compare"], evidence: ids() }) } : rep;
    };
  });
  const items = r.items;
  assert.ok(items.some((i) => i.dir === "log") && items.some((i) => i.dir === "osha"));
  assert.equal(items.filter((i) => i.column === "reported").length, 0, "no conclusion before any approval");
  assert.ok(items.filter((i) => i.column === "outside").length === 2, "two State Plan sites");
  // a lane the Linker linked goes straight through: no Evaluator call (whether the recorded Linker links one directly is
  // the model's call; in the 2026-10-26 evening recording it sent every demo pair to the Evaluator, the unseen run linked 6)
  for (const high of r.matcher!.lanes.filter((l) => ev(r).some((x) => x.lane === l.id && /Linked by the Linker/.test(x.summary))))
    assert.ok(!ev(r).some((x) => x.lane === high.id && x.agent === "evaluator" && x.kind === "model"));
  // the laceration-vs-amputation lane loops: Evaluator says not enough, Planner re-plans, Research reads, Evaluator judges again
  const lane = r.matcher!.lanes.find((l) => l.log?.site === FEATURED.site && l.log.case_id === FEATURED.case)!;
  const kinds = ev(r).filter((x) => x.lane === lane.id).map((x) => `${x.agent}:${x.kind}`);
  assert.ok(kinds.indexOf("evaluator:reject") < kinds.indexOf("planner:replan"), kinds.join(" "));
  assert.ok(kinds.indexOf("planner:replan") < kinds.lastIndexOf("evaluator:model"));
  assert.ok(kinds.some((k) => k.startsWith("research:")));
  assert.ok(["review", "pending"].includes(r.items.find((i) => i.lane === lane.id)!.column));
  // approving one identity changes exactly the conclusions that depend on it
  const item = r.items.find((i) => i.dir === "log" && i.column === "pending")!;
  const changed = await r.decideMerge(item.proposalId!, true, "test lead");
  assert.ok(changed.some((c) => c.lane === item.lane));
  assert.ok(["reported", "reported_differs"].includes(r.items.find((i) => i.lane === item.lane)!.column), "a conclusion once the identity is approved");
  // an identity approved once updates both directions at once
  const shared = r.items.find((i) => i.dir === "osha" && i.column === "pending")!;
  const both = await r.decideMerge(shared.proposalId!, true, "test lead");
  assert.ok(both.some((c) => c.lane.startsWith("L")) && both.some((c) => c.lane.startsWith("R")));
  // a rejected identity never becomes a conclusion
  const other = r.items.find((i) => i.column === "pending")!;
  await r.decideMerge(other.proposalId!, false, "test lead");
  assert.equal(r.items.find((i) => i.lane === other.lane)!.column, "review");
});

test("every item carries query receipts; every receipt came from run_sql", async () => {
  const r = await toReview();
  const qids = new Set(r.ctx.sql.receipts.map((x) => x.qid));
  for (const i of r.items) {
    assert.ok(i.receipts.length > 0, `${i.lane} has receipts`);
    for (const q of i.receipts) assert.ok(qids.has(q));
  }
  assert.ok(r.ctx.sql.receipts.every((x) => x.backend === "replay" || x.backend === "emulator"));
});

test("escalation: an Evaluator that never gets enough evidence sends the lane to a person", async () => {
  const r = await toReview((run) => {
    const real = run.ctx.models.chat.bind(run.ctx.models);
    run.ctx.models.chat = async (lane, msgs, o) => o.tag.startsWith("evaluator.")
      ? { text: JSON.stringify({ verdict: "insufficient", reason: "Not enough.", need: ["dol_inspection", "narrative_compare", "letters"] }), served: "test", requested: "test", lane, source: "replay" as const, latencyMs: 0 }
      : real(lane, msgs, o);
  });
  const esc = ev(r).filter((x) => x.kind === "escalate" && x.lane);
  assert.ok(esc.length >= 1);
  assert.ok(r.items.some((i) => i.column === "review"));
});

test("model outage: lanes that need a model are escalated; the rest finish on labelled rule fallbacks", async () => {
  const r = await toReview((run) => {
    run.ctx.models.chat = async () => { throw new ModelUnavailable("Nightshift down (test)"); };
  });
  assert.ok(r.items.some((i) => i.column === "review"));
  assert.ok(r.items.some((i) => i.column === "pending"), "rule-only lanes still produced proposals");
});

test("World Model: re-ingesting the same data appends nothing", async () => {
  const r = await toReview();
  const n = r.ctx.world.wm.log().length;
  for (const s of r.matcher!.sites) await r.ctx.world.addSite(s);
  for (const l of r.matcher!.lanes) { if (l.log) await r.ctx.world.addLogCase(l.log); if (l.report) await r.ctx.world.addReport(l.report); }
  assert.equal(r.ctx.world.wm.log().length, n);
});

test("Reader: a VL reading of the scanned 301 form is checked against the typed log and lands in the World Model", async () => {
  const r = await toReview((run) => {
    const real = run.ctx.models.chat.bind(run.ctx.models);
    run.ctx.models.chat = async (lane, msgs, o) => {
      if (!o.tag.startsWith("reader.")) return real(lane, msgs, o);
      const caseNo = o.tag.match(/case(\w+)\.jpg/)![1];
      // the featured form is read right (its answer key); every other form is read wrong on purpose
      const form = caseNo === FEATURED.case ? { ...FORM, injury: `${FORM.body_part} amputated` } : { case_no: caseNo, injury_date: "2024-01-01", side: FORM.side === "left" ? "right" : "left", body_part: "elbow" };
      return { text: JSON.stringify(form), served: "nvidia/nemotron-3.5-super-vl-120b-a12b", requested: "meterless/vision", lane: "vision", source: "replay", latencyMs: 0 };
    };
  });
  const l6 = r.matcher!.lanes.find((l) => l.log?.site === FEATURED.site && l.log.case_id === FEATURED.case)!;
  // the synthetic test system's log has a body-part column of its own: the form is read and checked, the typed column stays
  assert.equal(l6.log!.body, "Finger(s), fingernail(s)");
  assert.equal((l6.research.form301 as { agrees_with_typed_log: boolean }).agrees_with_typed_log, true);
  assert.ok((r.ctx.world.wm.entity(`log-case:log:${l6.log!.key}`)!.attrs.form301 as { body_part: string }).body_part === FORM.body_part);
  assert.ok(ev(r).some((x) => x.agent === "reader" && x.kind === "reject" && /Differs from the typed log/.test(x.summary)), "a wrong reading is caught");
  assert.ok(ev(r).some((x) => x.agent === "reader" && x.kind === "model" && x.model?.served.includes("super-vl")));
});

test("Skeptic re-runs every cited query; competing explanations cite receipts", async () => {
  const r = await toReview();
  const sk = r.skeptic!;
  assert.ok(sk.rerun > 10 && sk.match === sk.rerun, JSON.stringify(sk));
  const nf = r.items.filter((i) => i.column === "not_found");
  assert.ok(nf.length >= 1);
  for (const i of nf) {
    const h = Object.fromEntries((i.hypotheses ?? []).map((x) => [x.h, x]));
    assert.equal(Object.keys(h).length, 6, "six explanations weighed");
    for (const x of Object.values(h)) assert.ok(["supported", "ruled_out", "not_ruled_out"].includes(x.status));
    assert.notEqual(h.state_plan.status, "supported", "a federal-state lane is not a State Plan lane");
    assert.notEqual(h.excluded.status, "supported", "no 1904.39(b) exclusion in the narrative");
    assert.notEqual(h.not_found.status, "ruled_out", "nothing found: 'no report in OSHA's file' cannot be ruled out");
    assert.ok(Object.values(h).some((x) => x.by === "evaluator"), "the statuses come from the Evaluator's model in the recorded run");
  }
  const qids = new Set(r.ctx.sql.receipts.map((x) => x.qid));
  for (const i of r.items) for (const h of i.hypotheses ?? []) for (const q of h.qids) assert.ok(qids.has(q), q);
  const outside = r.items.find((i) => i.column === "outside")!;
  // a State Plan state is searched like any other; the lane says only that the State Plan keeps its own records (QA round 8:
  // no "no report in OSHA's federal file: supported", no "unresolved", no model asked to weigh it)
  assert.equal(outside.hypotheses?.find((x) => x.h === "state_plan")?.status, "not_ruled_out");
  assert.match(outside.hypotheses!.find((x) => x.h === "state_plan")!.why, /runs a State Plan, which keeps its own records/);
  assert.equal(outside.hypotheses?.find((x) => x.h === "not_found"), undefined, "'no report in OSHA's federal file' is not weighed on a State Plan lane");
  assert.doesNotMatch(JSON.stringify(outside), /unresolved|counsel to assess|federal file has no report/i);
  assert.ok(outside.searched.some((s) => /OSHA reports/.test(s.label)), "the federal file was searched");
  assert.notEqual(outside.hypotheses?.find((x) => x.h === "excluded")?.status, "supported", "a State Plan state is not an exclusion: the employer reports to the State Plan");
});

test("Skeptic: a citation that does not reproduce sends its lane back to the Evaluator", async () => {
  const r = new Run();
  await r.start();
  // corrupt one recorded fingerprint after matching, before the Skeptic runs
  const real = r.ctx.sql.run.bind(r.ctx.sql);
  let tampered = "";
  r.ctx.sql.run = async (sql, purpose, agent, o) => {
    if (agent === "skeptic" && !tampered) { tampered = purpose.match(/^re-check (Q-\d+)/)![1]; const x = await real(sql, purpose, agent, o); x.receipt.rowsSha = "changed"; return x; }
    return real(sql, purpose, agent, o);
  };
  await r.approveUsl("test admin");
  assert.equal(r.skeptic!.mismatched.length, 1);
  assert.ok(r.skeptic!.lanesBack.length >= 1);
  assert.ok(r.trace.events.some((e) => e.agent === "skeptic" && e.kind === "reject" && e.lane));
});

test("both directions agree: the candidate map's pair is used, one injury has one set of differences, a same-ZIP report is never 'not ours' unjudged", async () => {
  const r = await toReview();
  const lanes = r.matcher!.lanes;
  // the federated candidate map's pair becomes the lane's candidate (L9's log line <-> its OSHA report, ZIP differs)
  const l9 = lanes.find((l) => l.id === "L9")!;
  assert.ok(l9.searched.some((s) => s.step === "candidate_map" && s.found >= 1), "candidate map searched");
  assert.equal(l9.state, "linked");
  assert.ok(l9.differences.some((d) => /ZIP differs/.test(d)), "a different ZIP is a difference");
  // the same pair seen from OSHA's side shows the same differences
  const r38 = lanes.find((l) => l.dir === "osha" && l.linkedLog === l9.log!.key)!;
  assert.deepEqual(r38.differences, l9.differences);
  // a linked lane's explanations agree with the link
  const it = r.items.find((i) => i.lane === l9.id)!;
  assert.notEqual(it.hypotheses?.find((h) => h.h === "different_injury")?.status, "supported");
  // the synthetic same-ZIP report at another house number gets a lane and a decision, not "not ours"
  const syn = lanes.find((l) => l.dir === "osha" && l.report?.id === "SIR-SYN001")!;
  assert.ok(syn.state !== "not_ours" || syn.verdicts.length || syn.searched.some((s) => s.step === "zip_week"), syn.state);
  assert.ok(syn.searched.some((s) => s.step === "zip_week"));
  // a lane is marked synthetic only by the record it ends on, not by a dropped candidate
  for (const l of lanes.filter((x) => x.state === "linked" && x.synthetic)) {
    const c = l.cands.find((x) => x.report.id === (l.linkedReport ?? l.report?.id));
    assert.ok(/SYNTHETIC|COMPOSITE/.test(`${l.log?.text ?? ""} ${l.report?.text ?? ""} ${c?.report.text ?? ""} ${c?.log?.text ?? ""}`), l.id);
  }
});
