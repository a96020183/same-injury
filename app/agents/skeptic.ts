// Skeptic: an independent agent that trusts no citation. After matching, it re-runs every run_sql that a conclusion
// cites, with the same Zetaris identity, and checks the rows are the ones the conclusion was built on (order-free hash).
// A mismatch sends that lane back to the Evaluator. In SAMPLE_MODE the re-run is served by the same recording, and the
// result says so.
import type { Ctx } from "./ctx.ts";
import type { Lane, Matcher } from "./matching.ts";

export type SkepticResult = { rerun: number; match: number; mismatched: string[]; backend: string; lanesBack: string[] };

export async function skeptic(ctx: Ctx, matcher: Matcher): Promise<SkepticResult> {
  const { sql, trace } = ctx;
  const cited = new Map<string, Lane[]>();
  for (const l of matcher.lanes) {
    if (l.state === "open" || l.state === "not_ours") continue;
    const qids = [...l.searched.map((s) => s.qid), ...(l.hypotheses ?? []).flatMap((h) => h.qids)].filter(Boolean) as string[];
    for (const qid of new Set(qids)) cited.set(qid, [...(cited.get(qid) ?? []), l]);
  }
  trace.emit({ agent: "skeptic", kind: "plan", summary: `Re-running the ${cited.size} queries the conclusions cite, as the same identity.` });
  const before = new Map(sql.receipts.map((r) => [r.qid, r]));
  let match = 0;
  const mismatched: string[] = [], back = new Set<Lane>(), backends = new Set<string>();
  for (const [qid] of cited) {
    const orig = before.get(qid);
    if (!orig || orig.error) continue;
    const r = await sql.run(orig.sql, `re-check ${qid}: ${orig.purpose}`, "skeptic", { admin: orig.as === "admin" });
    backends.add(r.receipt.backend);
    if (r.ok && r.receipt.rowsSha === orig.rowsSha) match++;
    else { mismatched.push(qid); for (const l of cited.get(qid) ?? []) back.add(l); }
  }
  const rerun = match + mismatched.length;
  const backend = [...backends].join("/") || "none";
  trace.emit({ agent: "skeptic", kind: mismatched.length ? "reject" : "approve",
    summary: `${rerun} citations re-run · ${match} match${backend === "replay" ? " (replayed from the recording)" : ""}.${mismatched.length ? ` Different rows: ${mismatched.join(", ")}.` : ""}` });
  for (const l of back) {
    l.notes.push(`A cited query returned different rows when the Skeptic re-ran it; the Evaluator judged again.`);
    trace.emit({ agent: "skeptic", kind: "reject", lane: l.id, summary: "A citation did not reproduce. Back to the Evaluator." });
    await matcher.redecide(l);
  }
  return { rerun, match, mismatched, backend, lanesBack: [...back].map((l) => l.id) };
}
