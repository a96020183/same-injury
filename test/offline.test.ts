// With no recording and no model (emulator + the agents' labelled rule stubs), a same-ZIP, same-week amputation that
// no receipt can place is never closed as "Not found": the Verifier objects to "different", and the lane goes to a person.
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(os.tmpdir(), "l1-offline-"));
cpSync("sample/seed1003", dir, { recursive: true });
for (const f of ["zetaris_cassette.jsonl", "model_cassette.jsonl"]) rmSync(path.join(dir, f), { force: true });
process.env.L1_SAMPLE_DIR = dir;
process.env.SAMPLE_MODE = "true";
process.env.L1_MODEL_OFFLINE = "true";
process.env.L1_RUNS_DIR = path.join(os.tmpdir(), "l1-test-runs");

const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { Run } = await import("../app/run.ts");

test("offline stubs: the unsettled same-ZIP pair goes to a person, marked SYNTHETIC, after Verifier objections", async () => {
  const r = new Run();
  await r.start();
  await r.approveUsl("test admin");
  assert.equal(r.phase, "review", r.error);
  const lane = r.matcher!.lanes.find((l) => l.site?.code === "Site-SYN1" && l.dir === "log")!;
  const item = r.items.find((i) => i.lane === lane.id)!;
  assert.equal(item.column, "review", "not 'Not found'");
  assert.ok(item.synthetic && lane.title.startsWith("SYNTHETIC"));
  const kinds = r.trace.events.filter((e) => e.lane === lane.id).map((e) => `${e.agent}:${e.kind}`);
  assert.ok(kinds.includes("verifier:reject") && kinds.includes("planner:replan"));
  assert.ok(kinds.some((k) => k.endsWith(":escalate")));
  assert.ok(!r.trace.events.some((e) => e.agent === "evaluator" && e.kind === "reject" && /Citation check|Verifier/.test(e.summary)), "code checks are never logged as the Evaluator");
});
