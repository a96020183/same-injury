// Counsel export: a printable HTML file. Every item shows where the agents searched and the query IDs; the appendix
// lists each query with its SQL, backend and result hash, the World Model approvals, and the models that answered.
import type { Run } from "./run.ts";
import { COLUMN_TITLE, certifySummary, distinctItems, nextSteps, type Column, type Item } from "./agents/final.ts";
import { HYP_LABEL } from "./agents/hypotheses.ts";
import { gateItems } from "./gate.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function renderExport(run: Run): string {
  // the output gate (app/gate.ts): a real plant is shown only as found, written differently or State Plan
  const { items } = gateItems(run.items);
  const { withheld } = gateItems(distinctItems(run.items)); // one injury counts once, as in the certify table
  const logCols: Column[] = ["reported", "reported_differs", "not_required", "not_found", "outside", "pending", "review"];
  const oshaCols: Column[] = ["in_log", "in_log_differs", "not_in_log", "pending", "review"];
  const section = (title: string, dir: "log" | "osha", cols: Column[]) => {
    const own = items.filter((i) => i.dir === dir);
    return `<h2>${esc(title)}</h2>` + cols.filter((c) => own.some((i) => i.column === c)).map((c) =>
      `<h3>${esc(COLUMN_TITLE[c])} <span class="n">${own.filter((i) => i.column === c).length}</span></h3>` +
      own.filter((i) => i.column === c).map(card).join("")).join("");
  };
  const card = (i: Item) => `<div class="item" data-lane="${esc(i.lane)}"><div class="h">${i.synthetic ? `<span class="syn">${i.syntheticKind === "composite" ? "Composite modeled on a public pattern" : "SYNTHETIC test record"}</span> ` : ""}<b>${esc(i.lane)} · ${esc(i.plantName || i.site)}</b> · ${esc(i.date)} · ${esc(i.headline)}</div>
    ${(i.verifier ?? []).map((x) => `<div class="d">Verifier, round ${x.round} (Evaluator said ${esc(x.verdict)}): ${esc(x.objection)}</div>`).join("")}
    ${i.detail.map((d) => `<div class="d">${esc(d)}</div>`).join("")}
    ${i.evaluator ? `<div class="d">Evaluator: ${esc(i.evaluator)}</div>` : ""}
    ${i.hypotheses?.length ? `<div class="hyp">Explanations weighed:<ul>${i.hypotheses.map((h) => `<li><b>${esc(h.status.replace(/_/g, " "))}</b> · ${esc(HYP_LABEL[h.h](i.dir))}: ${esc(h.why)}${h.qids.length ? ` <code>${h.qids.map(esc).join(" ")}</code>` : ""}</li>`).join("")}</ul></div>` : ""}
    <div class="path">${i.searched.map((s) => `${esc(s.label)}${s.found != null ? ` (${s.found})` : ""}${s.qid ? ` <code>${esc(s.qid)}</code>` : ""}`).join(" → ")}</div></div>`;
  const receipts = run.ctx.sql.receipts.map((r) => `<tr><td><code>${esc(r.qid)}</code></td><td>${esc(r.agent)}</td><td>${esc(r.backend)}</td><td>${r.rows}</td><td><code>${esc(r.resultSha)}</code></td><td><pre>${esc(r.sql)}</pre></td></tr>`).join("");
  const approvals = run.ctx.world.wm.audit().filter((a) => a.kind === "alias" || a.kind === "merge-rejected").map((a) => `<li>${esc(a.at)} · ${esc(a.actor)} · ${esc(a.summary)}</li>`).join("");
  const models = run.ctx.models.calls.reduce((m, c) => m.set(`${c.lane} · ${c.source} · ${c.served}`, (m.get(`${c.lane} · ${c.source} · ${c.served}`) ?? 0) + 1), new Map<string, number>());
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Same Injury — counsel export</title>
<style>body{font:14px/1.5 Georgia,serif;color:#1d1d1b;max-width:900px;margin:40px auto;padding:0 20px}h1{font-weight:400;font-size:28px;margin:0}
.flag{display:inline-block;border:1px solid #8a2b1a;color:#8a2b1a;padding:2px 8px;font:12px/1.4 system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;margin:12px 0}
h2{font-weight:400;border-bottom:1px solid #ccc;padding-bottom:4px;margin-top:40px}h3{font:600 13px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.05em;color:#555}
.syn{font:600 10px system-ui,sans-serif;letter-spacing:.08em;color:#fff;background:#8a2b1a;padding:2px 6px;margin-right:6px}.hyp{font:12px system-ui,sans-serif;color:#444;margin-top:4px}.hyp ul{margin:2px 0 0 18px;padding:0}.n{color:#999}.item{border-left:2px solid #ddd;padding:6px 12px;margin:10px 0}.d{color:#444}.path{font:12px system-ui,sans-serif;color:#777;margin-top:4px}
code{font:11px ui-monospace,monospace;background:#f3f1ec;padding:0 3px}table{border-collapse:collapse;font:11px system-ui,sans-serif;width:100%}td{border-top:1px solid #eee;padding:4px;vertical-align:top}
pre{white-space:pre-wrap;margin:0;font:10px ui-monospace,monospace;max-height:120px;overflow:auto}.muted{color:#777;font:12px system-ui,sans-serif}</style></head><body>
<div class="flag">Prepared for counsel review</div> <span class="muted">A label does not create privilege; counsel decides how this file is handled.</span>
<h1>Serious injuries: plant logs and OSHA reports</h1>
${run.skeptic ? `<p class="muted">Skeptic: ${run.skeptic.rerun} cited queries re-run · ${run.skeptic.match} match${run.skeptic.backend === "replay" ? " (replayed from the recording)" : ""}.</p>` : ""}
<p class="muted">Run ${esc(run.id)} · data ${esc(run.ctx.sql.mode === "sample" ? "SAMPLE_MODE (recorded Zetaris answers)" : "live Zetaris")} · Public OSHA records of four companies, re-sharded into four systems; employer identity masked by Zetaris policy for the agents. Reply letters are synthetic.
This list says where the agents searched and what they found. It does not say whether anyone was required to report or failed to.</p>
<h2>Before you certify the 300A</h2>${certifySummary(run.items, run.yearly).length ? `<table><tr><td>Plant</td><td>Add to the log</td><td>Written differently</td><td>For counsel</td><td>State Plan records</td><td>Waiting for a person</td><td>Counts vs 300A</td></tr>${certifySummary(run.items, run.yearly).map((r) => r.hidden ? `<tr><td colspan="7" class="muted">${esc(r.plant)}</td></tr>` : `<tr><td>${esc(r.plant)} <code>${esc(r.site)}</code>${r.synthetic ? ' <span class="syn">SYNTHETIC plant</span>' : ""}</td><td>${r.add || ""}</td><td>${r.review || ""}</td><td>${r.counsel || ""}</td><td>${r.statePlan || ""}</td><td>${r.pending || ""}</td><td>${esc(r.totals ?? "")}</td></tr>`).join("")}</table>` : "<p>Nothing to add, review or send to counsel.</p>"}
<h2>Next steps</h2><ol>${nextSteps(run.items, run.yearly).map((s) => `<li><b>${esc(s.title)}</b>${s.count ? ` (${s.count})` : ""}. ${esc(s.what)} <span class="muted">Who: ${esc(s.who)} · When: ${esc(s.when)}${s.cite ? ` · ${esc(s.cite)}` : ""}</span></li>`).join("")}</ol>
<p class="muted">Deadlines quote 29 CFR 1904. This is a checklist, not legal advice.</p>
${withheld.count ? `<p class="muted">${esc(withheld.note)}</p>` : ""}
${section("Plant log → OSHA", "log", logCols)}
${section("OSHA → plant log", "osha", oshaCols)}
<h2>Identity decisions (World Model)</h2><ul>${approvals || "<li>None yet.</li>"}</ul>
<h2>Models</h2><ul>${[...models.entries()].map(([k, n]) => `<li>${esc(k)} × ${n}</li>`).join("") || "<li>None.</li>"}</ul>
<h2>Queries</h2><table><tr><td>ID</td><td>Agent</td><td>Backend</td><td>Rows</td><td>Result hash</td><td>SQL</td></tr>${receipts}</table>
</body></html>`;
}
