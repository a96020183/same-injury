// Discovery exam (V8 §4.11 check 3): run the Discovery agent on a composite company it has never seen and score
// "which table is the injury log" and the four-field map (date, body part, narrative, site) against the generator's answers.
//   npm run exam -- data/composite/1000            one development company (answers_PRIVATE.json in the folder)
//   npm run exam -- <unzipped exam>/2000/tables    on exam day, after checking sealed/SHA256SUMS_inputs.txt
//   npm run exam -- <tables> --live <tag>          live Zetaris: the company loaded by scripts/load_company_zetaris.py, queried
//                                                  with that company's own role (it sees nothing else); answers recorded
// Without --live, tables are served by the bundled emulator (same SQL surface as Zetaris); models go through Nightshift as usual,
// or the offline stub when there is no token — the output says which, and stub scores are not agent scores.
import { mkdirSync, readdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { config } from "./config.ts";
import { SqlTool } from "./zetaris.ts";
import { Models } from "./llm.ts";
import { Trace } from "./trace.ts";
import { L1World } from "./world.ts";
import { makeNoteModel } from "./agents/ctx.ts";
import { discover } from "./agents/discovery.ts";

const KEYS = ["date", "body_part", "narrative", "site"] as const;

// Source names follow scripts/load_company_zetaris.py, so a run on the emulator and a run on live Zetaris send the same SQL
// (and a recorded live run replays): <tag>_pg, <tag>_paper, <tag>_my, <tag>_files, <tag>_hq.
const KIND_NAME: Record<string, string> = { postgres: "pg", scan: "paper", mysql: "my", csv: "files" };
export const examTag = (src: string) => path.basename(path.resolve(src, src.endsWith("tables") ? ".." : ".")).replace(/^(\d)/, "co$1").toLowerCase();

export function buildExamDir(src: string, tag = examTag(src)) {
  const tmp = path.join(os.tmpdir(), "l1-exam-" + tag + "-" + process.pid);
  rmSync(tmp, { recursive: true, force: true });
  const cat = { datasources: [] as object[], lightning: [] as { name: string; description: string; tables: Record<string, string> }[] };
  const names = new Map<string, string>(); // emulator fq -> answer key
  const files = readdirSync(src).filter((f) => f.endsWith(".csv"));
  const groups = new Map<string, { kind: string; desc: string }>();
  for (const f of files) {
    const [sys, table] = f.replace(/\.csv$/, "").split("__");
    const m = sys.match(/^plant_group_([A-Z])-(\w+)$/);
    const kind = m ? m[2] : "csv";
    const syn = sys === "synthetic-csv"; // the invented plants: a test system of their own, not scored as one of the company's systems
    const src2 = m ? `${tag}_${KIND_NAME[kind] ?? kind}` : syn ? `${tag}_extra` : `${tag}_hq`;
    groups.set(src2, { kind, desc: m ? `plant group ${m[1]} ${kind === "csv" ? "exports" : "system"}` : syn ? "separate plant system" : "headquarters shared drive" });
    const sub = path.join(tmp, src2);
    mkdirSync(sub, { recursive: true });
    copyFileSync(path.join(src, f), path.join(sub, table + ".csv"));
    names.set(`${src2}.${table.toLowerCase()}`, m ? `plant_group_${m[1]}:${kind}/${table}` : syn ? `synthetic:csv/${table}` : `minio:csv/${table}`);
  }
  for (const [s, { kind, desc }] of [...groups].sort()) {
    if (kind === "csv") cat.lightning.push({ name: s, description: desc, tables: Object.fromEntries(readdirSync(path.join(tmp, s)).map((f) => [f.replace(/\.csv$/, "").toLowerCase(), `${s}/${f}`])) });
    else cat.datasources.push({ name: s, description: desc, folder: s });
  }
  writeFileSync(path.join(tmp, "catalog.json"), JSON.stringify(cat, null, 1));
  return { tmp, names };
}

export function score(ans: { tables: Record<string, string>; field_map: Record<string, Record<string, string>> }, pred: { tables: Record<string, string>; field_map: Record<string, Record<string, string | undefined>> }) {
  const lc = (s: string) => s.toLowerCase();
  const goldInc = new Set(Object.entries(ans.tables).filter(([, c]) => c === "incident").map(([t]) => lc(t)));
  const predInc = new Set(Object.entries(pred.tables).filter(([, c]) => c === "incident").map(([t]) => lc(t)));
  const tp = [...predInc].filter((t) => goldInc.has(t)).length;
  const gold = new Set([...Object.entries(ans.field_map)].filter(([t]) => goldInc.has(lc(t))).flatMap(([t, m]) => KEYS.map((k) => `${lc(t)}|${k}|${m[k]}`)));
  const got = new Set(Object.entries(pred.field_map).flatMap(([t, m]) => KEYS.filter((k) => m[k]).map((k) => `${lc(t)}|${k}|${m[k]}`)));
  const fp = [...got].filter((x) => gold.has(x)).length;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return { table_precision: predInc.size ? r3(tp / predInc.size) : 0, table_recall: r3(tp / goldInc.size), field_precision: got.size ? r3(fp / got.size) : 0, field_recall: r3(fp / gold.size) };
}

/** counts behind the score: injury logs found, field pairs right (the same sets the hashed scorer builds) */
export function counts(ans: { tables: Record<string, string>; field_map: Record<string, Record<string, string>> }, pred: { tables: Record<string, string>; field_map: Record<string, Record<string, string | undefined>> }) {
  const gi = new Set(Object.entries(ans.tables).filter(([, c]) => c === "incident").map(([t]) => t));
  const pi = new Set(Object.entries(pred.tables).filter(([, c]) => c === "incident").map(([t]) => t));
  const gp = new Set([...gi].flatMap((t) => KEYS.map((k) => `${t}|${k}|${ans.field_map[t][k]}`)));
  const pp = new Set(Object.entries(pred.field_map).flatMap(([t, m]) => KEYS.filter((k) => m[k]).map((k) => `${t}|${k}|${m[k]}`)));
  return { logsFound: [...pi].filter((t) => gi.has(t)).length, logs: gi.size, logsPicked: pi.size, fieldsRight: [...pp].filter((x) => gp.has(x)).length, fields: gp.size, fieldsGiven: pp.size };
}

/** Discovery on one composite company. live: the company's own Zetaris role (scripts/load_company_zetaris.py);
 * record: also write the Zetaris answers and model replies next to the tables, so the app can replay this run. */
export async function runCompany(src: string, o: { tag?: string; live?: boolean; record?: boolean; outDir?: string; trace?: Trace } = {}) {
  const tag = o.tag ?? examTag(src);
  const recDir = path.resolve(src, "..");
  const { tmp, names } = buildExamDir(src, tag);
  if (!o.live && existsSync(path.join(recDir, "zetaris_cassette.jsonl"))) copyFileSync(path.join(recDir, "zetaris_cassette.jsonl"), path.join(tmp, "zetaris_cassette.jsonl"));
  // every run gets its own folder and run id under outDir, so a trace never mixes runs
  const runId = `exam-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}-${Math.random().toString(16).slice(2, 6)}`;
  if (o.outDir && process.env.L1_EXAM_FLAT !== "1") o = { ...o, outDir: path.join(o.outDir, runId) }; // L1_EXAM_FLAT=1: the sealed-exam layout
  const trace = o.trace ?? new Trace(runId, o.outDir);
  const models = new Models({ record: o.record, dir: recDir, ...(o.outDir ? { runDir: o.outDir } : {}) });
  const agentKey = o.live ? readFileSync(path.join("data", "private", `zetaris_${tag}_key_PRIVATE.txt`), "utf8").trim() : undefined;
  if (o.outDir) mkdirSync(o.outDir, { recursive: true });
  const sqlTool = o.live ? new SqlTool({ mode: "live", agentKey, record: o.record, dir: o.record ? recDir : o.outDir ?? tmp }) : new SqlTool({ mode: "sample", dir: tmp });
  const ctx = { sql: sqlTool, models, trace, world: new L1World(), cfg: config.zetaris, noteModel: makeNoteModel(trace) };
  try {
    const d = await discover(ctx);
    const role = (r?: string) => (r === "incident_log" ? "incident" : r === "site_list" ? "site_master" : r === "yearly_summary" ? "summary" : "distractor");
    const pred = { tables: {} as Record<string, string>, field_map: {} as Record<string, Record<string, string | undefined>> };
    for (const t of d.tables) {
      const key = names.get(t.fq) ?? t.fq;
      if (key.startsWith("synthetic:")) continue; // the synthetic test system is not one of the company's systems: not scored
      pred.tables[key] = role(t.role);
      if (t.role === "incident_log" && t.map) pred.field_map[key] = { date: t.map.date, body_part: t.map.body_part, narrative: t.map.narrative, site: t.map.site };
    }
    const ansFile = ["answers_PRIVATE.json", "../answers.json"].map((f) => path.join(src, f)).find(existsSync);
    const ans = ansFile ? JSON.parse(readFileSync(ansFile, "utf8")) : undefined;
    const models_ = [...new Set(models.calls.map((c) => `${c.source}:${c.served}`))];
    const backends = [...new Set(sqlTool.receipts.map((r) => r.backend))];
    const out = { folder: src, tag, zetaris: backends, queries: sqlTool.receipts.length, models: models_, stub: models_.some((s) => s.startsWith("offline-stub")),
      calls: models.calls.map((c) => ({ lane: c.lane, requested: c.requested, served: c.served, source: c.source, latencyMs: c.latencyMs })),
      rows: d.tables.filter((t) => names.has(t.fq) && !names.get(t.fq)!.startsWith("synthetic:")).map((t) => { const key = names.get(t.fq)!; return { fq: t.fq, key, role: role(t.role), truth: ans?.tables[key],
        map: t.map && { date: t.map.date, body_part: t.map.body_part, narrative: t.map.narrative, site: t.map.site }, truthMap: ans?.field_map[key] && Object.fromEntries(KEYS.map((k) => [k, ans.field_map[key][k]])) }; }),
      discovery: d, prediction: pred, score: ans ? score(ans, pred) : undefined, counts: ans ? counts(ans, pred) : undefined, answers: ans };
    if (o.outDir) writeFileSync(path.join(o.outDir, "prediction.json"), JSON.stringify({ zetaris: backends, queries: out.queries, models: models_, calls: out.calls, ...pred, score: out.score, counts: out.counts }, null, 1));
    return out;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

if (process.argv[1]?.endsWith("exam.ts")) {
  const src = process.argv[2];
  if (!src || !existsSync(src)) { console.error("usage: npm run exam -- <folder with plant_group_*.csv> [--live <tag>] [--record]"); process.exit(1); }
  const liveTag = process.argv.includes("--live") ? process.argv[process.argv.indexOf("--live") + 1] : undefined;
  // L1_EXAM_OUT=<dir>: keep the trace, one line per model call (requested / served) and prediction.json for scoring later
  const r = await runCompany(src, { tag: liveTag, live: !!liveTag, record: process.argv.includes("--record"), outDir: process.env.L1_EXAM_OUT });
  console.log(JSON.stringify({ folder: src, zetaris: r.zetaris, queries: r.queries, models: r.models, prediction: r.prediction }, null, 1));
  if (r.score) console.log("score", JSON.stringify(r.score), JSON.stringify(r.counts), r.stub ? "(offline stub: not an agent score)" : "");
}
