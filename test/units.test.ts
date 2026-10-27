// Unit tests that never call Nightshift: a fake fetch stands in for the provider.
process.env.SAMPLE_MODE = "false";
process.env.L1_MODEL_OFFLINE = "false";
process.env.METERLESS_RUNTIME_TOKEN = "test-token-not-real-0000";
process.env.METERLESS_BASE_URL = "http://nightshift.invalid/v1";
process.env.L1_MODEL_RETRIES = "1";

import { test } from "node:test";
import assert from "node:assert/strict";

const { Models, stripReasoning, extractJson, ModelUnavailable } = await import("../app/llm.ts");
const { sparkToDate, ZetarisEmulator } = await import("../app/emulator.ts");
const { riskCheck, exclusions, compareBody, mentionsAmputation } = await import("../app/rules.ts");
const { SqlTool } = await import("../app/zetaris.ts");
const { features, tier } = await import("../app/agents/matching.ts");
const { config } = await import("../app/config.ts");

test("reasoning text is stripped; JSON is found in prose", () => {
  assert.equal(stripReasoning("<think>secret plan</think> answer"), "answer");
  assert.equal(stripReasoning("half a thought </think>final"), "final");
  assert.deepEqual(extractJson('Sure! ```json\n{"verdict":"same"}\n```'), { verdict: "same" });
  assert.deepEqual(extractJson('[{"a":1}]'), [{ a: 1 }]);
});

test("Nightshift: `user` scope by default (the contract), a fresh iso scope per request with METERLESS_SCOPE=iso; served model recorded; one request at a time", async () => {
  const seen: Record<string, string>[] = [];
  let inFlight = 0, maxInFlight = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | Request, init?: RequestInit) => {
    // the client sends a Request object (its headers are what gets logged as sent)
    seen.push(input instanceof Request ? Object.fromEntries(input.headers) : init!.headers as Record<string, string>);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return new Response(JSON.stringify({ model: "nvidia/nemotron-3-ultra-550b-a55b", usage: { total_tokens: 42 },
      choices: [{ message: { content: "<think>hidden</think>{\"ok\":true}" } }] }), { status: 200 });
  }) as typeof fetch;
  const ns = config.nightshift as { scope: string };
  const before = ns.scope;
  try {
    assert.equal(before, "user", "the contract's scope by default");
    await new Models({}).chat("deep", [{ role: "user", content: "q0" }], { tag: "t", stub: () => "stub" });
    assert.equal(seen.shift()!["meterless-scope"], "user");
    ns.scope = "iso";
    const m = new Models({});
    const rs = await Promise.all([1, 2, 3].map((i) => m.chat("deep", [{ role: "user", content: "q" + i }], { tag: "t", stub: () => "stub" })));
    assert.equal(maxInFlight, 1, "at most one request in flight");
    for (const h of seen) { assert.match(h["meterless-scope"], /^iso-[0-9a-f-]{36}$/); assert.notEqual(h["meterless-scope"], "user"); }
    assert.equal(new Set(seen.map((h) => h["meterless-scope"])).size, 3, "a new scope every request");
    for (const r of rs) { assert.equal(r.served, "nvidia/nemotron-3-ultra-550b-a55b"); assert.equal(r.text, '{"ok":true}'); assert.equal(r.source, "live"); }
    assert.equal(rs[0].requested, config.nightshift.deep);
  } finally { globalThis.fetch = orig; ns.scope = before; }
});

test("Nightshift down: ModelUnavailable is raised (agents escalate, they do not invent)", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response("Function not found", { status: 404 })) as typeof fetch;
  try {
    await assert.rejects(new Models({}).chat("fast", [{ role: "user", content: "x" }], { tag: "t", stub: () => "stub" }), ModelUnavailable);
  } finally { globalThis.fetch = orig; }
});

test("Spark date patterns behave like Spark (wrong pattern = null)", () => {
  assert.equal(sparkToDate("21/08/2024", "MM/dd/yyyy"), null);
  assert.equal(sparkToDate("21/08/2024", "dd/MM/yyyy"), "2024-08-21");
  assert.equal(sparkToDate("01/16/24", "MM/dd/yy"), "2024-01-16");
  assert.equal(sparkToDate("16-Jan-2024", "dd-MMM-yyyy"), "2024-01-16");
  assert.equal(sparkToDate("6/13/2024", "M/d/yyyy"), "2024-06-13");
});

test("emulator answers catalog commands, rlike and USL like the live Zetaris", () => {
  const e = new ZetarisEmulator(config.sampleDir);
  assert.ok(e.run("SHOW DATASOURCES").data.some((r) => r[0] === "plant_b"));
  // the paper log's one real amputation line; the synthetic ones live in the synthetic test system
  assert.deepEqual(e.run("SELECT site FROM plant_d.scanned_log_transcribed WHERE transcribed_text rlike '(?i)amputat'").data.length, 1);
  assert.deepEqual(e.run("SELECT site FROM extra_sites.injury_log WHERE description rlike '(?i)amputat'").data.length, 4);
  e.run("COMPILE USL u DEPLOY NAMESPACE lightning.metastore.t DDL\nCREATE TABLE s (a varchar(9))");
  e.run("ACTIVATE USL TABLE lightning.metastore.t.u.s AS SELECT code AS a FROM plant_a.sites");
  assert.equal(e.run("SELECT count(*) AS n FROM lightning.metastore.t.u.s").data[0][0], "5");
  assert.throws(() => e.run("EXPLAIN QUERY AS SELECT 1"), /live Zetaris/);
});

test("run_sql: SAMPLE_MODE replays recorded Zetaris answers; a miss is served by the emulator and says so", { skip: !(await import("node:fs")).existsSync("sample/seed1003/zetaris_cassette.jsonl") && "Zetaris cassette not recorded yet" }, async () => {
  const s = new SqlTool({ mode: "sample" });
  const hit = await s.run("SHOW DATASOURCES", "t", "test");
  assert.equal(hit.receipt.backend, "replay");
  const miss = await s.run("SELECT count(*) AS n FROM plant_a.sites WHERE 1 = 1", "t", "test");
  assert.equal(miss.receipt.backend, "emulator");
  assert.equal(miss.result.data[0][0], "5");
  assert.match(miss.receipt.qid, /^Q-\d{4}$/);
  assert.deepEqual(miss.receipt.sources, ["plant_a.sites"]);
});

test("Risk wording: accusations are rewritten", () => {
  const r = riskCheck("The employer failed to report this and may be in violation.");
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.rewritten, /failed to report|violation/i);
  assert.equal(riskCheck("Not found in OSHA's federal file.").ok, true);
});

test("1904.39 exclusions and amputation wording", () => {
  assert.equal(exclusions("finger avulsion on the conveyor")[0].rule, "avulsion");
  assert.equal(exclusions("rear-ended on the interstate while driving")[0].rule, "road");
  assert.equal(exclusions("forklift struck a pallet").length, 0);
  assert.equal(mentionsAmputation("near amputation, no injury"), false);
  assert.equal(compareBody("left index finger", "right index finger").compatible, false);
});

test("Linker tiers: with identity masked, place = house number + ZIP or city; anything short of place+week+injury goes to the Evaluator", () => {
  const site = { code: "S1", plant_name: "Test plant", legal_name: "", street: "9003", city: "Testville", state: "IL", zip: "00903", ein: "", group: "D" };
  const log = { date: "2024-06-13", text: "amputation to right thumb", body: "" };
  const rep = (o: object) => ({ id: "1", upa: "", date: "2024-06-13", employer: "*** ******** ***", street: "9003 **** ***", city: "TESTVILLE", state: "ILLINOIS", zip: "00903", amputation: true, body: "thumb", text: "right thumb amputated", inspection: "", ...o });
  assert.equal(tier(features(log, site, rep({}))).tier, "high");
  assert.equal(tier(features(log, site, rep({ zip: "00904" }))).tier, "low", "ZIP differs, same house number and city: the Evaluator decides");
  assert.equal(tier(features(log, site, rep({ street: "9004 **** ***" }))).tier, "low", "same ZIP and week, another house number: the Evaluator decides");
  assert.equal(tier(features(log, site, rep({ street: "9004 **** ***", zip: "00905", city: "OTHERTON" }))).tier, "not_ours");
  assert.equal(tier(features(log, site, rep({ zip: "00905", city: "OTHERTON" }))).tier, "low");
  assert.equal(tier(features(log, site, rep({ amputation: false }))).tier, "low");
  assert.equal(tier(features(log, site, rep({ date: "2024-06-25" }))).tier, "low");
  assert.equal(tier(features(log, site, rep({ text: "left thumb amputated" }))).tier, "low");
});

test("every sample 301 scan has the employee name blacked out before any model can see it", async () => {
  const { isRedacted } = await import("../app/agents/reader.ts");
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = "sample/seed1003/scans";
  const scans = readdirSync(dir).filter((f) => f.endsWith(".jpg"));
  assert.ok(scans.length >= 4);
  for (const f of scans) assert.ok(isRedacted(readFileSync(`${dir}/${f}`)), f);
  assert.equal(isRedacted(Buffer.from("plain jpeg bytes")), false);
});

test("the emulator never pretends to enforce access control", () => {
  const emu = new ZetarisEmulator("sample/seed1003");
  const r = emu.run("GRANT SELECT ON USL TABLE lightning.metastore.l1.injury_records.site TO ROLE 'L1_AGENT'");
  assert.match(String(r.data[0]?.[0]), /not enforced/);
});

test("Verifier: a DOL receipt already gathered must be cited or ruled out, whatever the decision", async () => {
  const { unaddressed } = await import("../app/agents/matching.ts");
  const lane = { searched: [{ step: "dol_sites", label: "DOL inspections", qid: "Q-0042", found: 2 }], research: {
    dol_sites: { osha_house_number: "9002", plant_house_number: "9001", inspections: [{ inspection: "DOL-TEST01", house_number: "9002", opened: "2024-03-12" }, { inspection: "DOL-1", house_number: "9", opened: "2024-03-10" }] } } };
  const cand = { report: { date: "2024-03-09" } };
  const o = unaddressed(lane as never, cand as never, []);
  assert.ok(o && o.rule === "unaddressed" && o.receipts![0] === "Q-0042" && /DOL-TEST01/.test(o.text), JSON.stringify(o));
  assert.ok(unaddressed(lane as never, cand as never, ["Q-0042"], "address mismatch"), "a bare receipt id is not an explanation");
  for (const vague of ["No DOL data reviewed", "inspection not checked", "the DOL inspection is irrelevant"])
    assert.ok(unaddressed(lane as never, cand as never, ["Q-0042"], vague), `"${vague}" names neither the inspection nor OSHA's house number`);
  assert.equal(unaddressed(lane as never, cand as never, ["Q-0042"], "DOL inspected house number 9002 three days later: likely the other address"), undefined, "OSHA's house number named");
  assert.equal(unaddressed(lane as never, cand as never, ["Q-0042"], "Same injury: the DOL inspection links OSHA's report to the plant"), undefined, "what the inspection shows about the place");
  assert.equal(unaddressed(lane as never, cand as never, ["Q-0042"], "DOL-TEST01 was opened at OSHA's house number: likely another site"), undefined, "cited and explained");
  const far = { ...lane, research: { dol_sites: { ...lane.research.dol_sites, inspections: [{ inspection: "DOL-TEST01", house_number: "9002", opened: "2024-06-12" }] } } };
  assert.equal(unaddressed(far as never, cand as never, []), undefined, "an inspection months away does not bear on the report");
});

test("Wording guard: 'unreported', 'reportable' and 'required to report' are rewritten", () => {
  for (const s of ["Injury appears unreported federally", "The amputation is reportable within 24 hours", "The employer was required to report it"]) {
    const r = riskCheck(s);
    assert.ok(!r.ok && !/unreported|reportable|required to report/i.test(r.rewritten), r.rewritten);
  }
});

test("Next steps and the certify table count one injury once, and do not ask to change a log that is right", async () => {
  const { nextSteps, certifySummary } = await import("../app/agents/final.ts");
  const base = { detail: [], searched: [], receipts: [], site: "Site-SYN2" } // an invented plant: the output gate lists only neutral results at a real one;
  const items = [
    { ...base, lane: "L7", dir: "log", column: "reported_differs", headline: "", reportId: "SIR-1", logKey: "k1", differences: ["OSHA's report does not flag an amputation; the log does"] },
    { ...base, lane: "R21", dir: "osha", column: "in_log_differs", headline: "", reportId: "SIR-1", logKey: "k1", differences: ["OSHA's report does not flag an amputation; the log does"] },
    { ...base, lane: "L6", dir: "log", column: "reported_differs", headline: "", reportId: "SIR-2", logKey: "k2", differences: ["ZIP differs: OSHA 00906, plant 00907"] },
    { ...base, lane: "R30", dir: "osha", column: "in_log_differs", headline: "", reportId: "SIR-2", logKey: "k2", differences: ["ZIP differs: OSHA 00906, plant 00907"] },
    { ...base, lane: "L1", dir: "log", column: "pending", headline: "", reportId: "SIR-3", logKey: "k3", proposalId: "P-1", differences: [] },
    { ...base, lane: "R3", dir: "osha", column: "pending", headline: "", reportId: "SIR-3", logKey: "k3", proposalId: "P-1", differences: [] },
  ];
  const ns = nextSteps(items as never);
  const by = Object.fromEntries(ns.map((s) => [s.key, s.count]));
  assert.equal(by.decide, 1, "one identity, two directions");
  assert.equal(by.address, 1, "the ZIP pair, once: an address to check, not a log entry to correct");
  assert.equal(by.fix, undefined);
  assert.equal(by.osha_less, 1, "the log records the amputation: counsel, not a log correction");
  const row = certifySummary(items as never)[0];
  assert.equal(row.review, 1, "the ZIP pair: review wording");
  assert.equal(row.counsel, 1, "OSHA's report says less than the log: counsel, as in Next steps");
});

test("Places searched: a follow-up query inside one search does not count as another place", async () => {
  const { placesSearched } = await import("../app/agents/matching.ts");
  const l = { searched: [{ step: "jurisdiction" }, { step: "same_site_7d" }, { step: "letters" }, { step: "letters_referral" }, { step: "letters_referral" }] };
  assert.equal(placesSearched(l as never), 3);
});

test("Verifier: 'different' that rests on another address is not accepted when the agents cannot see whose address it is", async () => {
  const { verify } = await import("../app/agents/matching.ts");
  const f = { zipSame: true, streetSame: false, citySame: true, nameSim: 0, days: 0, sirAmp: true, logAmp: true, body: { compatible: true, diffs: [] } };
  const lane = { research: { dol_inspection: { found: true, inspection: "DOL-1", estab_name: "******** *", at_our_plant_address: false } } };
  const c = { report: { employer: "******** *", street: "9002 Test Way", zip: "00902" }, site: { street: "9001", zip: "00902" }, f };
  const o = verify(lane as never, c as never, { verdict: "different", evidence: [] }, new Set());
  assert.equal(o?.rule, "masked_identity", JSON.stringify(o));
  // with names visible (the reviewer's side, or an unmasked establishment) the address receipt can stand
  const named = { research: { dol_inspection: { ...lane.research.dol_inspection, estab_name: "Firm 9A2C" } } };
  assert.equal(verify(named as never, { ...c, report: { ...c.report, employer: "Firm 9A2C" } } as never, { verdict: "different", evidence: [] }, new Set()), undefined);
});

test("Explanations: with OSHA's employer masked, an inspection at OSHA's address does not support 'another site'", async () => {
  const { ruleHypotheses } = await import("../app/agents/hypotheses.ts");
  const f = { zipSame: true, streetSame: false, citySame: true, nameSim: 0, days: 0, sirAmp: true, logAmp: true, body: { compatible: true, diffs: [] } };
  const mk = (employer: string) => ({ dir: "log", state: "needs_review", site: { state: "OH" }, verdicts: [], differences: [], searched: [{ step: "dol_sites", label: "", qid: "Q-1", found: 1 }],
    research: { dol_sites: { osha_house_number: "9002", plant_house_number: "9001", inspections: [{ inspection: "DOL-1", house_number: "9002", opened: "2024-02-01" }] } },
    cands: [{ report: { employer, date: "2024-01-29" }, f, tier: "low" }] });
  const masked = ruleHypotheses(mk("******** *") as never, "").find((h) => h.h === "wrong_site")!;
  assert.equal(masked.status, "not_ruled_out", masked.why);
  assert.equal(ruleHypotheses(mk("Firm 9A2C") as never, "").find((h) => h.h === "wrong_site")!.status, "supported");
});

test("Body parts: OSHA's category names are not body parts (no thumb from 'Finger or thumb tip(s), nail(s)')", () => {
  const f = compareBody("Body part: right hand. Outcome: amputation, right hand.", "Finger or thumb tip(s), nail(s) Body part: tip of the right index finger. Outcome: partial amputation.");
  assert.deepEqual(f.b.fingers, ["index"]);
  assert.ok(f.compatible, JSON.stringify(f.diffs));
  const g = compareBody("Body part: tip of the left middle finger.", "Finger or thumb tip(s), nail(s) Body part: fingertip. Outcome: partial amputation, fingertip.");
  assert.ok(g.compatible && !g.diffs.some((d) => /thumb/.test(d)), JSON.stringify(g.diffs));
  assert.deepEqual(compareBody("", "Thumb(s) Body part: left thumb.").b.fingers, ["thumb"], "a thumb named in the narrative still counts");
});

test("SYNTHETIC OSHA reports are invented records: own id, invented employer, no published referral or inspection behind them", async () => {
  const { readFileSync } = await import("node:fs");
  const csvRows = (f: string) => { const [h, ...ls] = readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean); const cols = h.split(",");
    return ls.map((l) => { const cells = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "")); return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""])); }); };
  for (const [sir, rel] of [["sample/seed1003/shared/osha_sir_2024.csv", "sample/seed1003/dol/related_activity.csv"], ["sample/unseen3001/public/osha_sir_2024.csv", "sample/unseen3001/public/related_activity.csv"]]) {
    const links = csvRows(rel);
    const syn = csvRows(sir).filter((r) => /SYNTHETIC/.test(r["Final Narrative"]));
    assert.ok(syn.length >= 2, sir);
    for (const r of syn) {
      assert.match(r.ID, /^SIR-SYN\d+$/, `${sir}: ${r.ID} is not an invented id`);
      assert.match(r.Employer, /\(SYNTHETIC\)$/, `${r.ID}: employer ${r.Employer}`);
      assert.equal(r.Inspection, "", `${r.ID}: no OSHA inspection field`);
      if (r.UPA) {
        assert.match(r.UPA, /^REF-SYN\d+$/, `${r.ID}: referral ${r.UPA}`);
        for (const l of links.filter((x) => x.rel_act_nr === r.UPA)) assert.match(l.activity_nr, /^DOL-SYN\d+$/, `${r.UPA} -> ${l.activity_nr}`);
      }
    }
  }
});

test("employer coding: a shared town or trade word does not make a report the source company's (python self-test)", async () => {
  const { spawnSync } = await import("node:child_process");
  const p = spawnSync("python", ["-I", "scripts/employer_codes.py"], { encoding: "utf8" });
  if (p.error) return; // no Python on this machine: the builder (which needs Python) is not run here either
  assert.equal(p.status, 0, p.stderr);
});

test("A masked employer is masked whatever punctuation the mask keeps ('**** **** (*********)')", async () => {
  const { maskedNear } = await import("../app/agents/matching.ts");
  const f = { zipSame: true, streetSame: false, citySame: false, nameSim: 0, days: 0, sirAmp: true, logAmp: true, body: { compatible: true, diffs: [] } };
  assert.ok(maskedNear({ report: { employer: "**** **** (*********)" }, f } as never));
  assert.ok(!maskedNear({ report: { employer: "Firm 0003 (SYNTHETIC)" }, f } as never), "names visible: not masked");
});

test("No SYNTHETIC record sits in a real plant: every synthetic log line and OSHA report is at an invented plant (Site-SYN...)", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const path = await import("node:path");
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".csv") ? [path.join(d, e.name)] : []));
  for (const root of ["sample/seed1003", "sample/unseen3001/full"]) {
    const files = walk(root);
    const lines = files.flatMap((f) => readFileSync(f, "utf8").split(/\r?\n/));
    // invented plants: their site rows, and the address (street, ZIP) each sits at
    const synSites = lines.filter((l) => /^Site-SYN\d,/.test(l));
    assert.ok(synSites.length >= 3, root);
    const synZips = new Set(synSites.map((l) => (l.match(/,(\d{5}),/) ?? [])[1]).filter(Boolean));
    for (const l of lines.filter((x) => /SYNTHETIC DEMO LINE/.test(x))) assert.match(l, /Site-SYN\d/, `${root}: synthetic log line outside an invented plant: ${l.slice(0, 80)}`);
    for (const l of lines.filter((x) => /^SIR-SYN/.test(x))) assert.ok([...synZips].some((z) => l.includes(`,${z},`)), `${root}: synthetic OSHA report outside an invented plant's ZIP: ${l.slice(0, 80)}`);
    for (const l of lines.filter((x) => /^DOL-SYN/.test(x) && /SYNTHETIC/.test(x))) assert.ok([...synZips].some((z) => l.includes(`,${z},`)), l.slice(0, 80));
  }
});
