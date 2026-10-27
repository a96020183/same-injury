// The output gate (app/gate.ts): at a real plant only found, written differently and State Plan are shown; everything
// else is counted, not listed. The global scan (scripts/gate_scan.ts) checks every file git would commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
// real plant codes are built at run time, so this file never shows a real plant next to the words it tests
const R1 = ["Site", "014F"].join("-"), R2 = ["Site", "99C6"].join("-"), R3 = ["Site", "AADE"].join("-");
const { gateItems, gateEvent, gateYearly, gateLanes, isReal, plants, WITHHELD } = await import("../app/gate.ts");
const { scanOutputs } = await import("../scripts/gate_scan.ts");

const csv = (f: string) => {
  const [h, ...rows] = readFileSync(path.join(ROOT, f), "utf8").trim().split(/\r?\n/);
  const cols = h.split(",");
  return rows.map((l) => {
    const v: string[] = []; let cur = "", q = false;
    for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { v.push(cur); cur = ""; } else cur += ch; }
    v.push(cur);
    return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? ""]));
  });
};

test("global scan: no unit of any committed file names a real plant next to a non-neutral label or a synthetic record", () => {
  const r = scanOutputs();
  assert.ok(r.files > 200 && r.units > 10000, `scanned ${r.files} files, ${r.units} units`);
  assert.deepEqual(r.hits.map((h) => `${h.file} ${h.at}: ${h.text.slice(0, 120)}`), []);
});

test("every plant carries real: true/false; the invented plants are exactly the Site-SYN ones", () => {
  for (const [dir, tables] of [["sample/seed1003", ["group_a_postgres/sites.csv", "group_b_mysql/sites.csv", "group_c_csv/sites.csv", "group_d_scan/sites.csv", "synthetic_csv/sites.csv"]],
    ["sample/unseen3001", ["tables/plant_group_A-scan__loc_master.csv", "tables/plant_group_B-mysql__plants.csv", "tables/plant_group_C-postgres__sites.csv", "tables/plant_group_D-csv__facility_dim.csv", "tables/synthetic-csv__sites.csv"]]] as const) {
    const listed = JSON.parse(readFileSync(path.join(ROOT, dir, "plants.json"), "utf8")).plants as { site: string; real: boolean }[];
    const codes = tables.flatMap((t) => csv(`${dir}/${t}`).map((r) => r.code));
    assert.deepEqual(listed.map((p) => p.site).sort(), [...codes].sort(), dir);
    for (const p of listed) assert.equal(p.real, !p.site.startsWith("Site-SYN"), p.site);
  }
  assert.equal(isReal("Site-SYN2"), false);
  assert.equal(isReal(R1), true);
  assert.equal(isReal("Site-ZZZZ"), true, "a plant nobody listed counts as real");
  assert.ok(plants().size >= 50);
});

const item = (site: string, column: string, extra: Record<string, unknown> = {}) => ({ lane: "L1", dir: "log", site, column, differences: [] as string[], headline: "h", detail: [], searched: [], receipts: [], ...extra });

test("gate: a real plant shows only found, written differently and State Plan; the rest is counted", () => {
  const real = R1, syn = "Site-SYN2";
  const g = gateItems([
    item(real, "reported"), item(real, "reported_differs", { differences: ["side differs"] }), item(real, "outside"), item(real, "pending", { basis: "linked" }),
    item(real, "not_found"), item(real, "review"), item(real, "not_in_log"), item(real, "pending", { basis: "no_match" }), item(real, "reported_differs", { synthetic: true }),
    item(real, "reported_differs", { differences: ["OSHA's report does not flag an amputation"] }),
    item(syn, "not_found", { synthetic: true }), item(syn, "review", { synthetic: true }),
  ] as never[]);
  assert.deepEqual((g.items as { site: string; column: string }[]).map((i) => `${i.site} ${i.column}`),
    [`${real} reported`, `${real} reported_differs`, `${real} outside`, `${real} pending`, `${syn} not_found`, `${syn} review`]);
  assert.equal(g.withheld.count, 6);
  // at a real plant only the neutral explanations are shown
  const h = gateItems([item(real, "outside", { hypotheses: [{ h: "state_plan", status: "not_ruled_out" }, { h: "not_found", status: "supported" }, { h: "excluded", status: "ruled_out" }] })] as never[]);
  assert.deepEqual((h.items[0] as { hypotheses: { h: string }[] }).hypotheses.map((x) => x.h), ["state_plan"], "only the neutral explanations leave the gate");
});

test("gate: trace events, lanes and the 300A count check", () => {
  assert.equal(gateEvent({ summary: "Searched 6 places. WY runs a State Plan: unresolved.", site: R2 }).summary, WITHHELD);
  assert.equal(gateEvent({ summary: "Searched 6 places. Unresolved.", site: "Site-SYN3" }).summary, "Searched 6 places. Unresolved.");
  // a whitelist: the model's own words at a real plant become a fixed sentence; a sentence no template knows is not shown
  const d = gateEvent({ summary: "Same injury: same address, the log is more specific.", site: R1, detail: [{ h: "not_found", status: "supported", why: "free text" }] });
  assert.equal(d.summary, "Same injury (the Evaluator's words are shown only for invented plants).");
  assert.equal(d.detail, undefined);
  assert.equal(gateEvent({ summary: "Nothing here reads as a finding, but no template knows this sentence.", site: R1 }).summary, WITHHELD);
  assert.equal(gateEvent({ summary: "OSHA reports, same ZIP, ±7 days: 0 found.", site: R2 }).summary, "OSHA reports, same ZIP, ±7 days: searched.");
  assert.equal(gateEvent({ summary: "OSHA reports, same ZIP, ±7 days: 1 found.", site: R1 }).summary, "OSHA reports, same ZIP, ±7 days: 1 found.");
  assert.equal(gateEvent({ summary: `2 of 33 sites disagree with their yearly summary: ${R3} 6/7.` }).summary, WITHHELD);
  const y = gateYearly([{ site: R3 }, { site: "Site-SYN7" }]);
  assert.deepEqual([y.named.map((x) => x.site), y.realCount], [["Site-SYN7"], 1]);
  assert.deepEqual(gateLanes([{ site: R1, state: "needs_review", verdicts: [1] }, { site: R1, state: "linked", verdicts: [1] }]).map((l) => l.state), ["withheld", "linked"]);
});

test("synthetic documents exist only in invented plants: reply letters, 301 forms", () => {
  for (const r of csv("sample/seed1003/shared/reply_letters.csv")) assert.match(r.site, /^Site-SYN\d$/, r.doc_id);
  const scans = readdirSync(path.join(ROOT, "sample/seed1003/scans")).filter((f) => f.startsWith("301_"));
  assert.ok(scans.length >= 3);
  for (const f of scans) assert.match(f, /^301_Site-SYN\d_/, f);
  const truth = JSON.parse(readFileSync(path.join(ROOT, "sample/seed1003/scans/truth_plant_d.json"), "utf8"));
  for (const v of Object.values(truth) as { site: string }[]) assert.match(v.site, /^Site-SYN\d$/);
});

test("a real plant's log line carries no published case-level field: case code, job family, restated injury", () => {
  const FAM = /^(Production|Maintenance|Sanitation|Warehouse and shipping|Supervision|Office and lab|Not stated)( \(temporary\))?$/;
  const logs: [string, string, string, string, string][] = [
    ["sample/seed1003/group_a_postgres/injury_log.csv", "establishment", "case_number", "job_title", "nature_of_injury"],
    ["sample/seed1003/group_b_mysql/inc_rpt.csv", "plant_id", "rec_id", "occupation", "inj_type"],
    ["sample/seed1003/group_c_csv/EHS_Export_2024.csv", "Site Name", "Case #", "Job Title", "Injury Type"],
    ["sample/unseen3001/tables/plant_group_B-mysql__recordables.csv", "plant_id", "log_line", "job_title", "nature_of_injury"],
    ["sample/unseen3001/tables/plant_group_C-postgres__EHS_Export_2024.csv", "plant", "log_line", "position", "nature_of_injury"],
    ["sample/unseen3001/tables/plant_group_D-csv__inc_rpt.csv", "f9", "f8", "f7", "f1"],
  ];
  let n = 0;
  for (const [f, site, cas, job, inj] of logs) for (const r of csv(f)) {
    if (!isReal(r[site])) continue;
    n++;
    assert.match(r[cas], /^LN-\d{3}$/, `${f} ${r[site]} ${r[cas]}`);
    assert.match(r[job], FAM, `${f} ${r[site]} ${r[job]}`);
    assert.match(r[inj], /^(Body part: |Outcome: )/, `${f} ${r[site]} ${r[inj]}`);
  }
  for (const f of ["sample/seed1003/group_d_scan/scanned_log_transcribed.csv", "sample/unseen3001/tables/plant_group_A-scan__scanned_log_transcribed.csv"])
    for (const r of csv(f)) if (isReal(r.site)) { n++; assert.match(r.transcribed_text, /^Case LN-\d{3} on [0-9/]+\. (Job: [^.]+\. )?/, r.transcribed_text.slice(0, 60)); const j = r.transcribed_text.match(/Job: ([^.]+)\./)?.[1]; if (j) assert.match(j, FAM); }
  assert.ok(n > 400, `${n} real log lines checked`);
});

test("300A: a real plant's case count equals its log; a mismatch exists only in an invented plant", () => {
  for (const [s300, logs] of [
    ["sample/seed1003/shared/annual_summary_300A.csv", [["sample/seed1003/group_a_postgres/injury_log.csv", "establishment"], ["sample/seed1003/group_b_mysql/inc_rpt.csv", "plant_id"],
      ["sample/seed1003/group_c_csv/EHS_Export_2024.csv", "Site Name"], ["sample/seed1003/group_d_scan/scanned_log_transcribed.csv", "site"]]],
    ["sample/unseen3001/tables/minio-csv__yr_totals.csv", [["sample/unseen3001/tables/plant_group_B-mysql__recordables.csv", "plant_id"], ["sample/unseen3001/tables/plant_group_C-postgres__EHS_Export_2024.csv", "plant"],
      ["sample/unseen3001/tables/plant_group_D-csv__inc_rpt.csv", "f9"], ["sample/unseen3001/tables/plant_group_A-scan__scanned_log_transcribed.csv", "site"]]],
  ] as const) {
    const count = new Map<string, number>();
    for (const [f, col] of logs) for (const r of csv(f)) count.set(r[col], (count.get(r[col]) ?? 0) + 1);
    for (const r of csv(s300)) {
      const sum = ["Total Dafw Cases", "Total Djtr Cases", "Total Other Cases"].reduce((a, c) => a + Number(r[c]), 0);
      if (isReal(r.Establishment)) assert.equal(sum, count.get(r.Establishment) ?? 0, `${s300} ${r.Establishment}`);
    }
  }
  assert.ok(existsSync(path.join(ROOT, "sample/unseen3001/full/plants.json")));
});

// QA round 9: every SYNTHETIC record is generated from a seed alone (scripts/gen_synthetic.py), never edited from a real one
test("(a) the synthetic generator reads nothing: no open, no read, no data path, only a seed", () => {
  const src = readFileSync(path.join(ROOT, "scripts/gen_synthetic.py"), "utf8");
  const code = src.replace(/"""[\s\S]*?"""/g, "").replace(/#.*$/gm, "");
  assert.doesNotMatch(code, /\bopen\s*\(|\.read\w*\s*\(|read_csv|json\.load|pathlib|Path\s*\(|\bcsv\.|import csv|urllib|requests|subprocess/, "no file or network access");
  assert.doesNotMatch(code, /data\/|sample\/|\.csv|\.json|PRIVATE|docs\//, "no data path");
  const imports = [...code.matchAll(/^\s*(?:import|from)\s+([\w.]+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(imports)], ["datetime", "json", "os", "osha_states", "random", "sys"]);
  // the one module it imports is a constant list
  assert.doesNotMatch(readFileSync(path.join(ROOT, "scripts/osha_states.py"), "utf8").replace(/"""[\s\S]*?"""/, ""), /\bimport\b|open\s*\(/);
});

test("(b) no synthetic row shares 2 or more fields with a real row; (c) no invented plant has a real plant's house number + state or ZIP", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("python", ["-I", "scripts/synthetic_compare.py"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.deepEqual(res.fields, ["house_state", "case", "job", "page", "date", "narrative"]);
  for (const [c, v] of Object.entries(res.companies) as [string, { rows: number; max_shared: number; rows_sharing_2_or_more: number; invented_plants: number; invented_plants_at_a_real_address_or_zip: string[] }][]) {
    assert.ok(v.rows >= 7, c);
    assert.ok(v.max_shared < 2, `${c}: a synthetic row shares ${v.max_shared} fields with a real row`);
    assert.equal(v.rows_sharing_2_or_more, 0, c);
    assert.ok(v.invented_plants >= 3, c);
    assert.deepEqual(v.invented_plants_at_a_real_address_or_zip, [], c);
  }
  // the home page and the README quote this file: it must be the current result
  assert.deepEqual(JSON.parse(readFileSync(path.join(ROOT, "docs/synthetic_check.json"), "utf8")), res, "docs/synthetic_check.json is stale: python -I scripts/synthetic_compare.py --write");
});

test("whitelist: every published step and result at a real plant is an approved template or a structured result code", async () => {
  const { approvedEvent, approvedItemText, approvedDiff, isReal: real, sitesIn } = await import("../app/gate.ts");
  const dir = path.join(ROOT, "docs/trace");
  let events = 0, items = 0;
  for (const f of readdirSync(dir).filter((x) => /^(demo|unseen3001)_\d{8}-\d{6}-\w{4}_trace\.jsonl$/.test(x))) {
    for (const l of readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean)) {
      const e = JSON.parse(l);
      if (!(real(e.site) || sitesIn(e.summary).some(real))) continue;
      events++;
      assert.ok(approvedEvent(e.summary), `${f} event ${e.seq}: ${e.summary.slice(0, 120)}`);
      if (real(e.site)) assert.equal(e.detail, undefined, `${f} event ${e.seq} carries data at a real plant`);
    }
  }
  for (const f of readdirSync(dir).filter((x) => /_items(_at_review)?\.json$/.test(x))) for (const i of JSON.parse(readFileSync(path.join(dir, f), "utf8"))) {
    if (!real(i.site)) continue;
    items++;
    assert.ok(["found", "written_differently", "state_plan"].includes(i.resultCode), `${f} ${i.lane}: ${i.resultCode}`);
    for (const t of [i.headline, ...i.detail]) assert.ok(approvedItemText(t), `${f} ${i.lane}: ${t}`);
    for (const d of i.differences) assert.ok(approvedDiff(d), `${f} ${i.lane}: ${d}`);
    assert.equal(i.evaluator, undefined);
    for (const h of i.hypotheses ?? []) assert.equal(h.why, "", `${f} ${i.lane}: model text in an explanation`);
    if (i.resultCode === "state_plan") assert.ok(i.searched.every((s: { found?: number }) => s.found === undefined), `${f} ${i.lane}: a State Plan plant carries a search count`);
  }
  assert.ok(events > 50 && items > 10, `${events} events, ${items} items checked`);
});

test("every exit the server has passes a gate: no route outside app/gate.ts EXITS", async () => {
  const { EXITS } = await import("../app/gate.ts");
  const src = readFileSync(path.join(ROOT, "app/server.ts"), "utf8");
  const routes = [...src.matchAll(/url\.pathname(?: === |\.startsWith\()"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(routes.length >= 12, routes.join(" "));
  for (const r of routes) assert.ok(EXITS[r], `server route ${r} is not listed in EXITS with its gate`);
  for (const [k, v] of Object.entries(EXITS)) assert.ok(v.length > 2, k);
  // the files a run writes go through the gate too
  const run = readFileSync(path.join(ROOT, "app/run.ts"), "utf8");
  for (const g of ["gateItems(this.items)", "gateReceipt(", "gateWorldLog(", "gateQueue(", "gateLanes("]) assert.ok(run.includes(g), g);
});

test("the invented plants live in a synthetic test system of their own: no group, source, table or naming shared with a real employer", () => {
  // seed 1003: real plant systems hold no invented plant; the synthetic system holds nothing else
  for (const g of ["group_a_postgres", "group_b_mysql", "group_c_csv", "group_d_scan"]) for (const f of readdirSync(path.join(ROOT, "sample/seed1003", g)))
    assert.doesNotMatch(readFileSync(path.join(ROOT, "sample/seed1003", g, f), "utf8"), /Site-SYN|SYNTHETIC/, `${g}/${f}`);
  for (const f of ["sites.csv", "injury_log.csv"]) for (const r of csv(`sample/seed1003/synthetic_csv/${f}`)) assert.match(r.code ?? r.site, /^Site-SYN\d+$/);
  for (const r of csv("sample/seed1003/synthetic_csv/sites.csv")) {
    assert.match(r.plant_name, /^Plant S\d+ \(SYNTHETIC\)$/);
    assert.match(r.legal_name, /^Firm SYN-\d+ \(SYNTHETIC\)$/);
  }
  const cat = JSON.parse(readFileSync(path.join(ROOT, "sample/seed1003/catalog.json"), "utf8"));
  const syn = cat.lightning.find((l: { name: string }) => l.name === "extra_sites");
  assert.ok(syn && Object.values(syn.tables).every((t) => String(t).startsWith("synthetic_csv/")));
  const realSources = [...cat.datasources.map((d: { name: string; folder: string }) => d.folder), ...cat.lightning.filter((l: { name: string }) => l.name !== "extra_sites").flatMap((l: { tables: Record<string, string> }) => Object.values(l.tables))];
  assert.ok(realSources.every((t: string) => !t.startsWith("synthetic")));
  // unseen 3001: the same, in its tables folder and in its layer-2 catalog
  const T = path.join(ROOT, "sample/unseen3001/tables");
  for (const f of readdirSync(T).filter((x) => x.startsWith("plant_group_"))) assert.doesNotMatch(readFileSync(path.join(T, f), "utf8"), /Site-SYN|SYNTHETIC/, f);
  for (const f of readdirSync(T).filter((x) => x.startsWith("synthetic-csv__"))) for (const r of csv(`sample/unseen3001/tables/${f}`)) assert.match(r.code ?? r.site, /^Site-SYN\d+$/);
  const full = JSON.parse(readFileSync(path.join(ROOT, "sample/unseen3001/full/catalog.json"), "utf8"));
  assert.ok(full.lightning.some((l: { name: string }) => l.name === "unseen3001_extra"));
  for (const d of readdirSync(path.join(ROOT, "sample/unseen3001/full")).filter((x) => /^unseen3001_(files|my|paper|pg)$/.test(x)))
    for (const f of readdirSync(path.join(ROOT, "sample/unseen3001/full", d))) assert.doesNotMatch(readFileSync(path.join(ROOT, "sample/unseen3001/full", d, f), "utf8"), /Site-SYN/, `${d}/${f}`);
});

test("a real plant never shows 'OSHA's report says less than the log' (no amputation flag): the item, the replay summary and the certify table", async () => {
  const { gateItems, gateReplay, plantLevel } = await import("../app/gate.ts");
  const { certifySummary, nextSteps } = await import("../app/agents/final.ts");
  const less = "OSHA's report does not flag an amputation; the log does";
  const full = item(R1, "reported_differs", { basis: "linked", differences: [less, "ZIP differs: OSHA 00906, plant 00907"], headline: "OSHA report SIR-1", detail: [`Written differently: ${less}`] });
  assert.equal(plantLevel(full as never), false);
  assert.equal(gateItems([full] as never[]).items.length, 0);
  assert.equal(gateItems([{ ...full, column: "in_log_differs" }] as never[]).items.length, 0);
  // the replay summary's shape (QA round 10: fewer fields) is gated the same way and does not throw
  const bare = { lane: "L5", site: R1, column: "reported_differs", differences: [less] };
  const r = gateReplay({ items: [bare] as never[] });
  assert.equal(r.items.length, 0);
  assert.doesNotMatch(JSON.stringify(r), /does not flag an amputation/);
  // the certify table names no real plant for it; next steps count it without a plant
  const rows = certifySummary([full] as never);
  assert.ok(rows.every((x) => x.site !== R1), JSON.stringify(rows));
  assert.doesNotMatch(JSON.stringify(nextSteps([full] as never)), new RegExp(R1));
});

test("a real plant's item leaves with whitelisted fields only (QA round 11: no source narrative, town, state or log key)", async () => {
  const { gateItems, gateReplay } = await import("../app/gate.ts");
  const raw = item(R1, "reported_differs", { basis: "linked", reportId: "SIR-T1", logKey: "plant_d:x:LN-001", plantName: "Town, ST", state: "DE", body: "source narrative", report: "SIR-T1",
    osha_less: false, evaluator: "model words", verifier: [{ round: 1 }], synthetic: false, differences: ["ZIP differs: OSHA 00906, plant 00907"] });
  const allowed = new Set(["lane", "dir", "site", "date", "column", "basis", "reportId", "caseId", "proposalId", "receipts", "resultCode", "differences", "detail", "headline", "hypotheses", "searched"]);
  for (const out of [gateItems([raw] as never[]).items[0], gateReplay({ items: [raw] as never[] }).items[0]]) {
    assert.ok(out, "a found item is shown");
    for (const k of Object.keys(out as object)) assert.ok(allowed.has(k), `field ${k} left the gate`);
  }
});

test("no value typed into code, tests, fixtures or docs is a real record id, or a real address with its ZIP", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("python", ["-I", "scripts/synthetic_compare.py", "--hardcoded"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), []);
  // the check itself: a fixture written with a real plant's house number and ZIP is caught
  const site = csv("sample/seed1003/group_a_postgres/sites.csv")[0];
  const { writeFileSync, rmSync, mkdtempSync } = await import("node:fs");
  const os = await import("node:os");
  const f = path.join(mkdtempSync(path.join(os.tmpdir(), "l1-fixture-")), "fixture.test.ts");
  writeFileSync(f, `const site = { street: "${site.street.split(" ")[0]}", zip: "${site.zip}" };\n`);
  const r2 = spawnSync("python", ["-I", "scripts/synthetic_compare.py", "--hardcoded", f], { cwd: ROOT, encoding: "utf8" });
  rmSync(path.dirname(f), { recursive: true, force: true });
  assert.equal(JSON.parse(r2.stdout).length, 1, "a real address in a fixture is flagged");
});

test("README: no lane number is typed by hand (they come from the traces)", () => {
  const md = readFileSync(path.join(ROOT, "README.md"), "utf8").replace(/<!-- auto:([\w-]+) -->[\s\S]*?<!-- \/auto:\1 -->/g, "");
  const typed = md.match(/\b(?<![\w/.-])[LR]\d{1,3}\b(?![\w.-])/g) ?? [];
  assert.deepEqual(typed.filter((x) => !/^L1$/.test(x)), [], "lane ids outside the generated blocks");
});
