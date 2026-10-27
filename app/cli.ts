// Headless run: `npm run demo`. The two human gates are taken by an operator flag so a judge can see the whole loop
// in one command; the trace records them as "operator (CLI --approve-all, automatic)", never as an agent decision or
// as a review. The results a person would act on are the ones before that flag (items_at_review.json in the run folder).
//   --approve-all     approve the USL draft and every merge proposal, automatically and without looking
//   --record          (live only) append Zetaris answers and model replies to the sample cassettes
//   --live            use the live local Zetaris even if SAMPLE_MODE=true
import { Run } from "./run.ts";
import { COLUMN_TITLE } from "./agents/final.ts";

const args = new Set(process.argv.slice(2));
const run = new Run({ record: args.has("--record"), sqlMode: args.has("--live") ? "live" : undefined });
const t0 = Date.now();
const short = (s: string) => (s.length > 150 ? s.slice(0, 147) + "…" : s);
run.trace.on((e) => {
  if (["sql"].includes(e.kind) && e.agent === "discovery") return;
  console.log(`${String(e.seq).padStart(4)} ${e.agent.padEnd(9)} ${e.kind.padEnd(10)} ${e.lane ? e.lane.padEnd(4) : "    "} ${short(e.summary)}`);
});

await run.start();
if (run.phase !== "awaiting_usl") { console.error("discovery failed:", run.error); process.exit(1); }
console.log("\n--- USL draft waiting for an administrator ---\n" + run.discovery!.usl!.compile.split("\n").slice(0, 3).join("\n") + "\n…");
if (!args.has("--approve-all")) { console.log("\nStopped at the USL gate. Re-run with --approve-all, or use the web UI (npm start)."); process.exit(0); }
await run.approveUsl("operator (CLI --approve-all, automatic)");
if (run.phase !== "review") { console.error("matching failed:", run.error); process.exit(1); }
for (const p of run.ctx.world.wm.mergeQueue().filter((x) => x.status === "pending")) {
  try { await run.reviewerView(p.id); } catch { /* proposal without a report row */ }
  await run.decideMerge(p.id, true, "operator (CLI --approve-all, automatic: not a review)");
}
if (args.has("--record") && run.ctx.sql.mode === "live") {
  // where Zetaris runs the federated candidate-map query (EXPLAIN is an administrator command)
  const cm = run.ctx.sql.receipts.find((r) => r.purpose.startsWith("candidate map"));
  if (cm) {
    const ex = await run.ctx.sql.run("EXPLAIN QUERY AS " + cm.sql, "where Zetaris runs the candidate-map query", "planner", { admin: true });
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync("docs", { recursive: true });
    writeFileSync("docs/explain_candidate_map.txt", `-- ${cm.qid}, run ${run.id}\n${cm.sql}\n\n-- EXPLAIN QUERY (administrator)\n` + ex.result.data.map((r) => r.join("\t")).join("\n") + "\n");
    console.log("EXPLAIN saved: docs/explain_candidate_map.txt", ex.ok ? "" : ex.receipt.error);
  }
}

console.log("\n=== Result ===");
for (const dir of ["log", "osha"] as const) {
  console.log(dir === "log" ? "\nPlant log → OSHA" : "\nOSHA → plant log");
  for (const i of run.state().items.filter((x) => x.dir === dir)) console.log( // through the output gate (app/gate.ts)
    `  ${i.lane.padEnd(4)} ${COLUMN_TITLE[i.column].padEnd(34)} ${i.site ?? ""} ${i.date ?? ""}  ${i.headline}`);
}
const st = run.state();
if (st.withheld.count) console.log(`  ${st.withheld.note}`);
console.log(`\nqueries ${st.counts.receipts} · trace events ${st.counts.events} · world events ${st.counts.worldEvents} · models ${JSON.stringify(st.models.calls)}`);
console.log(`run folder: ${run.dir} (trace.jsonl, receipts.json, items.json, world_log.json, counsel_export.html) · ${Math.round((Date.now() - t0) / 1000)} s`);
