// Re-scores every live Layer-1 run on the unseen company from its own trace (no build log, no hand-typed number):
// the last field map Discovery gave each table (its verdicts, then any Planner revision), scored with app/exam.ts's
// counts() against sample/unseen3001/answers.json. Writes docs/trace/unseen3001_layer1_runs.json.
//   node --no-warnings --import tsx scripts/score_layer1_traces.ts
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { counts } from "../app/exam.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const ans = JSON.parse(readFileSync(path.join(ROOT, "sample/unseen3001/answers.json"), "utf8"));
const names: Record<string, string> = JSON.parse(readFileSync(path.join(ROOT, "docs/trace/unseen3001_layer1_names.json"), "utf8")).names;
type Ev = { seq: number; t: string; run: string; agent: string; kind: string; summary: string; detail?: unknown };
const role = (r?: string) => (r === "incident_log" ? "incident" : r === "site_list" ? "site_master" : r === "yearly_summary" ? "summary" : "distractor");

export function scoreTrace(ev: Ev[]) {
  const tables = new Map<string, { role?: string; map?: Record<string, string> }>();
  for (const e of ev) {
    if (e.agent === "discovery" && e.kind === "verdict" && Array.isArray(e.detail))
      for (const t of e.detail as { table: string; role: string; map?: Record<string, string> }[]) tables.set(t.table, { role: t.role, map: t.map });
    // a Planner revision carries the map after it (runs from 2026-10-24 evening); older revisions changed the date format only
    const d = e.detail as { after?: Record<string, string> } | undefined;
    if (e.agent === "planner" && e.kind === "replan" && d?.after) {
      const fq = e.summary.match(/^(?:Revised|Re-checked) (\S+?):/)?.[1];
      if (fq && tables.has(fq)) tables.get(fq)!.map = d.after;
    }
  }
  const pred = { tables: {} as Record<string, string>, field_map: {} as Record<string, Record<string, string | undefined>> };
  for (const [fq, t] of tables) {
    const key = names[fq] ?? fq;
    if (key.startsWith("synthetic:") || /_extra\./.test(fq)) continue; // the synthetic test system (QA round 10) is not scored
    pred.tables[key] = role(t.role);
    if (t.role === "incident_log" && t.map) pred.field_map[key] = { date: t.map.date, body_part: t.map.body_part, narrative: t.map.narrative, site: t.map.site };
  }
  return counts(ans, pred);
}

const read = (f: string): Ev[] => readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const files = [
  ...readdirSync(path.join(ROOT, "docs/trace/unseen3001_layer1_runs")).filter((f) => /^run\d+_trace\.jsonl$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0])).map((f) => path.join("docs/trace/unseen3001_layer1_runs", f)),
  ...readdirSync(path.join(ROOT, "docs/trace")).filter((f) => /^unseen3001_layer1_exam-.*_trace\.jsonl$/.test(f)).sort().map((f) => path.join("docs/trace", f)),
];
const runs = files.map((f, i) => {
  const ev = read(path.join(ROOT, f));
  const c = scoreTrace(ev);
  return { n: i + 1, run: ev[0].run, started: ev[0].t, trace: f.replace(/\\/g, "/"), logs: `${c.logsFound}/${c.logs}`, fields: `${c.fieldsRight}/${c.fields}`, fields_given: c.fieldsGiven };
});
writeFileSync(path.join(ROOT, "docs/trace/unseen3001_layer1_runs.json"), JSON.stringify({
  note: "Every live Layer-1 run on the unseen company (seed 3001), in order, scored from its own trace by scripts/score_layer1_traces.ts. The code changed between runs. Runs before 2026-10-24 12:56 UTC were appended to one trace file at the time and are split per run in docs/trace/unseen3001_layer1_runs/.",
  runs }, null, 1) + "\n");
for (const r of runs) console.log(`run ${r.n} ${r.started} logs ${r.logs} fields ${r.fields}`);
