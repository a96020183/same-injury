// One run on a sample folder (L1_SAMPLE_DIR), both human gates taken by the operator flag, then a JSON summary of the
// second layer: every lane's outcome and the decision path of the lanes named in L1_WATCH (site codes, comma separated).
// Used by scripts/variants.ts; works with no keys (emulator + the agents' labelled rule stubs) or with recordings.
const { Run } = await import("../app/run.ts");
const r = new Run({ record: process.env.L1_RECORD === "1" });
await r.start();
if (r.phase !== "awaiting_usl") { console.log(JSON.stringify({ error: r.error })); process.exit(1); }
await r.approveUsl("operator (variants)");
for (const p of r.ctx.world.wm.mergeQueue().filter((x) => x.status === "pending")) await r.decideMerge(p.id, true, "operator (variants)");
const watch = (process.env.L1_WATCH ?? "").split(",").filter(Boolean);
const lanes = r.matcher!.lanes.filter((l) => l.state !== "not_ours");
const ev = r.trace.events;
const { renderExport } = await import("../app/export.ts");
const exportHtml = renderExport(r);
const out = {
  // what the agents concluded before the operator flag approved anything, and where each SYNTHETIC mark shows up
  itemsAtReview: (r.itemsAtReview ?? []).map((i) => ({ lane: i.lane, column: i.column, synthetic: !!i.synthetic })),
  // what each lane's explanations say, next to the decisions the Verifier refused
  explanations: r.matcher!.lanes.filter((l) => l.hypotheses).map((l) => ({ lane: l.id, state: l.state, refused: l.verifier.map((x) => x.verdict),
    hyps: Object.fromEntries((l.hypotheses ?? []).map((h) => [h.h, h.status])), notes: l.notes })),
  finalItems: r.items.map((i) => ({ lane: i.lane, column: i.column, synthetic: !!i.synthetic })),
  escalations: ev.filter((e) => e.kind === "escalate").map((e) => ({ lane: e.lane, agent: e.agent, summary: e.summary })),
  syntheticTrail: r.matcher!.lanes.filter((l) => l.state !== "not_ours").map((l) => ({ lane: l.id, site: l.log?.site ?? l.site?.code, case_id: l.log?.case_id, report: l.report?.id, lane_synthetic: !!l.synthetic,
    item_synthetic: !!r.items.find((i) => i.lane === l.id)?.synthetic,
    trace: ev.some((e) => e.lane === l.id && e.kind === "info" && /SYNTHETIC|composite/i.test(e.summary)),
    export: exportHtml.includes(`data-lane="${l.id}"><div class="h"><span class="syn">`),
    log_text: (l.log?.text ?? "").slice(0, 80), report_text: (l.report?.text ?? "").slice(0, 80) })),
  items: r.items.map((i) => {
    const l = r.matcher!.lanes.find((x) => x.id === i.lane);
    const site = r.matcher!.sites.find((x) => x.code === i.site);
    // the same fields as an item of the app (QA round 10: the output gate gates it like any item), plus what the scan needs
    return { ...i, synthetic: !!i.synthetic, report: i.reportId, state: site?.state, osha_less: i.differences.some((d) => /does not flag an amputation/i.test(d)),
      body: `${l?.log?.body ?? ""} ${l?.log?.text ?? ""} ${l?.report?.body ?? ""} ${l?.report?.text ?? ""}`.slice(0, 400) };
  }),
  watched: lanes.filter((l) => watch.includes(l.site?.code ?? "")).map((l) => ({
    lane: l.id, site: l.site?.code, state: l.state,
    path: ev.filter((e) => e.lane === l.id && (["approve", "reject", "replan", "escalate", "branch", "fallback"].includes(e.kind) || (e.agent === "research" && e.kind === "sql") || (e.agent === "evaluator" && e.kind === "verdict" && !/explanations/.test(e.summary))))
      .map((e) => `${e.agent}:${e.kind} ${e.summary.slice(0, 110)}`),
  })),
  counts: {
    model: ev.filter((e) => e.kind === "model").length, evaluatorRejects: ev.filter((e) => e.agent === "evaluator" && e.kind === "reject").length,
    verifierRejects: ev.filter((e) => e.agent === "verifier" && e.kind === "reject").length, replans: ev.filter((e) => e.kind === "replan").length,
    escalations: ev.filter((e) => e.kind === "escalate").length,
  },
  models: [...new Set(r.ctx.models.calls.map((c) => c.source))],
  // every lane that could end as a conclusion (scan_identity checks them all, not only this run's items)
  lanes: r.matcher!.lanes.filter((l) => l.state !== "not_ours" && l.site).map((l) => ({ lane: l.id, site: l.site!.code, state: l.site!.state, date: l.log?.date ?? l.report?.date,
    body: `${l.log?.body ?? ""} ${l.log?.text ?? ""} ${l.report?.body ?? ""} ${l.report?.text ?? ""}`.slice(0, 400) })),
  modelCalls: r.ctx.models.calls.length, liveCalls: r.ctx.models.calls.filter((c) => c.source === "live").length,
  verifierLanes: r.matcher!.lanes.filter((l) => l.verifier.length).map((l) => ({ lane: l.id, site: l.site?.code, state: l.state, synthetic: l.syntheticKind,
    path: ev.filter((e) => e.lane === l.id && (["approve", "reject", "replan", "escalate", "fallback", "branch"].includes(e.kind) || (e.agent === "research" && e.kind === "sql") || (e.agent === "evaluator" && e.kind === "verdict" && !/explanations/.test(e.summary))))
      .map((e) => ({ agent: e.agent, kind: e.kind, summary: e.summary.slice(0, 220), receipts: e.receipts ?? [] })) })),
  // the receipts those paths cite, so the replay screen can open each one
  receipts: Object.fromEntries(r.ctx.sql.receipts.filter((x) => r.matcher!.lanes.some((l) => l.verifier.length && ev.some((e) => e.lane === l.id && (e.receipts ?? []).includes(x.qid))))
    .map((x) => [x.qid, x])),
};
console.log("@@RESULT" + JSON.stringify(out));
