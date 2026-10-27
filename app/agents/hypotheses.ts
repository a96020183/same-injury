// Competing explanations (the "conflict critic"). When two records do not line up, the Evaluator does not just pick a
// verdict: it lists every explanation that could account for the mismatch and supports or rules out each one with the
// run_sql receipts in the lane. The statuses come from the data the lane gathered (and from the Evaluator's own
// reading when it was asked); nothing here is fixed per case. The trace and the counsel export show the reasons.
import type { Lane } from "./matching.ts";

export type HypKey = "written_differently" | "different_injury" | "wrong_site" | "state_plan" | "excluded" | "not_found";
export type HypStatus = "supported" | "ruled_out" | "not_ruled_out";
export type Hypothesis = { h: HypKey; status: HypStatus; why: string; qids: string[]; by: "evaluator" | "rules" };

// A State Plan state does not exempt anyone: State Plans set their own reporting rules (29 CFR 1904.37(b)(2): they may be
// more stringent than or supplemental to the federal ones) and may keep the report in their own system, so OSHA's federal
// file may not show it. Without a State Plan record that stays unresolved. The 1904.39(b) exclusions are a separate question.
export const HYP_LABEL: Record<HypKey, (dir: "log" | "osha") => string> = {
  written_differently: () => "Same injury, written differently",
  different_injury: () => "A different injury",
  wrong_site: (d) => (d === "log" ? "A nearby OSHA report is about another site" : "The report is about another site"),
  state_plan: (d) => (d === "log" ? "Reported to the State Plan, not in OSHA's federal file" : "The plant reports to a State Plan"),
  excluded: (d) => (d === "log" ? "A 1904.39(b) reporting exclusion applies (counsel to confirm)" : "Not recordable in this log (counsel to confirm)"),
  not_found: (d) => (d === "log" ? "No report in OSHA's federal file" : "The plant log has no line for it"),
};
export const HYP_KEYS: HypKey[] = ["written_differently", "different_injury", "wrong_site", "state_plan", "excluded", "not_found"];

const q = (l: Lane, ...steps: string[]) => l.searched.filter((s) => steps.includes(s.step) && s.qid).map((s) => s.qid!);
const found = (l: Lane, ...steps: string[]) => l.searched.filter((s) => steps.includes(s.step)).reduce((n, s) => n + s.found, 0);

/** statuses from the lane's own evidence */
export function ruleHypotheses(l: Lane, statePlansQid: string): Hypothesis[] {
  const cands = l.cands;
  const atPlace = cands.filter((c) => c.f.streetSame && (c.f.zipSame || c.f.citySame));
  const sameWeek = atPlace.filter((c) => Math.abs(c.f.days) <= 7);
  const elsewhere = cands.filter((c) => !c.f.streetSame);
  const dol = l.research.dol_inspection as { found?: boolean; at_our_plant_address?: boolean; inspection?: string } | undefined;
  const dolQ = q(l, "dol_inspection");
  const searchQ = q(l, "candidate_map", "same_site_7d", "same_site_30d", "same_city_7d", "letters_referral", "zip_week", "log_7d", "log_30d");
  // the last decision the Verifier did not refuse (a refused "different" is not evidence of a different injury)
  const refusedRounds = new Set((l.verifier ?? []).map((x) => x.round));
  const last = [...l.verdicts].reverse().find((v) => !refusedRounds.has(v.round));
  const out: Hypothesis[] = [];
  const add = (h: HypKey, status: HypStatus, why: string, qids: string[]) => out.push({ h, status, why, qids: [...new Set(qids)], by: "rules" });

  // same injury, written differently
  if (l.state === "linked") add("written_differently", l.differences.length ? "supported" : "ruled_out",
    l.differences.length ? `Linked; what differs: ${l.differences.join("; ")}.` : "Linked, and the two records say the same thing.", searchQ);
  else if (sameWeek.length) add("written_differently", last?.verdict === "different" ? "ruled_out" : "not_ruled_out",
    last?.verdict === "different" ? `A record at this address in the same week, judged different: ${last.reason}` : `${sameWeek.length} record(s) at this address in the same week; not settled.`, searchQ);
  else add("written_differently", "ruled_out", `No record at this address within the searched window (${found(l, "same_site_7d", "same_site_30d", "log_7d", "log_30d")} found).`, searchQ);

  // a different injury
  const bodyOff = atPlace.filter((c) => !c.f.body.compatible);
  if (l.state === "linked") add("different_injury", "ruled_out", "Place, date and injury agree.", searchQ);
  else if (last?.verdict === "different" || bodyOff.length) add("different_injury", "supported",
    last?.verdict === "different" ? last.reason : `Body part differs: ${bodyOff[0].f.body.diffs.join(", ")}.`, searchQ);
  else add("different_injury", atPlace.length ? "not_ruled_out" : "ruled_out", atPlace.length ? "Not settled by the records." : "Nothing at this address to compare with.", searchQ);

  // another site
  const sites = l.research.dol_sites as { osha_house_number?: string; plant_house_number?: string; inspections?: { inspection?: string; house_number?: string; opened?: string }[] } | undefined;
  const rep = l.report ?? cands[0]?.report;
  const repT = rep?.date ? new Date(rep.date + 'T00:00:00Z').getTime() : NaN;
  const atOsha = (sites?.inspections ?? []).filter((x) => x.house_number && x.house_number === sites!.osha_house_number && x.house_number !== sites!.plant_house_number
    && x.opened && Math.abs(new Date(x.opened + 'T00:00:00Z').getTime() - repT) <= 14 * 86400000);
  const sitesQ = q(l, "dol_sites");
  const masked = /^[^A-Za-z0-9]+$/.test((cands.find((c) => c.tier !== "not_ours") ?? cands[0])?.report.employer || "x");
  if (dol?.at_our_plant_address) add("wrong_site", "ruled_out", `DOL inspection ${dol.inspection} is at this plant's address.`, dolQ);
  // with OSHA's employer masked, an inspection at OSHA's address shows another address, not another employer
  else if (atOsha.length) add("wrong_site", masked ? "not_ruled_out" : "supported", `DOL inspected OSHA's house number ${sites!.osha_house_number} (${atOsha.map((x) => x.inspection).join(", ")}), not the plant's, within two weeks of the report${masked ? "; the employer is masked, so this is another address, not proof of another employer" : ""}.`, sitesQ);
  else if (dol?.found) add("wrong_site", masked ? "not_ruled_out" : "supported", `DOL inspection ${dol.inspection} is at another address${masked ? "; the employer is masked, so this is not proof of another employer" : ""}.`, dolQ);
  else if (elsewhere.length && !atPlace.length) add("wrong_site", l.state === "no_match" ? "supported" : "not_ruled_out", `${elsewhere.length} nearby report(s) at another house number; nothing places them at this plant.`, searchQ);
  else if (atPlace.length) add("wrong_site", "ruled_out", "Same house number and ZIP or city as the plant.", searchQ);
  else add("wrong_site", "not_ruled_out", "No report near this plant to place.", searchQ);

  // a State Plan state: the report goes to the State Plan (1904.37(b)(2)), so OSHA's federal file cannot show it
  const sp = statePlansQid ? [statePlansQid] : [];
  if (l.dir === "osha") add("state_plan", "ruled_out", "OSHA's federal file has this report.", []);
  else if (l.state === "not_covered") add("state_plan", "not_ruled_out", `${l.site?.state} runs a State Plan, which keeps its own records; this run does not read them.`, [...sp, ...searchQ]);
  else if (l.state === "linked") add("state_plan", "ruled_out", "OSHA's federal file has the report.", searchQ);
  else add("state_plan", "ruled_out", `${l.site?.state ?? "The plant's state"} is under federal OSHA (State Plan list).`, sp);

  // a 1904.39(b) exclusion (log), or not recordable (OSHA report)
  if (l.state === "excluded") add("excluded", "supported", `${l.exclusion?.why} (${l.exclusion?.cite}).`, []);
  else if (l.dir === "log") add("excluded", "ruled_out", "No 1904.39(b) exclusion in the narrative.", []);
  else add("excluded", "ruled_out", "A work-related amputation or in-patient hospitalization meets the recording criteria (29 CFR 1904.7).", []);

  // no report / no log line. Not asked of a State Plan lane: OSHA's federal file is not where its report would be
  if (l.state === "not_covered") return out;
  const settled = l.state === "linked" || l.state === "excluded";
  add("not_found", settled ? "ruled_out" : "not_ruled_out",
    settled ? "Explained above." : `Every search came back without a match (${l.searched.length} searches).`, searchQ);
  return out;
}

/** merge the Evaluator's own statuses (when it gave them and cited real receipts) over the rule statuses */
export function mergeHypotheses(rules: Hypothesis[], fromModel: unknown, validQids: Set<string>): Hypothesis[] {
  if (!Array.isArray(fromModel)) return rules;
  return rules.map((r) => {
    // State Plan and the 1904.39(b) exclusions are facts the code checks (State Plan list, the narrative rules): the
    // model weighs the judgement calls, not these
    if (r.h === "state_plan" || r.h === "excluded") return r;
    const m = fromModel.find((x) => x && typeof x === "object" && (x as { h?: string }).h === r.h) as { status?: string; why?: string; evidence?: string[] } | undefined;
    if (!m || !["supported", "ruled_out", "not_ruled_out"].includes(String(m.status))) return r;
    const qids = (m.evidence ?? []).filter((x) => validQids.has(x));
    return { h: r.h, status: m.status as HypStatus, why: String(m.why ?? r.why).slice(0, 220), qids: qids.length ? qids : r.qids, by: "evaluator" };
  });
}

export function hypLine(l: Lane, hs: Hypothesis[]): string {
  const sup = hs.filter((h) => h.status === "supported").map((h) => HYP_LABEL[h.h](l.dir));
  const out = hs.filter((h) => h.status === "ruled_out").length;
  const open = hs.filter((h) => h.status === "not_ruled_out").map((h) => HYP_LABEL[h.h](l.dir));
  return `${hs.length} explanations weighed: ${sup.length ? "supported: " + sup.join("; ") + ". " : ""}${out} ruled out${open.length ? "; still open: " + open.join("; ") : ""}.`;
}
