// Consistency: the README, what the screen shows (the run's JSON, replayed with the shipped code), and the trace of the
// live run the README names (scripts/runs.ts) must agree; and a SYNTHETIC mark in the data must reach the lane, the
// item, the trace and the counsel export. No network: replays of the recorded runs, rule stubs only where nothing was
// recorded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { RUNS, traceFile } from "../scripts/runs.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const replay = (env: Record<string, string>) => {
  const p = spawnSync(process.execPath, ["--no-warnings", "--import", "tsx", "scripts/variant_run.ts"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SAMPLE_MODE: "true", L1_MODEL_OFFLINE: "true", L1_RUNS_DIR: path.join(ROOT, "runs", "consistency"), ...env } });
  const line = p.stdout.split("\n").find((l) => l.startsWith("@@RESULT"));
  assert.ok(line, p.stderr.slice(-600));
  return JSON.parse(line!.slice(8));
};
const SAMPLES = [
  { name: "demo", run: RUNS.demo, env: {}, tables: "sample/seed1003" },
  { name: "unseen3001", run: RUNS.unseen, env: { L1_SAMPLE_DIR: path.join(ROOT, "sample/unseen3001/full"), L1_USL_NAME: "unseen3001_records" }, tables: "sample/unseen3001/full" },
];
const results = new Map(SAMPLES.map((s) => [s.name, replay(s.env)]));

for (const s of SAMPLES) {
  test(`${s.name}: the screen's conclusions (replay of run ${s.run} with the shipped code) equal the live run's, before any approval`, () => {
    const live = JSON.parse(readFileSync(path.join(ROOT, traceFile(s.name, s.run, "items_at_review.json")), "utf8")) as { lane: string; column: string; synthetic?: boolean }[];
    const shown = results.get(s.name).itemsAtReview as { lane: string; column: string; synthetic: boolean }[];
    assert.deepEqual(shown.map((i) => `${i.lane}:${i.column}:${i.synthetic}`).sort(), live.map((i) => `${i.lane}:${i.column}:${!!i.synthetic}`).sort());
  });

  test(`${s.name}: a SYNTHETIC or COMPOSITE mark anywhere in a data row reaches the lane, the item, the trace and the counsel export`, () => {
    // every (site, case) of a log row, and every OSHA report id, whose raw row carries the mark in any column
    const marked = new Set<string>();
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".csv") ? [path.join(d, e.name)] : []));
    for (const f of walk(path.join(ROOT, s.tables))) for (const row of readFileSync(f, "utf8").split(/\r?\n/).slice(1)) {
      if (!/SYNTHETIC|COMPOSITE CASE/.test(row)) continue;
      const sir = row.match(/^(SIR-[A-Z0-9]+),/)?.[1];
      if (sir) { marked.add(sir); continue; }
      const site = row.match(/Site-[0-9A-F]{4}/)?.[0];
      for (const cell of row.split(",")) if (site && cell && cell !== site) marked.add(`${site}|${cell.trim()}`);
    }
    const trail = results.get(s.name).syntheticTrail as { lane: string; site?: string; case_id?: string; report?: string; lane_synthetic: boolean; item_synthetic: boolean; trace: boolean; export: boolean }[];
    const own = trail.filter((t) => (t.report && marked.has(t.report)) || (t.site && t.case_id && marked.has(`${t.site}|${t.case_id}`)));
    assert.ok(own.length >= 2, `found ${own.length} marked lanes`);
    for (const t of own) assert.deepEqual({ lane: t.lane_synthetic, item: t.item_synthetic, trace: t.trace, export: t.export }, { lane: true, item: true, trace: true, export: true }, t.lane);
  });
}

test("README: every number and case block equals what scripts/readme_numbers.ts computes from the runs it names", () => {
  const p = spawnSync(process.execPath, ["--no-warnings", "--import", "tsx", "scripts/readme_numbers.ts", "--check"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(p.status, 0, "README out of date: run node --no-warnings --import tsx scripts/readme_numbers.ts\n" + p.stdout.slice(-800) + p.stderr.slice(-400));
});

test("each published trace holds exactly the one run its name says", () => {
  for (const [name, id] of [["demo", RUNS.demo], ["unseen3001", RUNS.unseen], ["unseen3001_layer1", RUNS.layer1]]) {
    const ev = readFileSync(path.join(ROOT, traceFile(name, id, "trace.jsonl")), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual([...new Set(ev.map((e) => e.run))], [id], name);
    assert.equal(ev.filter((e) => e.seq === 1).length, 1, name);
  }
});

for (const s of SAMPLES) {
  test(`${s.name}: a decision the Verifier refused is not "supported" in the explanations shown for that lane`, () => {
    for (const e of results.get(s.name).explanations as { lane: string; state: string; refused: string[]; hyps: Record<string, string> }[]) {
      if (e.refused.includes("different")) for (const h of ["different_injury", "wrong_site"]) assert.notEqual(e.hyps[h], "supported", `${e.lane} ${h}`);
      if (e.refused.includes("same") && e.state !== "linked") assert.notEqual(e.hyps.written_differently, "supported", `${e.lane} written_differently`);
    }
  });
  test(`${s.name}: even after every identity is approved, each "not in the log" / "not found" conclusion is a SYNTHETIC record`, () => {
    for (const i of results.get(s.name).finalItems as { lane: string; column: string; synthetic: boolean }[])
      if (i.column === "not_in_log" || i.column === "not_found") assert.ok(i.synthetic, i.lane);
  });
  test(`${s.name}: a person is never said to be chosen by the Planner when the Planner still asked for research`, () => {
    for (const e of results.get(s.name).escalations as { lane: string; agent: string; summary: string }[])
      if (e.agent === "planner") assert.ok(!/still wanted/.test(e.summary) || /round limit/i.test(e.summary), e.summary);
  });
}

test("a round-limit escalation is the system's, never labelled as an agent's decision", () => {
  for (const name of ["demo", "unseen3001"])
    for (const e of results.get(name).escalations as { lane: string; agent: string; summary: string }[])
      assert.equal(/round limit/i.test(e.summary), e.agent === "system", `${name} ${e.lane}: ${e.agent} — ${e.summary}`);
});

for (const s of SAMPLES) {
  test(`${s.name}: every "OSHA's report says less than the log" conclusion is a SYNTHETIC record`, () => {
    for (const i of results.get(s.name).items as { lane: string; synthetic: boolean; osha_less: boolean }[]) if (i.osha_less) assert.ok(i.synthetic, i.lane);
  });
}

for (const s of SAMPLES) {
  test(`${s.name}: a lane's conclusion and its explanations agree (no match <-> not "written differently"; linked <-> not "a different injury")`, () => {
    for (const e of results.get(s.name).explanations as { lane: string; state: string; hyps: Record<string, string> }[]) {
      if (e.state === "no_match") assert.notEqual(e.hyps.written_differently, "supported", `${e.lane}: no match, yet 'written differently' supported`);
      if (e.state === "linked") assert.notEqual(e.hyps.different_injury, "supported", `${e.lane}: linked, yet 'a different injury' supported`);
    }
  });
}
