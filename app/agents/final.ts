// Final + Risk. Conclusions are read from the World Model at the moment they are shown, so a person's approval in the
// merge queue changes both directions at once. The Risk agent screens every sentence that came from a model.
import type { Ctx } from "./ctx.ts";
import { placesSearched, type Lane } from "./matching.ts";
import type { Hypothesis } from "./hypotheses.ts";
import { riskCheck, REG } from "../rules.ts";
import { gateItems, gateYearly, isReal, plantLevel } from "../gate.ts";

export type Column = "reported" | "reported_differs" | "not_required" | "not_found" | "outside" | "pending" | "review" | "in_log" | "in_log_differs" | "not_in_log";
export type Item = {
  lane: string; dir: "log" | "osha"; column: Column; headline: string; detail: string[]; site?: string; plantName?: string; date?: string;
  reportId?: string; logKey?: string; caseId?: string; proposalId?: string; differences: string[]; cite?: string;
  searched: { label: string; qid?: string; found: number }[]; receipts: string[]; evaluator?: string; hypotheses?: Hypothesis[]; basis?: "linked" | "no_match"; synthetic?: boolean; syntheticKind?: string; verifier?: { round: number; verdict: string; objection: string }[];
};

export const COLUMN_TITLE: Record<Column, string> = {
  reported: "Reported — OSHA has it", reported_differs: "Reported — written differently", not_required: "May not need a report", not_found: "No matching report found in this sample (composite company)", outside: "State Plan state — its own records, outside OSHA's federal file",
  pending: "Waiting for your review", review: "Needs a person", in_log: "In the log", in_log_differs: "In the log, written differently", not_in_log: "Not found in this company's log sample",
};

export function buildItems(ctx: Ctx, lanes: Lane[]): Item[] {
  const { world, trace } = ctx;
  const items: Item[] = [];
  for (const l of lanes) {
    if (l.state === "not_ours" || l.state === "open") continue;
    const receipts = [...new Set(l.searched.map((s) => s.qid).filter(Boolean) as string[])];
    const base = { lane: l.id, dir: l.dir, site: l.site?.code, plantName: l.site?.plant_name, searched: l.searched.map(({ label, qid, found }) => ({ label, qid, found })), receipts, differences: [...l.differences], hypotheses: l.hypotheses?.map((h) => ({ ...h, why: screen(ctx, l.id, h.why) })), synthetic: l.synthetic, syntheticKind: l.syntheticKind, verifier: l.verifier };
    const lastV = l.verdicts.at(-1);
    const evaluator = lastV ? screen(ctx, l.id, lastV.reason) : undefined;
    const searchedLine = `Searched ${placesSearched(l)} places; see the path below.`;
    // the World Model is shared: a same-injury link found from the other direction counts here too
    if (l.dir === "log" && l.state !== "linked" && l.state !== "not_covered") {
      const other = world.reportsLinkedTo(l.log!.key)[0];
      if (other) { l.state = "linked"; l.linkedReport = other; l.notes.push("Linked from OSHA's side (shared World Model)."); }
    }
    if (l.dir === "osha" && l.state === "no_match") {
      const other = world.logsLinkedTo(l.report!.id)[0];
      if (other) { l.state = "linked"; l.linkedLog = other; l.notes.push("Linked from the log's side (shared World Model)."); }
    }
    if (l.dir === "log") {
      const lc = l.log!;
      const common = { ...base, date: lc.date, logKey: lc.key, caseId: lc.case_id, evaluator };
      if (l.state === "not_covered") items.push({ ...common, column: "outside", headline: `${l.site?.state} runs a State Plan, which keeps its own records`,
        detail: ["The State Plan's own records were not part of this run.", REG.statePlan, searchedLine] });
      else if (l.state === "excluded") items.push({ ...common, column: "not_required", headline: l.exclusion!.why, detail: [l.exclusion!.cite, "Counsel to confirm."], cite: l.exclusion!.cite });
      else if (l.state === "needs_review") items.push({ ...common, column: "review", reportId: l.cands.find((c) => c.tier !== "not_ours")?.report.id,
        headline: "The agents could not settle it", detail: [...l.notes.map((n) => screen(ctx, l.id, n)), searchedLine] });
      else if (l.state === "linked") {
        const ok = world.employerIsSite(l.linkedReport!, l.site!.code);
        const p = ok ? undefined : pendingProposal(ctx, l.linkedReport!);
        if (!ok && !p) { items.push({ ...common, reportId: l.linkedReport, column: "review", headline: `OSHA report ${l.linkedReport}: identity rejected`, detail: ["A person said OSHA's employer is not this plant. Counsel to review."] }); continue; }
        items.push({ ...common, reportId: l.linkedReport, proposalId: p, basis: "linked", column: ok ? (l.differences.length ? "reported_differs" : "reported") : "pending",
          headline: ok ? `OSHA report ${l.linkedReport}` : `Likely OSHA report ${l.linkedReport}`,
          detail: [ok ? "A person approved the employer identity." : "Becomes a conclusion only after you approve the identity.", ...l.differences.map((d) => "Written differently: " + screen(ctx, l.id, d)), ...l.notes] });
      } else items.push({ ...common, column: "not_found", headline: "No matching report found in this sample (composite company)", detail: [searchedLine, ...l.notes] });
    } else {
      const rep = l.report!;
      const common = { ...base, date: rep.date, reportId: rep.id, evaluator };
      if (l.state === "needs_review") items.push({ ...common, column: "review", logKey: l.cands.find((c) => c.tier !== "not_ours")?.log?.key, headline: "The agents could not settle it", detail: [...l.notes.map((n) => screen(ctx, l.id, n)), searchedLine] });
      else if (l.state === "linked") {
        const ok = world.employerIsSite(rep.id, l.site!.code);
        const p = ok ? undefined : pendingProposal(ctx, rep.id);
        const differs = l.differences.length > 0;
        if (!ok && !p) { items.push({ ...common, logKey: l.linkedLog, column: "review", headline: "Identity rejected", detail: ["A person said OSHA's employer is not this plant."] }); continue; }
        items.push({ ...common, logKey: l.linkedLog, proposalId: p, basis: "linked", column: !ok ? "pending" : differs ? "in_log_differs" : "in_log",
          headline: `${l.site!.code} log, case ${l.linkedLog!.split(":").at(-1)}`,
          detail: [...(ok ? [] : ["Becomes a conclusion only after you approve the identity."]), ...l.differences.map((d) => "Differs: " + screen(ctx, l.id, d))] });
      } else if (l.state === "no_match") {
        const ok = world.employerIsSite(rep.id, l.site!.code);
        const proposalId = ok ? undefined : pendingProposal(ctx, rep.id);
        if (!l.synthetic) {
          // a published OSHA report is never concluded "not in the log" by the agents: a person reads the log for it
          items.push({ ...common, proposalId, column: "review", headline: "No matching log line found: a person checks the log",
            detail: [`The agents found no log line for this report at ${l.site!.code}${ok ? "" : " (the employer identity also waits for the reviewer)"}. On a published record this stays with a person; it is never a "not in the log" conclusion.`, searchedLine] });
        } else items.push({ ...common, proposalId, basis: "no_match", column: ok ? "not_in_log" : "pending",
          headline: ok ? "Not found in this company's log sample" : "Is OSHA's employer at this address this company? Waiting for your review",
          detail: [...(ok ? [] : ["The agents see the employer masked; only the reviewer sees the name. If it is this company, the report is not in its log sample."]), searchedLine] });
      }
    }
  }
  trace.emit({ agent: "final", kind: "conclusion", summary: `List rebuilt from the World Model: ${items.length} items, ${items.filter((i) => i.column === "pending").length} waiting for review.` });
  const g = guardStats.get(ctx) ?? { screened: 0, rewritten: 0, reported: -1 };
  if (g.screened !== g.reported) {
    trace.emit({ agent: "risk", kind: g.rewritten ? "blocked" : "approve", summary: `Wording guard: ${g.screened} model-written sentences screened, ${g.rewritten} rewritten.` });
    g.reported = g.screened; guardStats.set(ctx, g);
  }
  return items;
}

function pendingProposal(ctx: Ctx, reportId: string) {
  const emp = ctx.world.employerOf(reportId);
  return emp ? ctx.world.wm.mergeQueue().find((p) => p.status === "pending" && p.leftId === emp.id)?.id : undefined;
}

const screenedBy = new WeakMap<Ctx, Map<string, string>>();
const guardStats = new WeakMap<Ctx, { screened: number; rewritten: number; reported: number }>();
/** Risk agent: model-written sentences pass only in neutral words. */
function screen(ctx: Ctx, lane: string, text: string): string {
  if (!screenedBy.has(ctx)) screenedBy.set(ctx, new Map());
  const screened = screenedBy.get(ctx)!;
  const k = lane + "|" + text;
  if (screened.has(k)) return screened.get(k)!;
  const r = riskCheck(text);
  const g = guardStats.get(ctx) ?? { screened: 0, rewritten: 0, reported: -1 };
  g.screened++; if (!r.ok) g.rewritten++; guardStats.set(ctx, g);
  if (!r.ok) ctx.trace.emit({ agent: "risk", kind: "blocked", lane, summary: `Blocked wording "${r.hits.join('", "')}". Rewritten in neutral terms.`, detail: { before: text, after: r.rewritten } });
  screened.set(k, r.rewritten);
  return r.rewritten;
}

/** one injury seen from both directions is one item: the pair (report|log) is the key, or the identity for a pending item */
const pairKey = (i: Item) => (i.column === "pending" && i.proposalId ? `p:${i.proposalId}` : `${i.reportId ?? ""}|${i.logKey ?? i.lane}`);
export function distinctItems(items: Item[]): Item[] {
  const seen = new Set<string>();
  return items.filter((i) => { const k = `${i.column === "pending" ? "pending" : i.column.replace(/^in_log_differs$/, "reported_differs").replace(/^in_log$/, "reported")}|${pairKey(i)}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Before the 300A is certified: what to add to the log, what to review, what goes to counsel, per site. */
export function certifySummary(all: Item[], yearly: { site: string; log: number; summary: number }[] = []) {
  // the output gate: a real plant is listed only with neutral results; everything else is counted in the last row
  const gated = gateItems(distinctItems(all)), gy = gateYearly(yearly);
  const items = gated.items;
  const by = new Map<string, { site: string; plant: string; add: number; review: number; counsel: number; statePlan: number; pending: number; totals?: string; synthetic?: boolean; hidden?: number }>();
  for (const y of gy.named) by.set(y.site, { site: y.site, plant: y.site, add: 0, review: 0, counsel: 0, statePlan: 0, pending: 0, totals: `log ${y.log} / 300A ${y.summary}`, synthetic: true });
  for (const i of items) {
    if (!i.site) continue;
    const r = by.get(i.site) ?? { site: i.site, plant: i.plantName ?? i.site, add: 0, review: 0, counsel: 0, statePlan: 0, pending: 0 };
    if (i.plantName) r.plant = i.plantName;
    if (!isReal(i.site)) r.synthetic = true;
    const oshaLess = i.differences.some((d) => /OSHA's report does not flag an amputation/i.test(d));
    if (i.column === "not_in_log") r.add++;
    if ((i.column === "in_log_differs" || i.column === "reported_differs") && !oshaLess) r.review++;
    if (i.column === "not_found" || i.column === "review" || ((i.column === "in_log_differs" || i.column === "reported_differs") && oshaLess)) r.counsel++;
    if (i.column === "outside") r.statePlan++;
    if (i.column === "pending") r.pending++;
    by.set(i.site, r);
  }
  const rows = [...by.values()].filter((r) => r.add + r.review + r.counsel + r.statePlan + r.pending > 0 || r.totals).sort((a, b) => a.site.localeCompare(b.site));
  // what the real-plant gate hides is one line, with its number, not a row of empty columns (QA round 12)
  const counted = gated.withheld.count + gy.realCount;
  if (counted) rows.push({ site: "", plant: `Real plants: ${gated.withheld.count ? `${gated.withheld.count} result(s) hidden by the real-plant gate` : ""}${gated.withheld.count && gy.realCount ? "; " : ""}${gy.realCount ? `${gy.realCount} plant(s) whose log count differs from the 300A` : ""} (counted in Next steps, not listed by plant)`,
    add: 0, review: 0, counsel: 0, statePlan: 0, pending: 0, totals: undefined, hidden: counted });
  return rows;
}

/** What to do next, from the items. Separate from the certify table: the table says where the 300A is not ready yet;
 * these say who does what, by when, and the rule behind each deadline (29 CFR 1904). Not legal advice: counsel decides. */
export type NextStep = { key: string; title: string; count: number; who: string; what: string; when: string; cite: string };
export function nextSteps(all: Item[], yearly: { site: string; log: number; summary: number }[] = []): NextStep[] {
  const items = distinctItems(all);
  const n = (...cols: Column[]) => items.filter((i) => cols.includes(i.column)).length;
  const out: NextStep[] = [];
  // written differently: when OSHA's phone report says less than the log (no amputation flag), the log is not what to change
  const differs = items.filter((i) => i.column === "in_log_differs" || i.column === "reported_differs");
  const oshaLess = differs.filter((i) => i.differences.some((d) => /OSHA's report does not flag an amputation/i.test(d))).length;
  const addressOnly = differs.filter((i) => !i.differences.some((d) => /OSHA's report does not flag an amputation/i.test(d)) && i.differences.every((d) => /^(ZIP differs|house number differs)/.test(d))).length;
  const add = n("not_in_log"), fix = differs.length - oshaLess - addressOnly, counsel = n("not_found", "review"), pending = n("pending"), sp = n("outside");
  // a step's count includes results the real-plant gate hides; the step says how many (QA round 12)
  const hid = (...cols: Column[]) => items.filter((i) => cols.includes(i.column) && !plantLevel(i as never)).length;
  const hiddenNote = (k: number) => (k ? ` (${k} of them hidden by the real-plant gate: counted here, not listed by plant)` : "");
  if (pending) out.push({ key: "decide", title: "Decide the open identities", count: pending, who: "You (EHS records lead)",
    what: "Approve or reject each same-employer proposal above. Conclusions that depend on them stay open until you do." + hiddenNote(hid("pending")) + "", when: "Before anything below", cite: "" });
  const gy = gateYearly(yearly);
  if (yearly.length) out.push({ key: "totals", title: "Reconcile the case counts with the 300A", count: yearly.length, who: "Each plant's recordkeeper",
    what: `The log's case count differs from the yearly summary at ${[...gy.named.map((y) => `${y.site} (log ${y.log}, 300A ${y.summary})`), ...(gy.realCount ? [`${gy.realCount} real plant(s), counted only`] : [])].join(", ")}. Find the missing or extra entries before anyone certifies.`,
    when: "Before the 300A is certified", cite: "29 CFR 1904.32(a)(1)" });
  if (add) out.push({ key: "add", title: "Add the missing cases to the log", count: add, who: "Each plant's recordkeeper; you check",
    what: "Enter each OSHA-reported case on the plant's 300 log and a 301 form." + hiddenNote(hid("not_in_log")) + "", when: "Within 7 calendar days of learning of it", cite: "29 CFR 1904.29(b)(3)" });
  if (fix) out.push({ key: "fix", title: "Check which record is right", count: fix, who: "Each plant's recordkeeper, with counsel",
    what: "The log and OSHA's report disagree on the facts (body part, side, date, address). Find out which is right from the plant's own records. If the log is wrong, update it; if OSHA's report is wrong, counsel decides whether to tell OSHA. Keep both versions in the counsel file.",
    when: "While the log is kept (5 years)", cite: "29 CFR 1904.33(b)(1) (updating the stored log)" });
  if (addressOnly) out.push({ key: "address", title: "OSHA has another address for the plant", count: addressOnly, who: "You (EHS records lead)",
    what: "Only the address differs (ZIP or house number). The log has no address to correct: check the plant list, and whether OSHA should have the plant's address.",
    when: "Before the 300A is certified", cite: "" });
  if (oshaLess) out.push({ key: "osha_less", title: "OSHA's report says less than the log", count: oshaLess, who: "Corporate counsel",
    what: "The log records an amputation; the phone report to OSHA did not flag one. The log is not what to change. No 1904 rule covers amending the phone report: counsel decides whether to tell OSHA.",
    when: "Now", cite: "" });
  if (sp) out.push({ key: "state_plan", title: "Check the State Plan records", count: sp, who: "You (EHS records lead), with counsel",
    what: "Log amputations in State Plan states. A State Plan keeps its own records, which this run does not read: check them.",
    when: "Before the 300A is certified", cite: "29 CFR 1904.37(b)(2) (State Plan rules may be stricter)" });
  if (counsel) out.push({ key: "counsel", title: "Send to counsel", count: counsel, who: "Corporate counsel",
    what: "Amputations in a plant log with no OSHA report found, and cases a person must judge. An amputation is reported to OSHA within 24 hours; counsel decides what to do now. (The certify table's \"For counsel\" column also counts the \"OSHA's report says less than the log\" items.)" + hiddenNote(hid("not_found", "review")),
    when: "Now", cite: "29 CFR 1904.39(a)(2)" });
  out.push({ key: "certify", title: "Certify and post the 300A", count: 0, who: "A company executive certifies; each plant posts",
    what: "Certify each plant's yearly summary only after the steps above. Post it, and submit it electronically where the plant is required to.",
    when: "Post Feb 1 – Apr 30; submit by March 2", cite: "29 CFR 1904.32(b)(3), (b)(6); 1904.41" });
  return out;
}
