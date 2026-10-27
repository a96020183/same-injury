// npm run variants — watch the second layer change with the data. No keys, no private files: each variant is a copy of
// the repo sample with one fact changed. Each variant was run once with live Nemotron through Nightshift (SQL from the
// recording or the bundled emulator) and its model replies were recorded in sample/variants/<variant>/; this command
// replays them, so the branch each variant takes is the model's. --stubs runs the agents' rule stubs instead;
// --record (with a Nightshift token) records the variants again. Then the unseen company 3001, end to end.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const csvSet = (file: string, id: string, col: string, value: string) => {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const head = lines[0].split(",");
  const i = head.indexOf(col);
  const out = lines.map((l) => {
    if (!l.startsWith(id + ",")) return l;
    const cells = l.split(","); cells[i] = value; return cells.join(",");
  });
  writeFileSync(file, out.join("\n"));
};
const append = (file: string, row: string) => writeFileSync(file, readFileSync(file, "utf8").replace(/\s*$/, "\n") + row + "\n");

type Variant = { name: string; what: string; mutate?: (dir: string) => void };
// the invented plant and its report, as generated (scripts/gen_synthetic.py): nothing about them is typed here
const rowOf = (dir: string, f: string, id: string) => readFileSync(path.join(dir, f), "utf8").split(/\r?\n/).find((l) => l.startsWith(id + ","))!.split(",");
const plant = rowOf("sample/seed1003", "synthetic_csv/sites.csv", "Site-SYN1"); // code, plant_name, legal_name, street, city, state, zip
const report = rowOf("sample/seed1003", "shared/osha_sir_2024.csv", "SIR-SYN001"); // ID, UPA, EventDate, Employer, Address1, ...
const no = (street: string) => street.split(" ")[0];
const VARIANTS: Variant[] = [
  { name: "as shipped", what: `SIR-SYN001 at no. ${no(report[4])}, same ZIP as the plant (no. ${no(plant[3])}), no referral number` },
  { name: "same house number", what: `SIR-SYN001 moved to no. ${no(plant[3])}, the plant's own address`,
    mutate: (d) => csvSet(path.join(d, "shared/osha_sir_2024.csv"), "SIR-SYN001", "Address1", plant[3]) },
  { name: "referral + DOL inspection", what: "SIR-SYN001 gets referral REF-SYN001, and DOL opened inspection DOL-SYN0001 at the plant's address",
    mutate: (d) => {
      csvSet(path.join(d, "shared/osha_sir_2024.csv"), "SIR-SYN001", "UPA", "REF-SYN001");
      append(path.join(d, "dol/related_activity.csv"), "DOL-SYN0001,R,REF-SYN001");
      const insp = path.join(d, "dol/inspection.csv");
      const head = readFileSync(insp, "utf8").split(/\r?\n/)[0].split(",");
      const [m, dd, y] = report[2].split("/").map(Number);
      const opened = new Date(Date.UTC(y, m - 1, dd + 8)).toISOString().slice(0, 10); // DOL opens its inspection about a week after the report
      const row: Record<string, string> = { activity_nr: "DOL-SYN0001", estab_name: report[3], site_address: plant[3].toUpperCase(), site_city: plant[4].toUpperCase(), site_state: plant[5], site_zip: plant[6], open_date: opened };
      append(insp, head.map((h) => row[h] ?? "").join(","));
    } },
];

const RECORD = process.argv.includes("--record"), STUBS = process.argv.includes("--stubs");
const slug = (n: string) => n.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

function run(dir: string, watch: string, live = false) {
  const env = { ...process.env, L1_SAMPLE_DIR: dir, SAMPLE_MODE: "true", L1_MODEL_OFFLINE: live ? "false" : "true", L1_RECORD: live ? "1" : "0", L1_WATCH: watch, L1_RUNS_DIR: path.join(os.tmpdir(), "l1-variants-runs") };
  const p = spawnSync(process.execPath, ["--no-warnings", "--import", "tsx", "scripts/variant_run.ts"], { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const line = (p.stdout ?? "").split("\n").find((l) => l.startsWith("@@RESULT"));
  if (!line) throw new Error("variant failed: " + (p.stderr || p.stdout).slice(-800));
  return JSON.parse(line.slice(8));
}

const results: unknown[] = [];
console.log(`Second layer on seed 1003, lane at Site-SYN1 (the SYNTHETIC pair in an invented plant) · ${STUBS ? "rule stubs" : "Nemotron, recorded live"}
`);
for (const v of VARIANTS) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "l1-variant-"));
  cpSync("sample/seed1003", dir, { recursive: true });
  // the main recording answers what did not change; the variant's own recording answers the rest
  const own = path.join("sample", "variants", slug(v.name), "model_cassette.jsonl");
  // SQL always comes from the bundled emulator over the changed CSVs (the recorded Zetaris answers are for the unchanged data)
  rmSync(path.join(dir, "zetaris_cassette.jsonl"), { force: true });
  if (STUBS) rmSync(path.join(dir, "model_cassette.jsonl"), { force: true });
  else if (existsSync(own)) writeFileSync(path.join(dir, "model_cassette.jsonl"), readFileSync(path.join(dir, "model_cassette.jsonl"), "utf8").replace(/\s*$/, "\n") + readFileSync(own, "utf8"));
  v.mutate?.(dir);
  const before = existsSync(path.join(dir, "model_cassette.jsonl")) ? readFileSync(path.join(dir, "model_cassette.jsonl"), "utf8").length : 0;
  const r = run(dir, "Site-SYN1", RECORD);
  if (RECORD) {
    const added = readFileSync(path.join(dir, "model_cassette.jsonl"), "utf8").slice(before);
    mkdirSync(path.dirname(own), { recursive: true });
    writeFileSync(own, (existsSync(own) ? readFileSync(own, "utf8") : "") + added);
  }
  const w = r.watched[0];
  const item = r.items.find((i: { lane: string }) => i.lane === w?.lane);
  console.log(`■ ${v.name}: ${v.what}`);
  console.log(`  models: ${STUBS ? "rule stubs" : r.liveCalls ? `${r.liveCalls} of ${r.modelCalls} Nemotron calls made live now (the rest replayed); SQL from the emulator` : `replay of live Nemotron (${r.modelCalls} calls; SQL from the emulator)`}${r.models.includes("offline-stub") ? " · some steps fell back to the rule stub" : ""}`);
  console.log(`  → ${w?.lane}: ${item?.column ?? w?.state}`);
  for (const step of w?.path ?? []) console.log("     " + step);
  results.push({ variant: v.name, what: v.what, lane: w?.lane, column: item?.column, path: w?.path, counts: r.counts });
  rmSync(dir, { recursive: true, force: true });
}

const full = "sample/unseen3001/full";
if (existsSync(path.join(full, "catalog.json"))) {
  console.log("\nUnseen company 3001, both layers, replayed from its live recording\n");
  const r = run(path.resolve(full), "");
  for (const i of r.items) console.log(`  ${i.lane.padEnd(4)} ${i.column.padEnd(16)} ${i.site ?? ""} ${i.date ?? ""}`);
  console.log(`  counts ${JSON.stringify(r.counts)} · models ${r.models.join(", ")}`);
  for (const l of r.verifierLanes) {
    console.log(`
  ${l.lane} ${l.site} → ${l.state}${l.synthetic ? ` (${l.synthetic})` : ""}`);
    for (const e of l.path) console.log(`     ${e.agent}:${e.kind} ${e.summary.slice(0, 120)}`);
  }
  results.push({ variant: "unseen company 3001", items: r.items, counts: r.counts, models: r.models });
}
writeFileSync(path.join(os.tmpdir(), "l1-variants.json"), JSON.stringify(results, null, 1));
