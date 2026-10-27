// The matching layer has no table or source name in code: rename every source and the public tables, and the same
// agents still find the four injury logs, the scanned forms, the OSHA and DOL tables, and the same lanes.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(os.tmpdir(), "l1-renamed-"));
cpSync("sample/seed1003", dir, { recursive: true });
for (const f of ["zetaris_cassette.jsonl", "model_cassette.jsonl"]) rmSync(path.join(dir, f), { force: true }); // recordings carry the original names
const RENAME: Record<string, string> = { plant_a: "ehs_main", plant_b: "incidents_mysql", plant_c: "exports_share", plant_d: "paper_logs", extra_sites: "site_extras",
  osha_public: "public_osha", dol: "enforcement", hq_files: "hq_drive" };
const TABLES: Record<string, string> = { severe_injury_reports: "sir_2024", state_plans: "jurisdictions", inspection: "insp", related_activity: "insp_links", reply_letters: "letters_2024" };
let cat = readFileSync(path.join(dir, "catalog.json"), "utf8");
for (const [a, b] of Object.entries(RENAME)) cat = cat.replace(new RegExp(`"${a}(?=["\.])`, "g"), `"${b}`);
for (const [a, b] of Object.entries(TABLES)) cat = cat.replace(new RegExp(`"${a}"`, "g"), `"${b}"`).replace(new RegExp(`\.${a}"`, "g"), `.${b}"`);
writeFileSync(path.join(dir, "catalog.json"), cat);
process.env.L1_SAMPLE_DIR = dir;
process.env.SAMPLE_MODE = "true";
process.env.L1_MODEL_OFFLINE = "true";
process.env.L1_RUNS_DIR = path.join(os.tmpdir(), "l1-test-runs");

const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { Run } = await import("../app/run.ts");

test("renamed sources and tables: discovery and matching follow the catalog, not names in code", async () => {
  const r = new Run();
  await r.start();
  assert.equal(r.phase, "awaiting_usl", r.error);
  const inc = r.discovery!.tables.filter((t) => t.role === "incident_log").map((t) => t.source).sort();
  assert.deepEqual(inc, ["ehs_main", "exports_share", "incidents_mysql", "paper_logs", "site_extras"]);
  await r.approveUsl("test admin");
  assert.equal(r.phase, "review", r.error);
  assert.deepEqual(r.matcher!.T, { sir: "public_osha.sir_2024", dolInspection: "enforcement.insp", dolLinks: "enforcement.insp_links", letters: "hq_drive.letters_2024", statePlans: "public_osha.jurisdictions" });
  assert.ok(r.trace.events.some((e) => e.agent === "reader" && /^3 amputation log lines have a scanned paper 301 form \(site_extras\)/.test(e.summary)));
  const f = JSON.parse((await import("node:fs")).readFileSync(new URL("../sample/seed1003/intro.json", import.meta.url), "utf8")).featured as { site: string; case: string };
  const lane = r.matcher!.lanes.find((l) => l.log?.site === f.site && l.log.case_id === f.case);
  assert.ok(lane?.cands.some((c) => c.report.id === "SIR-SYN002"), "the opening pair still finds OSHA's report");
  assert.ok(r.items.filter((i) => i.column === "outside").length === 2, "State Plan check still runs");
  assert.ok(!r.ctx.sql.receipts.some((x) => /plant_[a-d]|osha_public|hq_files|extra_sites|\bdol\./.test(x.sql)), "no query names an original source");
});
