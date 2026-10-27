// Layer 2 of discovery: which records describe the same injury, in both directions.
//   Planner   - one lane per log amputation and per OSHA amputation report; orders the searches; re-plans when the Evaluator
//               says the evidence is not enough or the Verifier objects (model), and escalates to a person (model).
//   Linker    - the Executor: runs each search as one run_sql and scores candidates. High confidence goes straight through
//               (no Evaluator call); anything short of that goes to the Evaluator.
//   Evaluator - (deep model) decides same / different / not enough, and names what is missing.
//   Research  - fills gaps: DOL inspection behind an OSHA referral, reply letters, a side-by-side reading of both narratives (fast model),
//               jurisdiction and the 1904.39 exclusions (rules).
//   World     - every cross-agency identity is a merge proposal in the World Model queue; only a person approves it.
import { parseReply, type Ctx } from "./ctx.ts";
import { readPaperForms } from "./reader.ts";
import { asObjects, q } from "../zetaris.ts";
import { extractJson, ModelUnavailable } from "../llm.ts";
import { bodyFacts, compareBody, daysBetween, exclusions, mentionsAmputation, negatedAmputation, nameOverlap, streetNumber, tempWorker, usDate, zip5, REG } from "../rules.ts";
import type { LogCase, SirReport, Site } from "../world.ts";
import type { TableInfo } from "./discovery.ts";
import { ruleHypotheses, mergeHypotheses, hypLine, HYP_KEYS, type Hypothesis } from "./hypotheses.ts";
import { employerKey } from "../world.ts";

export type Dir = "log" | "osha";
export type Step = "jurisdiction" | "candidate_map" | "same_site_7d" | "same_site_30d" | "same_city_7d" | "letters" | "letters_referral" | "identify_site" | "zip_week" | "log_7d" | "log_30d" | "dol_inspection" | "dol_sites" | "osha_history" | "narrative_compare" | "address_check" | "exclusions";
export type Features = { zipSame: boolean; streetSame: boolean; citySame: boolean; nameSim: number; days: number; sirAmp: boolean; logAmp: boolean; body: ReturnType<typeof compareBody> };
export type Cand = { report: SirReport; log?: LogCase; site?: Site; f: Features; tier: "high" | "low" | "not_ours"; why: string; judged?: boolean };
export type Lane = {
  id: string; dir: Dir; title: string; log?: LogCase; report?: SirReport; site?: Site;
  plan: Step[]; searched: { step: Step; label: string; qid?: string; found: number }[];
  cands: Cand[]; verdicts: { round: number; verdict: string; reason: string; need: string[]; source: string }[];
  research: Record<string, unknown>; state: "open" | "linked" | "not_covered" | "not_ours" | "no_match" | "needs_review" | "excluded";
  linkedReport?: string; linkedLog?: string; differences: string[]; exclusion?: { rule: string; cite: string; why: string }; notes: string[];
  hypotheses?: Hypothesis[]; modelHypotheses?: unknown; verifier: { round: number; verdict: string; objection: string }[]; escalatedBy?: string; mirrorOf?: string; modelConclusion?: string; synthetic?: boolean; syntheticKind?: "synthetic" | "composite"; mapDol?: { inspection: string; opened: string; report: string; qid: string };
};

const STATE_NAME: Record<string, string> = { AL: "ALABAMA", AK: "ALASKA", AZ: "ARIZONA", AR: "ARKANSAS", CA: "CALIFORNIA", CO: "COLORADO", CT: "CONNECTICUT",
  DE: "DELAWARE", DC: "DISTRICT OF COLUMBIA", FL: "FLORIDA", GA: "GEORGIA", HI: "HAWAII", ID: "IDAHO", IL: "ILLINOIS", IN: "INDIANA", IA: "IOWA", KS: "KANSAS",
  KY: "KENTUCKY", LA: "LOUISIANA", ME: "MAINE", MD: "MARYLAND", MA: "MASSACHUSETTS", MI: "MICHIGAN", MN: "MINNESOTA", MS: "MISSISSIPPI", MO: "MISSOURI",
  MT: "MONTANA", NE: "NEBRASKA", NV: "NEVADA", NH: "NEW HAMPSHIRE", NJ: "NEW JERSEY", NM: "NEW MEXICO", NY: "NEW YORK", NC: "NORTH CAROLINA", ND: "NORTH DAKOTA",
  OH: "OHIO", OK: "OKLAHOMA", OR: "OREGON", PA: "PENNSYLVANIA", RI: "RHODE ISLAND", SC: "SOUTH CAROLINA", SD: "SOUTH DAKOTA", TN: "TENNESSEE", TX: "TEXAS",
  UT: "UTAH", VT: "VERMONT", VA: "VIRGINIA", WA: "WASHINGTON", WV: "WEST VIRGINIA", WI: "WISCONSIN", WY: "WYOMING" };

const STEP_LABEL: Record<Step, string> = {
  jurisdiction: "State Plan check", same_site_7d: "OSHA reports, same ZIP, ±7 days", same_site_30d: "OSHA reports, same ZIP, 8–30 days",
  same_city_7d: "OSHA reports, same city, other ZIP, ±7 days", letters: "Reply letters on the HQ drive", identify_site: "Match OSHA's address to a plant",
  candidate_map: "Candidate map: unified log × OSHA × DOL, same house number, ±7 days", letters_referral: "OSHA report behind a referral cited in a letter",
  zip_week: "Our plants at OSHA's ZIP with an amputation logged the same week",
  log_7d: "Plant log, same site, ±7 days", log_30d: "Plant log, same site, 8–30 days", dol_inspection: "DOL inspection behind OSHA's referral",
  narrative_compare: "Both narratives side by side", address_check: "Our plants at OSHA's ZIP or house number", dol_sites: "DOL inspections at OSHA's ZIP or house number", osha_history: "Other OSHA reports at that ZIP", exclusions: "1904.39 exclusions",
};
export const stepLabel = (s: Step) => STEP_LABEL[s];
/** places searched: distinct searches (a follow-up query inside one search does not count twice) */
export const placesSearched = (l: Pick<Lane, "searched">) => new Set(l.searched.filter((s) => s.step !== "letters_referral").map((s) => s.step)).size;

const SIR_DATE = "to_date(EventDate, 'M/d/yyyy')";

/** The public tables the Linker and Research read, taken from the Discovery result by role (no table name is fixed in code).
 * Their columns are the published OSHA / DOL file layouts (ID, UPA, EventDate, Address1, ...; activity_nr, rel_act_nr, ...). */
export type PublicTables = { sir: string; dolInspection?: string; dolLinks?: string; letters?: string; statePlans?: string };
export function publicTables(tables: Pick<TableInfo, "fq" | "role" | "columns">[]): PublicTables {
  const has = (t: Pick<TableInfo, "columns">, ...cols: string[]) => cols.every((c) => t.columns.some((x) => x.toLowerCase() === c.toLowerCase()));
  const pick = (role: string, ...cols: string[]) => tables.find((t) => t.role === role && has(t, ...cols))?.fq ?? tables.find((t) => t.role === role)?.fq;
  const sir = pick("osha_reports", "ID", "UPA", "EventDate", "Address1");
  if (!sir) throw new Error("Discovery found no table of OSHA severe-injury reports. Matching needs one: check the catalog and the discovery result.");
  return {
    sir, dolInspection: pick("dol_inspections", "activity_nr", "open_date"), dolLinks: pick("dol_links", "rel_act_nr"),
    letters: pick("letters", "subject"), statePlans: tables.find((t) => has(t, "covers_private_sector"))?.fq,
  };
}

export function toReport(r: Record<string, string | null>): SirReport {
  return { id: r.ID!, upa: r.UPA ?? "", date: usDate(r.EventDate ?? "") ?? "", employer: r.Employer ?? "", street: r.Address1 ?? "", city: r.City ?? "",
    state: r.State ?? "", zip: zip5(r.Zip ?? ""), amputation: Number(r.Amputation ?? 0) >= 1, hospitalized: Number(r.Hospitalized ?? 0) >= 1, body: r["Part of Body Title"] ?? "",
    text: [r["Final Narrative"], r.NatureTitle].filter(Boolean).join(" "), inspection: r.Inspection ?? "" };
}

export function features(log: { date: string; text: string; body: string } | undefined, site: Site, rep: SirReport): Features {
  const names = `${site.plant_name} ${site.legal_name}`;
  return {
    zipSame: zip5(site.zip) === rep.zip, streetSame: !!streetNumber(site.street) && streetNumber(site.street) === streetNumber(rep.street),
    citySame: site.city.toLowerCase() === rep.city.toLowerCase(), nameSim: Math.round(nameOverlap(names, rep.employer) * 100) / 100,
    days: log ? daysBetween(rep.date, log.date) : 0, sirAmp: rep.amputation, logAmp: log ? mentionsAmputation(log.text) : false,
    body: compareBody(log ? `${log.body} ${log.text}` : "", `${rep.body} ${rep.text}`),
  };
}

/** The Verifier's link rule: "high" = place, date and injury agree and OSHA flagged an amputation; a Linker link needs it. */
export function tier(f: Features): { tier: Cand["tier"]; why: string } {
  // employer names are masked for the agent role by Zetaris: the place is the house number plus ZIP or city
  const place = f.streetSame && (f.zipSame || f.citySame);
  if (!f.streetSame) {
    if (f.zipSame && Math.abs(f.days) <= 7 && f.sirAmp && f.body.compatible)
      return { tier: "low", why: "Same ZIP and week, another house number. The Evaluator decides." };
    return { tier: "not_ours", why: "Same area. Different address." };
  }
  if (!place) return { tier: "low", why: "Same house number. Different ZIP and city. Not enough." };
  // "same address" means house number and ZIP; with only the city agreeing, say so
  const where = f.zipSame ? "Same address" : "Same house number and city (ZIP differs)";
  if (Math.abs(f.days) > 7) return { tier: "low", why: `${where}, ${Math.abs(f.days)} days apart.` };
  if (!f.sirAmp) return { tier: "low", why: `${where} and week. OSHA's report does not say amputation.` };
  if (!f.logAmp) return { tier: "low", why: `${where} and week. The log line does not say amputation.` };
  if (!f.body.compatible) return { tier: "low", why: `${where} and week. Body part differs (${f.body.diffs.join(", ")}).` };
  if (!f.zipSame) return { tier: "low", why: "Same house number and city, same week, same injury, but the ZIP differs. The Evaluator decides." };
  return { tier: "high", why: "Same address, same week, same injury." };
}

// ================================================================ engine
export class Matcher {
  lanes: Lane[] = [];
  sites: Site[] = [];
  private decided = new Map<string, { verdict: string; reason: string; lane?: string }>(); // report|log -> verdict, shared by both directions
  private sitesQid = "";
  private logsQid = "";
  /** the candidate map (one federated query): log record key -> OSHA reports at the same house number within 7 days, with the DOL inspection behind each */
  private map = new Map<string, { rep: SirReport; dol?: { inspection: string; opened: string; estab: string; address: string; city: string; zip: string } }[]>();
  private mapQid = "";
  /** differences found for a linked pair (report|log), shared by both directions */
  private pairDiffs = new Map<string, string[]>();
  private statePlans = new Set<string>();
  private statePlansQid = "";

  readonly T: PublicTables;
  constructor(private ctx: Ctx, discovered: Pick<TableInfo, "fq" | "role" | "columns">[]) {
    this.T = publicTables(discovered);
    // the output gate (app/gate.ts) needs each lane's plant to decide what may be shown at the plant level
    ctx.trace.siteOf = (id) => { const l = this.lanes.find((x) => x.id === id); return l?.site?.code ?? l?.log?.site; };
  }
  private get usl() { return `${this.ctx.cfg.uslNamespace}.${this.ctx.cfg.uslName}`; }

  async load() {
    const { sql, trace, world } = this.ctx;
    const s = await sql.run(`SELECT * FROM ${this.usl}.site`, "unified site list", "planner");
    this.sitesQid = s.receipt.qid;
    this.sites = asObjects(s.result).map((r) => ({ code: r.site_code!, plant_name: `${r.city ?? ""}, ${(r.state ?? "").toUpperCase()}`, legal_name: "", street: r.street_number ?? "",
      city: r.city ?? "", state: (r.state ?? "").toUpperCase(), zip: zip5(r.zip ?? ""), ein: r.ein ?? "", group: r.plant_group ?? "" }));
    for (const site of this.sites) await world.addSite(site);
    const sp = this.T.statePlans ? await sql.run(`SELECT state FROM ${this.T.statePlans} WHERE covers_private_sector = 'true'`, "State Plan states (private sector)", "research") : undefined;
    this.statePlansQid = sp?.receipt.qid ?? "";
    for (const r of sp ? asObjects(sp.result) : []) this.statePlans.add(r.state!);

    const logs = await sql.run(`SELECT * FROM ${this.usl}.incident WHERE narrative rlike '(?i)amputat' AND event_date >= '2024-01-01' AND event_date <= '2024-12-31'`,
      "log entries that mention amputation in 2024", "planner");
    this.logsQid = logs.receipt.qid;
    if (!this.sites.length) throw new Error("The unified site table is empty for the agent role (check the USL grants)");
    const zips = [...new Set(this.sites.map((x) => x.zip))];
    const cities = [...new Set(this.sites.map((x) => x.city.toUpperCase()))];
    // OSHA -> log covers every severe-injury report (amputation or in-patient hospitalization): both must reach the 300 log
    const reps = await sql.run(`SELECT * FROM ${this.T.sir} WHERE (CAST(Amputation AS DOUBLE) >= 1 OR CAST(Hospitalized AS DOUBLE) >= 1) AND ${SIR_DATE} >= to_date('2024-01-01') AND (Zip IN (${zips.map(q).join(", ")}) OR upper(City) IN (${cities.map(q).join(", ")}))`,
      "OSHA severe-injury reports (amputation or hospitalization) in our plants' ZIP codes or cities", "planner");
    trace.emit({ agent: "planner", kind: "sql", summary: `${this.sites.length} plants, ${logs.result.data.length} log lines mention amputation, ${reps.result.data.length} OSHA severe-injury reports to check.`,
      receipts: [s.receipt.qid, ...(sp ? [sp.receipt.qid] : []), logs.receipt.qid, reps.receipt.qid] });

    for (const r of asObjects(logs.result)) {
      const lc: LogCase = { key: r.record_key!, group: r.plant_group ?? "", source: r.source_table ?? "", case_id: r.case_id ?? "", site: r.site_code!, date: r.event_date!,
        body: r.body_part ?? "", text: r.narrative ?? "" };
      if (negatedAmputation(lc.text) && !mentionsAmputation(lc.text)) {
        trace.emit({ agent: "research", kind: "branch", summary: `${lc.site} case ${lc.case_id}: "amputation" is negated. Not an amputation.`, receipts: [logs.receipt.qid] });
        continue;
      }
      await world.addLogCase(lc);
      const site = this.sites.find((x) => x.code === lc.site);
      this.lanes.push({ id: `L${this.lanes.filter((l) => l.dir === "log").length + 1}`, dir: "log", title: `${site?.plant_name || lc.site} · ${lc.date}`, log: lc, site,
        plan: ["jurisdiction", "same_site_7d", "same_site_30d", "same_city_7d", "letters"], searched: [], cands: [], verdicts: [], research: {}, state: "open", differences: [], notes: [], verifier: [] });
    }
    for (const r of asObjects(reps.result)) {
      const rep = toReport(r);
      await world.addReport(rep);
      this.lanes.push({ id: `R${this.lanes.filter((l) => l.dir === "osha").length + 1}`, dir: "osha", title: `OSHA ${rep.id} (${rep.amputation ? "amputation" : "hospitalization"}) · ${rep.date}`, report: rep,
        plan: ["identify_site", "log_7d", "log_30d"], searched: [], cands: [], verdicts: [], research: {}, state: "open", differences: [], notes: [], verifier: [] });
    }
    await this.planOrder();
    // one federated query: the unified log (four plant systems behind the USL) x OSHA's file x DOL, same house number and week
    const dol = !!(this.T.dolLinks && this.T.dolInspection);
    const cm = await sql.run(`SELECT i.record_key, i.site_code, i.event_date, r.*${dol ? ", a.activity_nr, n.open_date AS inspection_opened, n.estab_name AS inspection_estab, n.site_address AS inspection_address, n.site_city AS inspection_city, n.site_zip AS inspection_zip" : ""}
FROM ${this.usl}.incident i
JOIN ${this.usl}.site s ON i.site_code = s.site_code
JOIN ${this.T.sir} r ON regexp_extract(r.Address1, '^ *([0-9]+)', 1) = s.street_number AND (r.Zip = s.zip OR upper(r.City) = upper(s.city))
  AND abs(datediff(${SIR_DATE.replace("EventDate", "r.EventDate")}, to_date(i.event_date))) <= 7
${dol ? `LEFT JOIN ${this.T.dolLinks} a ON a.rel_act_nr = r.UPA AND a.rel_type = 'R'
LEFT JOIN ${this.T.dolInspection} n ON n.activity_nr = a.activity_nr
` : ""}WHERE i.event_date >= '2024-01-01' AND i.narrative rlike '(?i)amputat'`, "candidate map: unified log x OSHA reports x DOL, same house number, within 7 days", "planner");
    const pairs = asObjects(cm.result);
    this.mapQid = cm.receipt.qid;
    for (const x of pairs) {
      const list = this.map.get(x.record_key!) ?? [];
      if (!list.some((y) => y.rep.id === x.ID)) list.push({ rep: toReport(x), dol: x.activity_nr ? { inspection: x.activity_nr, opened: x.inspection_opened ?? "", estab: x.inspection_estab ?? "", address: x.inspection_address ?? "", city: x.inspection_city ?? "", zip: x.inspection_zip ?? "" } : undefined });
      this.map.set(x.record_key!, list);
    }
    const withPair = new Set(pairs.map((x) => x.record_key));
    const lanesWith = this.lanes.filter((l) => l.log && withPair.has(l.log.key)).map((l) => l.id);
    // every pair the map found becomes a candidate of its lane (and its DOL inspection a receipt the Evaluator must address)
    for (const l of this.lanes) { const x = pairs.find((p) => l.log && p.record_key === l.log.key && p.activity_nr); if (x) l.mapDol = { inspection: x.activity_nr!, opened: x.inspection_opened ?? "", report: x.ID ?? "", qid: cm.receipt.qid }; }
    trace.emit({ agent: "planner", kind: "sql", receipts: [cm.receipt.qid], detail: pairs.map((x) => ({ log: x.record_key, site: x.site_code, report: x.ID, inspection: x.activity_nr ?? null })),
      summary: `Candidate map, one query across the unified log, OSHA's file and DOL: ${pairs.length} same-address pairs within a week (${pairs.filter((x) => x.activity_nr).length} with a DOL inspection). Lanes ${lanesWith.join(", ") || "none"} start with that candidate; the rest need the wider searches.` });
    trace.emit({ agent: "planner", kind: "plan", summary: `${this.lanes.filter((l) => l.dir === "log").length} log lanes, ${this.lanes.filter((l) => l.dir === "osha").length} OSHA lanes. Each lane: cheapest search first, stop when one is conclusive.`,
      detail: this.lanes.map((l) => ({ lane: l.id, plan: l.plan })) });
  }

  async runAll() {
    await readPaperForms(this.ctx, this.lanes); // Nemotron VL reads the scanned paper forms first
    for (const lane of this.lanes) {
      const own = `${lane.log?.text ?? ""} ${lane.log?.body ?? ""} ${lane.report?.text ?? ""} ${lane.report?.body ?? ""}`;
      if (/SYNTHETIC|COMPOSITE CASE/.test(own)) {
        lane.synthetic = true; lane.syntheticKind = /COMPOSITE CASE/.test(own) ? "composite" : "synthetic";
        lane.title = `${lane.syntheticKind === "composite" ? "COMPOSITE" : "SYNTHETIC"} · ${lane.title}`;
        this.ctx.trace.emit({ agent: "planner", kind: "info", lane: lane.id, summary: lane.syntheticKind === "composite" ? `${lane.id} is a composite case modeled on a public pattern (state, date and job changed), not a published record.` : `${lane.id} is a SYNTHETIC record (marked in the sample data), not a published one.` });
      }
      try { lane.dir === "log" ? await this.runLogLane(lane) : await this.runOshaLane(lane); }
      catch (e) {
        const msg = e instanceof ModelUnavailable ? "Model unavailable; lane escalated to a person." : `Lane error: ${(e as Error).message}`;
        lane.state = "needs_review"; lane.notes.push(msg);
        this.ctx.trace.emit({ agent: "planner", kind: "escalate", lane: lane.id, summary: msg });
      }
    }
    this.reconcile();
    for (const lane of this.lanes) {
      // a lane is marked when its own record is synthetic, or the record it ends on (the linked one, else the ones still in play)
      const ends = lane.state === "linked" ? lane.cands.filter((c) => c.report.id === (lane.linkedReport ?? c.report.id) && (c.log?.key ?? lane.log?.key) === (lane.linkedLog ?? lane.log?.key))
        : lane.cands.filter((c) => c.tier !== "not_ours");
      const other = ends.map((c) => `${c.report.text} ${c.log?.text ?? ""}`).join(" ");
      if (!lane.synthetic && /SYNTHETIC|COMPOSITE CASE/.test(other)) {
        lane.synthetic = true; lane.syntheticKind = /SYNTHETIC/.test(other) ? "synthetic" : "composite";
        lane.title = `${lane.syntheticKind === "composite" ? "COMPOSITE" : "SYNTHETIC"} · ${lane.title}`;
        this.ctx.trace.emit({ agent: "planner", kind: "info", lane: lane.id, summary: `${lane.id} involves a ${lane.syntheticKind === "composite" ? "composite record modeled on a public pattern" : "SYNTHETIC record"} (marked in the sample data).` });
      }
      await this.weigh(lane);
    }
  }

  /** Planner (model): the order of the searches for each direction, from a fixed menu; the program only checks that
   * the State Plan check stays first (OSHA's federal file says nothing about a State Plan state) and that every step exists */
  private async planOrder() {
    const { models, trace } = this.ctx;
    const MENU = { log: ["jurisdiction", "same_site_7d", "same_site_30d", "same_city_7d", "letters"] as Step[], osha: ["log_7d", "log_30d"] as Step[] };
    const msgs = [
      { role: "system" as const, content: `You are the Planner of an injury-records audit. Two kinds of lanes: "log" (a plant log line that mentions an amputation: did OSHA get a report?) and "osha" (an OSHA severe-injury report at one of our plants: is it in the plant log?). Order the searches for each kind from its menu, most likely to settle the lane first; you may leave out a search that cannot help. Menu, log: jurisdiction (is the plant in a State Plan state), same_site_7d (OSHA reports at the plant's ZIP within 7 days), same_site_30d (same ZIP, 8-30 days), same_city_7d (same city, another ZIP, 7 days), letters (the plant's reply letters citing an OSHA referral). Menu, osha: log_7d (the plant's log lines within 7 days), log_30d (8-30 days). Employer names are masked. Reply JSON only: {"log":[...],"osha":[...],"why":"<= 20 words"}` },
      { role: "user" as const, content: JSON.stringify({ log_lanes: this.lanes.filter((l) => l.dir === "log").length, osha_lanes: this.lanes.filter((l) => l.dir === "osha").length,
        plants: this.sites.length, state_plan_plants: this.sites.filter((s) => this.statePlans.has(s.state)).length, letters_table: !!this.T.letters }) },
    ];
    const stub = () => JSON.stringify({ log: MENU.log, osha: MENU.osha, why: "cheapest first" });
    let r;
    try { r = await models.chat("fast", msgs, { tag: "planner.plan", stub }); }
    catch (e) {
      if (!(e instanceof ModelUnavailable)) throw e;
      trace.emit({ agent: "planner", kind: "fallback", summary: "Model unavailable: the search order falls back to the full menu, cheapest first." });
      r = { text: stub(), served: "rule-fallback", requested: "", lane: "fast" as const, source: "offline-stub" as const, latencyMs: 0 };
    }
    this.ctx.noteModel("planner", r, "order the searches");
    const p = parseReply<{ log?: string[]; osha?: string[]; why?: string }>(this.ctx, r, stub, "planner", "plan");
    const clean = (xs: unknown, menu: Step[]) => [...new Set((Array.isArray(xs) ? xs : []).filter((x): x is Step => menu.includes(x as Step)))];
    let log = clean(p.log, MENU.log), osha = clean(p.osha, MENU.osha);
    const fixes: string[] = [];
    if (!log.length) { log = MENU.log; fixes.push("empty log plan replaced by the full menu"); }
    if (log[0] !== "jurisdiction") { log = ["jurisdiction", ...log.filter((x) => x !== "jurisdiction")]; fixes.push("State Plan check moved first"); }
    if (!osha.length) { osha = MENU.osha; fixes.push("empty OSHA plan replaced by the full menu"); }
    for (const l of this.lanes) l.plan = l.dir === "log" ? [...log] : ["identify_site", ...osha];
    trace.emit({ agent: "planner", kind: "plan", summary: `Search order. Log lanes: ${log.map((s) => STEP_LABEL[s]).join(" → ")}. OSHA lanes: ${osha.map((s) => STEP_LABEL[s]).join(" → ")}. ${p.why ?? ""}${fixes.length ? ` (checked: ${fixes.join("; ")})` : ""}`.trim() });
  }

  /** Linker (model): for the candidates a search just found, link one, send it to the Evaluator, or drop it. The program
   * verifies: a link needs the same house number and ZIP, the same week and a compatible amputation, otherwise it goes to
   * the Evaluator; a same-address, same-week candidate is never dropped without the Evaluator. Returns true if linked. */
  private async linkerJudge(lane: Lane): Promise<boolean> {
    const { models, trace } = this.ctx;
    const fresh = lane.cands.filter((c) => !c.judged);
    if (!fresh.length) return lane.cands.some((c) => c.tier === "high");
    const id = (c: Cand) => (lane.dir === "log" ? c.report.id : c.log!.key);
    const msgs = [
      { role: "system" as const, content: `You are the Linker. A ${lane.dir === "log" ? "plant log line" : "OSHA severe-injury report"} and the candidate records a search found. Employer names are masked, so the place rests on the house number, ZIP and city. For each candidate decide: "link" (clearly the same injury: same place, same week, same injury, nothing contradicts), "evaluate" (could be the same injury but something disagrees or is missing), or "drop" (not the same place or not the same kind of injury). Reply JSON only: {"decisions":[{"id":...,"action":"link|evaluate|drop","why":"<= 12 words"}]}` },
      { role: "user" as const, content: JSON.stringify({
        plant: { site: lane.site!.code, house_number: lane.site!.street, city: lane.site!.city, zip: lane.site!.zip },
        record: lane.dir === "log" ? { date: lane.log!.date, body_part: lane.log!.body, narrative: lane.log!.text.slice(0, 400) } : { date: lane.report!.date, body_part: lane.report!.body, narrative: lane.report!.text.slice(0, 400), amputation_flag: lane.report!.amputation },
        candidates: fresh.map((c) => ({ id: id(c), same_house_number: c.f.streetSame, same_zip: c.f.zipSame, same_city: c.f.citySame, days_apart: c.f.days,
          osha_amputation_flag: c.f.sirAmp, log_mentions_amputation: c.f.logAmp, body_differences: c.f.body.diffs,
          other_text: (lane.dir === "log" ? `${c.report.body} ${c.report.text}` : `${c.log!.body} ${c.log!.text}`).slice(0, 300) })) }) },
    ];
    const stub = () => JSON.stringify({ decisions: fresh.map((c) => ({ id: id(c), action: c.tier === "high" ? "link" : c.tier === "low" ? "evaluate" : "drop", why: c.why })) });
    let r;
    try { r = await models.chat("fast", msgs, { tag: `linker.decide.${lane.id}.${lane.searched.length}`, stub }); }
    catch (e) {
      if (!(e instanceof ModelUnavailable)) throw e;
      trace.emit({ agent: "linker", kind: "fallback", lane: lane.id, summary: "Model unavailable: candidates sorted by the verifier's rules; anything short of a full match goes to the Evaluator." });
      r = { text: stub(), served: "rule-fallback", requested: "", lane: "fast" as const, source: "offline-stub" as const, latencyMs: 0 };
    }
    this.ctx.noteModel("linker", r, `decide ${fresh.length} candidate(s)`, lane.id);
    const p = parseReply<{ decisions?: { id: string; action: string; why?: string }[] }>(this.ctx, r, stub, "linker", "decide", lane.id);
    const out: string[] = [];
    for (const c of fresh) {
      const d = (p.decisions ?? []).find((x) => String(x.id) === id(c));
      let action = ["link", "evaluate", "drop"].includes(String(d?.action)) ? d!.action : JSON.parse(stub()).decisions.find((x: { id: string }) => x.id === id(c)).action;
      const rule = tier(c.f);
      let note = "";
      if (action === "link" && rule.tier !== "high") { action = "evaluate"; note = " (verifier: a link needs the same house number and ZIP, week and injury; sent to the Evaluator)"; }
      const placeWeek = c.f.streetSame && (c.f.zipSame || c.f.citySame) && Math.abs(c.f.days) <= 7;
      const zipWeekAmp = c.f.zipSame && Math.abs(c.f.days) <= 7 && c.f.sirAmp && c.f.body.compatible;
      if (action === "drop" && (placeWeek || zipWeekAmp)) { action = "evaluate"; note = " (verifier: a same-address or same-ZIP amputation in the same week is never dropped without the Evaluator)"; }
      c.tier = action === "link" ? "high" : action === "evaluate" ? "low" : "not_ours";
      c.why = (d?.why ? String(d.why) : rule.why) + note;
      if (note) trace.emit({ agent: "verifier", kind: "info", lane: lane.id, summary: `Linker said ${d?.action ?? "?"} for ${id(c)}; kept as a candidate (${note.includes("never dropped") ? "a same-address or same-ZIP amputation in the same week is not dropped by the Linker" : "a link needs the same house number and ZIP, week and injury"}). The Evaluator judges the closest candidate.` });
      c.judged = true;
      out.push(`${id(c)} → ${action}: ${c.why}`);
    }
    trace.emit({ agent: "linker", kind: "verdict", lane: lane.id, summary: out.join(" · ") });
    return lane.cands.some((c) => c.tier === "high");
  }

  /** competing explanations for every lane whose records do not simply line up (see hypotheses.ts). The Evaluator
   * (model) marks each explanation from the lane's receipts; the program keeps only citations of real receipts and
   * falls back to the rule statuses when the model is not available. */
  private async weigh(lane: Lane) {
    if (lane.state === "not_ours" || lane.state === "open") return;
    const src = lane.mirrorOf ? this.lanes.find((x) => x.id === lane.mirrorOf) : undefined;
    if (src?.hypotheses) {
      // one injury, one set of explanations: the mirror shows those of the lane that decided
      lane.hypotheses = src.hypotheses.map((h) => ({ ...h }));
      this.ctx.trace.emit({ agent: "evaluator", kind: "verdict", lane: lane.id, summary: `Explanations as weighed on ${src.id} (mirrored).`, receipts: [...new Set(lane.hypotheses.flatMap((h) => h.qids))], detail: lane.hypotheses });
      return;
    }
    if (lane.state === "linked" && !lane.verdicts.length) return; // the Linker linked it: the records agree, nothing to explain
    const valid = new Set([...lane.searched.map((s) => s.qid), this.statePlansQid].filter(Boolean) as string[]);
    // a State Plan lane is settled by the State Plan list (a code fact): the model is not asked to weigh it (QA round 8: it
    // called "no report in OSHA's federal file" supported, which reads as a finding about the plant)
    if (lane.state !== "not_covered" && (lane.state !== "linked" || !lane.modelHypotheses)) await this.explain(lane);
    const rules = ruleHypotheses(lane, this.statePlansQid);
    const merged = mergeHypotheses(rules, lane.modelHypotheses, valid);
    lane.hypotheses = this.verifyHypotheses(lane, merged, rules);
    const corrected = lane.hypotheses.some((h, i) => h.status !== merged[i].status || h.why !== merged[i].why);
    if (lane.modelConclusion) lane.notes.push(corrected ? `Evaluator's summary before the Verifier's corrections (see the explanations): ${lane.modelConclusion}` : `Evaluator: ${lane.modelConclusion}`);
    this.ctx.trace.emit({ agent: "evaluator", kind: "verdict", lane: lane.id, summary: hypLine(lane, lane.hypotheses),
      receipts: [...new Set(lane.hypotheses.flatMap((h) => h.qids))], detail: lane.hypotheses });
  }

  /** Verifier on the explanations: "another site" can only be ruled out by a receipt that places the report */
  private verifyHypotheses(lane: Lane, hs: Hypothesis[], rules: Hypothesis[] = []): Hypothesis[] {
    const note = (s: string) => this.ctx.trace.emit({ agent: "verifier", kind: "info", lane: lane.id, summary: s });
    // nothing matched: "no report in OSHA's file" (or "no log line") cannot be ruled out by the explanation
    // the conclusion and its explanations must agree: nothing matched, so "the same injury, written differently" is not
    // supported (QA round 7: a referral report already linked to another lane was called "written differently" here)
    if (lane.state === "no_match") hs = hs.map((h) => {
      if (h.h !== "written_differently" || h.status !== "supported") return h;
      note("Verifier: the lane ended with no matching record, so 'same injury, written differently' cannot be supported. Kept open.");
      return { ...h, status: "not_ruled_out" as const, why: `Verifier: no record was matched to this lane (model said: ${h.why})`, by: "rules" as const };
    });
    if (lane.state === "no_match") hs = hs.map((h) => {
      if (h.h !== "not_found" || h.status !== "ruled_out") return h;
      note("Verifier: nothing matched, so 'not found' cannot be ruled out. Kept open.");
      return { ...h, status: "not_ruled_out" as const, why: `Verifier: every search came back without a match (model said: ${h.why})`, by: "rules" as const };
    });
    const c = lane.cands.filter((x) => x.tier !== "not_ours").sort((a, b) => Math.abs(a.f.days) - Math.abs(b.f.days))[0];
    if (!c) return hs;
    const placed = (c.f.streetSame && c.f.zipSame) || placeSettled(lane, c);
    // "another site" supported by a receipt (DOL inspected OSHA's house number) stays supported unless the model cites that receipt
    hs = hs.map((h) => {
      const r = rules.find((x) => x.h === h.h);
      if (h.h !== "wrong_site" || r?.status !== "supported" || h.status === "supported" || r.qids.some((q) => h.qids.includes(q))) return h;
      note(`Verifier: 'another site' is supported by ${r.qids.join(", ")}; the explanation did not address that receipt. Kept supported.`);
      return { ...r, why: `${r.why} (model said ${h.status.replace(/_/g, " ")} without this receipt)`, by: "rules" as const };
    });
    // "another site" is supported only by a receipt that shows the other site (the rule status says which)
    hs = hs.map((h) => {
      const r = rules.find((x) => x.h === h.h);
      if (h.h !== "wrong_site" || h.status !== "supported" || !r || r.status === "supported") return h;
      note("Verifier: 'another site' was marked supported, but no receipt shows another site. Kept open.");
      return { ...h, status: "not_ruled_out" as const, why: `Verifier: no receipt shows another site (model said: ${h.why})`, by: "rules" as const };
    });
    // OSHA's employer masked, same ZIP and week, compatible amputation: an inspection at OSHA's address shows another
    // address, not another employer, so it cannot rule out "same injury" or support "another site" (masked_identity)
    const ncm = lane.research.narrative_compare as { same_event_likely?: boolean } | undefined;
    if (maskedNear(c)) hs = hs.map((h) => {
      if ((h.h === "wrong_site" && h.status === "supported") || (h.h === "written_differently" && h.status === "ruled_out")
        || (h.h === "different_injury" && h.status === "supported" && ncm?.same_event_likely !== false)) {
        note(`Verifier: '${h.h.replace(/_/g, " ")}' was marked ${h.status.replace(/_/g, " ")}, but OSHA's employer is masked: another address is not another employer. Kept open.`);
        return { ...h, status: "not_ruled_out" as const, why: `Verifier: OSHA's employer is masked; another address is not another employer (was: ${h.why})`, by: "rules" as const };
      }
      return h;
    });
    // a decision the Verifier refused is not "supported" in the explanations either
    const refused = new Set(lane.verifier.map((x) => x.verdict));
    if (lane.state !== "linked" && refused.has("same")) hs = hs.map((h) => {
      if (h.h !== "written_differently" || h.status !== "supported") return h;
      note("Verifier: 'same injury' was refused for lack of a placing receipt, so it is not 'supported' here. Kept open.");
      return { ...h, status: "not_ruled_out" as const, why: `Verifier: refused 'same injury' without a receipt that places the report (model said: ${h.why})`, by: "rules" as const };
    });
    // M2: claims no receipt of this run can support (State Plan records are never read; employees are never identified)
    hs = hs.map((h) => {
      const r = rules.find((x) => x.h === h.h);
      if (h.by !== "evaluator" || !r || !/\bState Plan (record|report|filing|data)s?\b|\bemployees?\b|\bsame (person|worker)\b|\bworker'?s? (name|identity)\b/i.test(h.why)) return h;
      note(`Verifier: '${h.h.replace(/_/g, " ")}' cited something no receipt of this run shows; the rule's reason is shown instead.`);
      return { ...h, why: `${r.why} (Verifier: the model's reason cited something no receipt shows)`, by: "rules" as const };
    });
    // the explanations must agree with the decision the lane ended on
    const last = lane.verdicts.filter((v) => v.verdict === "same" || v.verdict === "different").slice(-1)[0];
    const against = last?.verdict === "different" && lane.state === "no_match" ? "written_differently" : last?.verdict === "same" && lane.state === "linked" ? "different_injury" : undefined;
    hs = hs.map((h) => {
      if (h.h !== against || h.status !== "supported") return h;
      note(`Verifier: '${h.h.replace(/_/g, " ")}' was marked supported, but the decision was "${last!.verdict}". Kept open.`);
      return { ...h, status: "not_ruled_out" as const, why: `Verifier: disagrees with the "${last!.verdict}" decision (model said: ${h.why})`, by: "rules" as const };
    });
    return hs.map((h) => {
      if (h.h !== "wrong_site" || h.status !== "ruled_out" || placed) return h;
      this.ctx.trace.emit({ agent: "verifier", kind: "info", lane: lane.id, summary: "Verifier: 'another site' was marked ruled out, but no receipt places OSHA's report at this plant. Kept open." });
      return { ...h, status: "not_ruled_out" as const, why: `Verifier: no receipt places the report at this plant (model said: ${h.why})`, by: "rules" as const };
    });
  }

  /** the conflict critic: the Evaluator's model weighs the five explanations on the lane's final outcome */
  private async explain(lane: Lane) {
    const { models } = this.ctx;
    const evidence = [...lane.searched.filter((s) => s.qid).map((s) => ({ id: s.qid, what: `${s.label}: ${s.found} found` })),
      ...(this.statePlansQid ? [{ id: this.statePlansQid, what: `State Plan list: ${lane.site?.state ?? "?"} is ${this.statePlans.has(lane.site?.state ?? "") ? "" : "not "}a State Plan state` }] : [])];
    const msgs = [
      { role: "system" as const, content: `You are the Evaluator, acting as conflict critic in an injury-records self-audit run under counsel. The lane's records did not line up. Weigh every competing explanation and mark each supported, ruled_out or not_ruled_out, citing the evidence ids (receipt ids) that support or rule it out: ${hypMenu(lane.dir)}. ${NEUTRAL} Reply JSON only: {"hypotheses":[{"h":"written_differently","status":"supported|ruled_out|not_ruled_out","why":"<= 15 words","evidence":["Q-…"]}, … one per explanation],"conclusion":"<= 25 words: which explanation stands and why the others do not"}` },
      { role: "user" as const, content: JSON.stringify({ direction: lane.dir, outcome: lane.state, plant: lane.site ? { site: lane.site.code, state: lane.site.state, zip: lane.site.zip } : undefined,
        record: lane.dir === "log" ? { date: lane.log!.date, body_part: lane.log!.body, narrative: lane.log!.text.slice(0, 400) } : { id: lane.report!.id, date: lane.report!.date, narrative: lane.report!.text.slice(0, 400) },
        exclusion_check: lane.exclusion ?? (lane.dir === "log" ? "no 1904.39 exclusion found in the narrative" : undefined),
        evaluator_decisions: lane.verdicts.map((v) => ({ round: v.round, verdict: v.verdict, reason: v.reason })), verifier_objections: lane.verifier, escalated_by: lane.escalatedBy === "round_limit" ? "planner" : lane.escalatedBy /* the round limit is reached in the Planner's step */,
        candidates: lane.cands.slice(0, 6).map((c) => ({ report: c.report.id, same_house_number: c.f.streetSame, same_zip: c.f.zipSame, same_city: c.f.citySame, days_apart: c.f.days, linker: c.why })),
        research: JSON.parse(JSON.stringify(lane.research, (k, v) => (k === "source" ? undefined : v))), evidence,
        ...(lane.cands[0] ? mustAddress(lane, lane.cands.filter((x) => x.tier !== "not_ours").sort((a, b) => Math.abs(a.f.days) - Math.abs(b.f.days))[0] ?? lane.cands[0]) : {}) }) },
    ];
    const stub = () => JSON.stringify({ hypotheses: ruleHypotheses(lane, this.statePlansQid).map((h) => ({ h: h.h, status: h.status, why: h.why, evidence: h.qids })), conclusion: "rule statuses" });
    try {
      const r = await models.chat("deep", msgs, { tag: `evaluator.explain.${lane.id}`, stub, maxTokens: 6000 });
      this.ctx.noteModel("evaluator", r, "weigh competing explanations", lane.id);
      const v = parseReply<{ hypotheses?: unknown; conclusion?: string }>(this.ctx, r, stub, "evaluator", "explain", lane.id);
      if (r.source !== "offline-stub") lane.modelHypotheses = v.hypotheses;
      if (v.conclusion && r.source !== "offline-stub") lane.modelConclusion = v.conclusion;
    } catch (e) {
      if (!(e instanceof ModelUnavailable)) throw e;
      lane.notes.push("Explanations from the rules: the model was unavailable.");
    }
  }

  /** the Skeptic sends a lane back: judge it again from its candidates */
  async redecide(lane: Lane) {
    for (const c of lane.cands) this.decided.delete(`${c.report.id}|${c.log?.key ?? lane.log?.key}`);
    lane.state = "open";
    lane.modelHypotheses = undefined;
    await this.decide(lane);
    await this.weigh(lane);
  }

  // ------------------------------------------------------------ searches (one run_sql each)
  private async searchSir(lane: Lane, step: Step, where: string, purpose: string) {
    const r = await this.ctx.sql.run(`SELECT * FROM ${this.T.sir} WHERE ${where}`, purpose, "linker");
    const reps = asObjects(r.result).map(toReport);
    lane.searched.push({ step, label: STEP_LABEL[step], qid: r.receipt.qid, found: reps.length });
    this.ctx.trace.emit({ agent: "linker", kind: "sql", lane: lane.id, summary: `${STEP_LABEL[step]}: ${reps.length} found.`, receipts: [r.receipt.qid] });
    return reps;
  }

  private async addCands(lane: Lane, reps: SirReport[]) {
    for (const rep of reps) {
      if (lane.cands.some((c) => c.report.id === rep.id)) continue;
      await this.ctx.world.addReport(rep);
      const f = features(lane.log, lane.site!, rep);
      const t = tier(f);
      lane.cands.push({ report: rep, log: lane.log, site: lane.site, f, ...t });
      this.ctx.trace.emit({ agent: "linker", kind: "verdict", lane: lane.id, summary: `OSHA ${rep.id}: ${t.why}`,
        detail: { street: rep.street, city: rep.city, zip: rep.zip, days: f.days, sirAmp: f.sirAmp, body: f.body.diffs } });
    }
  }

  async runLogLane(lane: Lane) {
    const { trace } = this.ctx;
    const lc = lane.log!, site = lane.site!;
    const d0 = q(lc.date);
    for (const step of lane.plan) {
      if (step === "jurisdiction") {
        const sp = this.statePlans.has(site.state);
        lane.searched.push({ step, label: STEP_LABEL[step], qid: this.statePlansQid, found: sp ? 1 : 0 });
        if (sp) trace.emit({ agent: "research", kind: "info", lane: lane.id, receipts: [this.statePlansQid],
          summary: `${site.state} runs its own State Plan: its report may be in the State Plan's records rather than OSHA's federal file. Searching the federal file anyway.` });
        if (await this.fromMap(lane)) break;
        continue;
      }
      if (step === "same_site_7d") await this.addCands(lane, await this.searchSir(lane, step, `Zip = ${q(site.zip)} AND abs(datediff(${SIR_DATE}, to_date(${d0}))) <= 7`, `OSHA reports at ${site.zip} within 7 days of ${lc.date}`));
      if (step === "same_site_30d") await this.addCands(lane, await this.searchSir(lane, step, `Zip = ${q(site.zip)} AND abs(datediff(${SIR_DATE}, to_date(${d0}))) BETWEEN 8 AND 30`, `OSHA reports at ${site.zip}, 8–30 days from ${lc.date}`));
      if (step === "same_city_7d") await this.addCands(lane, await this.searchSir(lane, step, `State = ${q(STATE_NAME[site.state] ?? site.state)} AND upper(City) = ${q(site.city.toUpperCase())} AND Zip <> ${q(site.zip)} AND abs(datediff(${SIR_DATE}, to_date(${d0}))) <= 7`,
        `OSHA reports in ${site.city} under another ZIP, within 7 days`));
      if (step === "letters" && !this.T.letters) { lane.searched.push({ step, label: STEP_LABEL[step], found: 0 }); continue; }
      if (step === "letters") {
        const r = await this.ctx.sql.run(`SELECT doc_id, sent_on, subject, body FROM ${this.T.letters} WHERE site = ${q(site.code)}`, `reply letters filed for ${site.code}`, "linker");
        const letters = asObjects(r.result).filter((x) => Math.abs(daysBetween(x.sent_on!, lc.date)) <= 30);
        lane.searched.push({ step, label: STEP_LABEL[step], qid: r.receipt.qid, found: letters.length });
        trace.emit({ agent: "linker", kind: "sql", lane: lane.id, summary: `${STEP_LABEL[step]}: ${letters.length} within 30 days.`, receipts: [r.receipt.qid] });
        for (const l of letters) {
          const upa = (l.subject ?? "").match(/referral ([A-Z]+-\d+|\d+)/)?.[1];
          if (upa) await this.addCands(lane, await this.searchSir(lane, "letters_referral", `UPA = ${q(upa)}`, `OSHA report behind referral ${upa} cited in letter ${l.doc_id}`));
        }
      }
      if (await this.linkerJudge(lane)) {
        const skipped = lane.plan.slice(lane.plan.indexOf(step) + 1);
        if (skipped.length) trace.emit({ agent: "planner", kind: "branch", lane: lane.id, summary: `The Linker linked a record after "${STEP_LABEL[step]}". Skips ${skipped.length} searches.` });
        break;
      }
    }
    await this.decide(lane);
  }

  async runOshaLane(lane: Lane) {
    const { trace, sql } = this.ctx;
    const rep = lane.report!;
    // identify_site: address first, then name within the state
    const byAddr = this.sites.filter((s) => streetNumber(s.street) && streetNumber(s.street) === streetNumber(rep.street) && (s.zip === rep.zip || s.city.toLowerCase() === rep.city.toLowerCase()));
    const site = byAddr[0];
    lane.searched.push({ step: "identify_site", label: STEP_LABEL.identify_site, qid: this.sitesQid, found: site ? 1 : 0 });
    if (!site && rep.amputation && await this.zipWeek(lane)) return;
    if (!site) {
      lane.state = "not_ours";
      trace.emit({ agent: "linker", kind: "branch", lane: lane.id, summary: `${rep.street}, ${rep.city}: no plant of ours at that address. Not ours.`, receipts: [this.sitesQid] });
      return;
    }
    lane.site = site;
    lane.title = `${site.plant_name || site.code} · ${rep.date}`;
    trace.emit({ agent: "linker", kind: "verdict", lane: lane.id, summary: `${rep.street}, ${rep.city} → ${site.code} (${site.plant_name}) by house number and ${site.zip === rep.zip ? "ZIP" : "city"}.`, receipts: [this.sitesQid] });
    const RANGE: Record<string, [number, number]> = { log_7d: [0, 7], log_30d: [8, 30] };
    for (const step of lane.plan.filter((x): x is "log_7d" | "log_30d" => x in RANGE)) {
      const [lo, hi] = RANGE[step];
      const r = await sql.run(`SELECT * FROM ${this.usl}.incident WHERE site_code = ${q(site.code)} AND abs(datediff(to_date(event_date), to_date(${q(rep.date)}))) BETWEEN ${lo} AND ${hi}`,
        `${site.code} log entries ${lo}–${hi} days from ${rep.date}`, "linker");
      const rows = asObjects(r.result);
      lane.searched.push({ step, label: STEP_LABEL[step], qid: r.receipt.qid, found: rows.length });
      trace.emit({ agent: "linker", kind: "sql", lane: lane.id, summary: `${STEP_LABEL[step]}: ${rows.length} found.`, receipts: [r.receipt.qid] });
      for (const x of rows) {
        const lc: LogCase = { key: x.record_key!, group: x.plant_group ?? "", source: x.source_table ?? "", case_id: x.case_id ?? "", site: x.site_code!, date: x.event_date!, body: x.body_part ?? "", text: x.narrative ?? "" };
        await this.ctx.world.addLogCase(lc);
        const f = features(lc, site, rep);
        // a log line counts as a candidate if its injury is compatible (any wording); unrelated injuries the same week are dropped
        if (!f.body.compatible && !f.logAmp) continue;
        const t = tier(f);
        lane.cands.push({ report: rep, log: lc, site, f, tier: t.tier === "not_ours" ? "low" : t.tier, why: t.why });
        trace.emit({ agent: "linker", kind: "verdict", lane: lane.id, summary: `${site.code} case ${lc.case_id} (${lc.date}): ${t.why}`, detail: { days: f.days, logAmp: f.logAmp, body: f.body.diffs } });
      }
      if (await this.linkerJudge(lane)) { const left = lane.plan.slice(lane.plan.indexOf(step) + 1).length; if (left) trace.emit({ agent: "planner", kind: "branch", lane: lane.id, summary: `The Linker linked a log line. Skips ${left} search(es).` }); break; }
    }
    if (!lane.cands.length) return this.noMatch(lane); // no log line: identity proposal, and a person for a published report
    await this.decide(lane);
  }

  // ------------------------------------------------------------ decide: branch on confidence, loop with the Evaluator
  private async decide(lane: Lane) {
    const { trace } = this.ctx;
    const cands = lane.cands.filter((c) => c.tier !== "not_ours");
    if (!cands.length) return this.noMatch(lane);
    const order = (a: Cand, b: Cand) => Math.abs(a.f.days) - Math.abs(b.f.days) || Number(b.f.logAmp) - Number(a.f.logAmp);
    const best = [...cands].filter((c) => c.tier === "high").sort(order)[0] ?? [...cands].sort(order)[0];
    const pair = `${best.report.id}|${best.log?.key ?? lane.log?.key}`;
    if (best.tier === "high") {
      trace.emit({ agent: "linker", kind: "branch", lane: lane.id, summary: "Linked by the Linker; no Evaluator call needed." });
      return this.link(lane, best, "linker", best.why);
    }
    const prior = this.decided.get(pair);
    if (prior) {
      trace.emit({ agent: "evaluator", kind: "verdict", lane: lane.id, summary: `Same pair already judged in the other direction: ${prior.verdict}.` });
      if (prior.verdict === "same") return this.link(lane, best, "evaluator", prior.reason);
      if (prior.verdict === "escalate") {
        // the same pair, already sent to a person from the other direction: one injury, one escalation
        lane.state = "needs_review"; lane.escalatedBy = "mirror"; lane.mirrorOf = prior.lane;
        lane.notes.push(`Mirrored from ${prior.lane ?? "the other direction"}, which sent this pair to a person: ${prior.reason}`);
        trace.emit({ agent: "planner", kind: "branch", lane: lane.id, summary: `Mirrored from ${prior.lane ?? "the other direction"}: the same pair is already with a person.` });
        return;
      }
      return this.noMatch(lane);
    }
    // The Evaluator (model) decides: same, different, not enough, or escalate. The Verifier (code) checks that the
    // decision rests on receipts; when it does not, the objection goes to the Planner (model), which chooses research
    // or escalation, and the Evaluator decides again. Up to MAX_ROUNDS decisions.
    if (best.report.upa && !best.f.streetSame && !lane.research.dol_inspection && this.T.dolLinks && this.T.dolInspection) {
      trace.emit({ agent: "linker", kind: "branch", lane: lane.id, summary: `OSHA's report carries a referral number: following it to its DOL inspection before the Evaluator decides.` });
      await this.research(lane, best, "dol_inspection");
    }
    const objections: string[] = [];
    let last: { verdict: string; reason: string } = { verdict: "insufficient", reason: "" };
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const v = await this.evaluate(lane, best, round, objections);
      last = v;
      if (v.unreadable) { this.decided.set(pair, { verdict: "escalate", reason: v.reason, lane: lane.id }); return this.escalate(lane, "evaluator", v.reason); }
      // every decision, also "not enough" and "escalate", must address the receipts already gathered
      const cited = [...v.evidence, ...hypothesisEvidence(lane.modelHypotheses)];
      let objection: Objection | undefined = unaddressed(lane, best, cited, [v.reason, ...hypothesisWhy(lane.modelHypotheses)].join(" "));
      if (objection) {
        objections.push(objection.text);
        lane.verifier.push({ round, verdict: v.verdict, objection: objection.text });
        trace.emit({ agent: "verifier", kind: "reject", lane: lane.id, attempt: round, receipts: objection.receipts, summary: `${objection.text} Back to the Planner.`, detail: objection });
      } else if (v.verdict === "escalate") { this.decided.set(pair, { ...v, lane: lane.id }); return this.escalate(lane, "evaluator", v.reason); }
      if (!objection && (v.verdict === "same" || v.verdict === "different")) {
        objection = verify(lane, best, v, new Set(this.ctx.sql.receipts.map((x) => x.qid)));
        if (!objection) {
          this.decided.set(pair, v);
          trace.emit({ agent: "verifier", kind: "approve", lane: lane.id, attempt: round, receipts: v.evidence,
            summary: `The ${v.verdict === "same" ? "'same injury'" : "'different'"} decision rests on the cited receipts (${v.evidence.join(", ") || "the search results"}).` });
          if (v.verdict === "same") return this.link(lane, best, "evaluator", v.reason);
          best.tier = "not_ours"; return this.decide(lane);
        }
        objections.push(objection.text);
        lane.verifier.push({ round, verdict: v.verdict, objection: objection.text });
        if (objection.rule === "masked_identity") {
          // no research the agents can run unmasks a name: the identity question goes to the reviewer, with the pair
          trace.emit({ agent: "verifier", kind: "reject", lane: lane.id, attempt: round, summary: objection.text, detail: objection });
          const emp = `osha-employer:sir-employer:${employerKey(best.report.employer, best.report.zip, best.report.street)}`;
          const { p, isNew } = await this.ctx.world.proposeAlias(emp, best.site!.code, `same ZIP and week as ${best.site!.code}; is OSHA's employer at ${best.report.street} this company?`, "verifier");
          if (p && isNew) trace.emit({ agent: "world", kind: "proposal", lane: lane.id, summary: `Proposed: OSHA's "${best.report.employer}" at ${best.report.street} = ${best.site!.code}? Waiting for a person.`, detail: p });
          this.decided.set(pair, { verdict: "escalate", reason: objection.text, lane: lane.id });
          return this.escalate(lane, "verifier", "OSHA's employer is masked for the agents; whether the other address is this company is for a person.");
        }
        trace.emit({ agent: "verifier", kind: "reject", lane: lane.id, attempt: round, summary: `${objection.text} Back to the Planner.`, detail: objection });
      }
      // after every objection the Planner decides what happens next, also after the last round (then it can only escalate)
      const plan = await this.replan(lane, best, v, objection, Object.keys(lane.research), MAX_ROUNDS - round);
      if (round === MAX_ROUNDS || plan.escalate) {
        const wanted = (plan as { wanted?: string[] }).wanted;
        const atLimit = !plan.escalate;
        const why = atLimit ? `Round limit (${MAX_ROUNDS} Evaluator decisions) reached; the Planner still wanted ${wanted?.length ? wanted.join(", ") : "more research"}${plan.why ? ` (${plan.why})` : ""}.` : plan.why;
        this.decided.set(pair, { verdict: "escalate", reason: why, lane: lane.id });
        return this.escalate(lane, atLimit ? "round_limit" : "planner", why);
      }
      for (const step of plan.actions) await this.research(lane, best, step);
    }
    // the round limit is a safety bound, not a judgement: both positions go to the person
    const lastObj = objections.at(-1);
    return this.escalate(lane, "planner", `Round limit (${MAX_ROUNDS}) reached. Evaluator: ${last.verdict} — ${last.reason}${lastObj ? ` Verifier: ${lastObj}` : ""}`);
  }

  private escalate(lane: Lane, by: "evaluator" | "planner" | "verifier" | "round_limit", why: string) {
    lane.state = "needs_review";
    lane.escalatedBy = by;
    lane.notes.push(by === "round_limit" ? `Sent to a person at the round limit: ${why}` : `Escalated by the ${by[0].toUpperCase() + by.slice(1)}: ${why}`);
    this.ctx.trace.emit({ agent: by === "round_limit" ? "system" : by, kind: "escalate", lane: lane.id, summary: by === "round_limit" ? `Sent to a person at the round limit: ${why}` : `Sent to a person: ${why}` });
  }

  private async evaluate(lane: Lane, c: Cand, round: number, objections: string[] = []) {
    const { models, trace } = this.ctx;
    const log = c.log ?? lane.log!;
    const payload = {
      // evidence on demand: the first look is the structured record; the narratives come with "narrative_compare"
      company_log: { plant: c.site!.code, address: `house number ${c.site!.street}, ${c.site!.city} ${c.site!.state} ${c.site!.zip}`, date: log.date, body_part: log.body,
        ...(lane.research.narrative_compare ? { narrative: log.text.slice(0, 700) } : {}) },
      osha_report: { id: c.report.id, employer: "(masked by Zetaris policy)", amputation_flag: c.report.amputation, hospitalized_flag: c.report.hospitalized, address: `${c.report.street}, ${c.report.city} ${c.report.state} ${c.report.zip}`, date: c.report.date, body_part: c.report.body,
        referral_number_present: !!c.report.upa, ...(lane.research.narrative_compare ? { narrative: c.report.text.slice(0, 700) } : {}) },
      checks: { same_zip: c.f.zipSame, same_street_number: c.f.streetSame, same_city: c.f.citySame, days_apart: c.f.days, body_differences: c.f.body.diffs },
      // the replay-vs-live marker is not evidence; keep it out so a replay asks the model the very same question
      research: JSON.parse(JSON.stringify(lane.research, (k, v) => (k === "source" ? undefined : v))),
      verifier_objections: objections,
      ...mustAddress(lane, c),
      // every query this lane ran, by receipt id, so each decision and explanation can cite the rows behind it
      evidence: [...lane.searched.filter((s) => s.qid).map((s) => ({ id: s.qid, what: `${s.label}: ${s.found} found` })),
        ...(this.statePlansQid ? [{ id: this.statePlansQid, what: `State Plan list: ${lane.site?.state ?? "?"} is ${this.statePlans.has(lane.site?.state ?? "") ? "" : "not "}a State Plan state` }] : [])],
    };
    const msgs = [{ role: "system" as const, content: EVAL_PROMPT }, { role: "user" as const, content: JSON.stringify(payload) }];
    const r = await models.chat("deep", msgs, { tag: `evaluator.${lane.id}.r${round}`, maxTokens: 6000, stub: () => stubEvaluate(c, lane.research, objections, lane.searched.map((x) => x.qid).filter(Boolean) as string[]) });
    this.ctx.noteModel("evaluator", r, `judge OSHA ${c.report.id} vs ${log.site} case ${log.case_id}`, lane.id);
    // a model reply that cannot be read is not a decision: the rule stub never decides in the model's place (it only
    // stands in when there is no model at all, offline); the pair goes to a person
    const raw = extractJson<unknown>(r.text);
    if (r.source !== "offline-stub" && !(raw && typeof raw === "object" && !Array.isArray(raw) && "verdict" in raw)) {
      trace.emit({ agent: "evaluator", kind: "fallback", lane: lane.id, attempt: round, summary: `judge: the ${r.served} reply could not be read (${r.text.trim() ? "cut off or not JSON" : "empty"}); no rule decides in its place.` });
      const reason = "The Evaluator's reply could not be read; a person decides.";
      lane.verdicts.push({ round, verdict: "escalate", reason, need: [], source: r.source });
      return { verdict: "escalate", reason, need: [], evidence: lane.searched.map((x) => x.qid).filter(Boolean) as string[], unreadable: true };
    }
    const v = parseReply<{ verdict: string; reason: string; need?: string[]; hypotheses?: unknown; evidence?: string[] }>(this.ctx, r, () => stubEvaluate(c, lane.research, objections, lane.searched.map((x) => x.qid).filter(Boolean) as string[]), "evaluator", "judge", lane.id);
    if (Array.isArray(v.hypotheses)) lane.modelHypotheses = v.hypotheses;
    const anyV = v as unknown as Record<string, unknown>;
    v.reason = String(v.reason ?? anyV.why ?? anyV.explanation ?? ((v.need ?? []).length ? `needs ${(v.need ?? []).join(", ")}` : "no reason given"));
    const verdict = ["same", "different", "insufficient", "escalate"].includes(v.verdict) ? v.verdict : "insufficient";
    const evidence = [...new Set((Array.isArray(v.evidence) ? v.evidence : []).map(String))];
    lane.verdicts.push({ round, verdict, reason: v.reason ?? "", need: v.need ?? [], source: r.source });
    const label = { same: "Same injury", different: "Different injuries", insufficient: "Not enough", escalate: "A person must decide" }[verdict];
    trace.emit({ agent: "evaluator", kind: verdict === "same" ? "approve" : verdict === "escalate" ? "verdict" : verdict === "insufficient" ? "reject" : "verdict", lane: lane.id, attempt: round,
      summary: `${label}: ${v.reason}`, receipts: evidence.filter((x) => /^Q-\d+$/.test(x)), detail: v });
    return { verdict, reason: v.reason ?? "", need: v.need ?? [], evidence, unreadable: false };
  }

  /** Planner (model): after a "not enough" or a Verifier objection, the next research steps, or escalation when nothing
   * on the menu can produce the receipt that is missing */
  private async replan(lane: Lane, c: Cand, v: { verdict: string; reason: string; need: string[] }, objection: Objection | undefined, done: string[], roundsLeft = 1): Promise<{ actions: Step[]; escalate: boolean; why: string }> {
    const { models, trace } = this.ctx;
    // only research this company can run: no reply-letter table, no "letters" (it would come back with nothing)
    const menu: Step[] = roundsLeft > 0 ? (["dol_inspection", "dol_sites", "osha_history", "address_check", "narrative_compare", "letters"] as Step[])
      .filter((s) => !done.includes(s) && (s !== "letters" || !!this.T.letters)) : [];
    const msgs = [
      { role: "system" as const, content: `You are the Planner. ${objection ? "The Verifier did not accept the Evaluator's decision" : "The Evaluator said the evidence is not enough"}. Pick the research from the menu that could produce what is missing, or choose to escalate to a person when nothing on the menu can. Menu: dol_inspection (the DOL inspection opened from OSHA's referral, with the inspected address; needs a referral number), dol_sites (DOL inspections at OSHA's ZIP or house number, any referral), osha_history (other OSHA reports at OSHA's ZIP and house numbers), address_check (which of our plants sit at OSHA's ZIP or house number), narrative_compare (both full narratives side by side), letters (the plant's reply letters citing the referral). Reply JSON only: {"actions":[zero or more from the menu],"escalate":true|false,"why":"<= 25 words"}` },
      { role: "user" as const, content: JSON.stringify({ evaluator: { verdict: v.verdict, reason: v.reason, needs: v.need }, verifier_requires: objection?.requires, verifier_objection: objection?.text,
        menu, already_done: done, decisions_left: roundsLeft, osha_referral_present: !!c.report.upa, research_so_far: JSON.parse(JSON.stringify(lane.research, (k, x) => (k === "source" ? undefined : x))) }) },
    ];
    const stub = () => {
      const want = (v.need.length ? v.need : ["dol_inspection", "dol_sites", "osha_history", "address_check", "narrative_compare"]).filter((s) => menu.includes(s as Step)).slice(0, 2);
      return JSON.stringify(want.length ? { actions: want, escalate: false, why: "answer the objection" } : { actions: [], escalate: true, why: "nothing left on the menu can settle it" });
    };
    let r;
    try { r = await models.chat("fast", msgs, { tag: `planner.replan.${lane.id}.${lane.verdicts.length}`, stub }); }
    catch (e) {
      if (!(e instanceof ModelUnavailable)) throw e;
      return { actions: [], escalate: true, why: "Model unavailable; a person decides." };
    }
    this.ctx.noteModel("planner", r, "re-plan after the objection", lane.id);
    const p = parseReply<{ actions?: string[]; escalate?: boolean; why?: string }>(this.ctx, r, stub, "planner", "re-plan", lane.id);
    const acts = (p.actions ?? []).filter((a): a is Step => menu.includes(a as Step));
    if (!roundsLeft && !p.escalate) {
      // no round left: the Planner did not choose a person, it still wanted research; say so (the caller escalates at the limit)
      const wanted = (p.actions ?? []).map((a) => STEP_LABEL[a as Step] ?? String(a));
      return { actions: [], escalate: false, why: p.why ?? "", wanted } as never;
    }
    if (p.escalate || !acts.length) {
      const why = p.why || (menu.length ? "nothing chosen" : "every research step has been run");
      return { actions: [], escalate: true, why };
    }
    trace.emit({ agent: "planner", kind: "replan", lane: lane.id, summary: `New plan: ${acts.map((s) => STEP_LABEL[s]).join(", ")}. ${p.why ?? ""}`.trim() });
    return { actions: acts, escalate: false, why: p.why ?? "" };
  }

  /** the candidate map's pairs for a log lane: candidates, and the DOL inspection the map joined in becomes a receipt */
  private async fromMap(lane: Lane): Promise<boolean> {
    const list = lane.log ? this.map.get(lane.log.key) ?? [] : [];
    if (!list.length) return false;
    lane.searched.push({ step: "candidate_map", label: STEP_LABEL.candidate_map, qid: this.mapQid, found: list.length });
    this.ctx.trace.emit({ agent: "linker", kind: "sql", lane: lane.id, receipts: [this.mapQid], summary: `${STEP_LABEL.candidate_map}: ${list.map((x) => x.rep.id).join(", ")}.` });
    await this.addCands(lane, list.map((x) => x.rep));
    const withDol = list.find((x) => x.dol);
    if (withDol && !lane.research.dol_inspection) {
      const i = withDol.dol!, site = lane.site!;
      const atPlant = streetNumber(i.address) === streetNumber(site.street) && i.city.toLowerCase() === site.city.toLowerCase();
      lane.research.dol_inspection = { found: true, inspection: i.inspection, estab_name: i.estab, address: `${i.address}, ${i.city} ${i.zip}`, opened: i.opened, at_our_plant_address: atPlant, report: withDol.rep.id };
      lane.searched.push({ step: "dol_inspection", label: `${STEP_LABEL.dol_inspection} (from the candidate map)`, qid: this.mapQid, found: 1 });
      await this.ctx.world.addInspection(i.inspection, i.estab, i.address, i.zip, i.opened, withDol.rep.id);
      this.ctx.trace.emit({ agent: "research", kind: "sql", lane: lane.id, receipts: [this.mapQid],
        summary: `DOL inspection ${i.inspection} (${i.opened}) behind OSHA ${withDol.rep.id}'s referral, at ${i.address}, ${i.city}${atPlant ? " — our plant's address." : "."}` });
    }
    return this.linkerJudge(lane);
  }

  /** an OSHA amputation report at none of our addresses, but in a plant's ZIP the same week as a logged amputation there:
   * the plant becomes its site and the log lines its candidates, for the Evaluator (never "not ours" without it) */
  private async zipWeek(lane: Lane): Promise<boolean> {
    const rep = lane.report!;
    const near = this.lanes.filter((l) => l.dir === "log" && l.log && l.site && l.site.zip === rep.zip && Math.abs(daysBetween(rep.date, l.log.date)) <= 7)
      .map((l) => ({ l, f: features(l.log, l.site!, rep) })).filter((x) => x.f.sirAmp && x.f.body.compatible);
    lane.searched.push({ step: "zip_week", label: STEP_LABEL.zip_week, qid: this.logsQid, found: near.length });
    if (!near.length) return false;
    const site = near[0].l.site!;
    lane.site = site;
    lane.title = `${site.plant_name || site.code} · ${rep.date}`;
    for (const { l, f } of near.filter((x) => x.l.site!.code === site.code)) lane.cands.push({ report: rep, log: l.log, site, f, ...tier(f) });
    this.ctx.trace.emit({ agent: "linker", kind: "verdict", lane: lane.id, receipts: [this.sitesQid, this.logsQid],
      summary: `${rep.street}, ${rep.city}: none of our addresses, but ${site.code} is in ZIP ${rep.zip} and logged an amputation the same week. The Evaluator decides.` });
    await this.decide(lane);
    // judged a different injury: the report was never placed at the plant (another house number), so it is not ours,
    // not "missing from the log"
    if (lane.state === "no_match") {
      lane.state = "not_ours";
      this.ctx.trace.emit({ agent: "linker", kind: "branch", lane: lane.id, summary: `${rep.street}, ${rep.city}: judged a different injury at another address. Not ours.`, receipts: [this.sitesQid] });
    }
    return true;
  }

  /** both directions agree: a lane whose record was linked from the other direction is linked too, every linked lane of a
   * pair shows the same differences, and its explanations are weighed again on that outcome */
  private reconcile() {
    const { world, trace } = this.ctx;
    for (const l of this.lanes) {
      if (l.state === "linked" || l.state === "not_covered" || l.state === "not_ours" || l.state === "open") continue;
      const other = l.dir === "log" ? world.reportsLinkedTo(l.log!.key)[0] : world.logsLinkedTo(l.report!.id)[0];
      if (!other) continue;
      const by = this.lanes.find((x) => x.state === "linked" && (l.dir === "log" ? x.linkedLog === l.log!.key && x.linkedReport === other : x.linkedReport === l.report!.id && x.linkedLog === other));
      l.state = "linked";
      if (l.dir === "log") l.linkedReport = other; else l.linkedLog = other;
      l.modelHypotheses = undefined;
      l.notes.push(`Linked from the other direction${by ? ` (lane ${by.id})` : ""} in the shared World Model.`);
      trace.emit({ agent: "world", kind: "merge", lane: l.id, summary: `Linked from the other direction${by ? ` (${by.id})` : ""}: ${l.dir === "log" ? `OSHA ${other}` : `log ${other}`}.` });
    }
    for (const l of this.lanes.filter((x) => x.state === "linked")) {
      const key = `${l.linkedReport ?? l.report?.id}|${l.linkedLog ?? l.log?.key}`;
      l.differences = union(this.pairDiffs.get(key) ?? [], l.differences);
      this.pairDiffs.set(key, l.differences);
    }
    for (const l of this.lanes.filter((x) => x.state === "linked")) l.differences = this.pairDiffs.get(`${l.linkedReport ?? l.report?.id}|${l.linkedLog ?? l.log?.key}`) ?? l.differences;
  }

  private async research(lane: Lane, c: Cand, step: Step) {
    const { sql, trace, models, world } = this.ctx;
    if (step === "dol_inspection") {
      if (!c.report.upa) { lane.research.dol_inspection = { found: false, why: "OSHA's report has no referral number" }; return; }
      if (!this.T.dolLinks || !this.T.dolInspection) { lane.research.dol_inspection = { found: false, why: "Discovery found no DOL inspection tables" }; return; }
      const r = await sql.run(`SELECT s.ID AS report_id, a.activity_nr, i.estab_name, i.site_address, i.site_city, i.site_zip, i.open_date
FROM ${this.T.sir} s JOIN ${this.T.dolLinks} a ON a.rel_act_nr = s.UPA AND a.rel_type = 'R' JOIN ${this.T.dolInspection} i ON i.activity_nr = a.activity_nr
WHERE s.ID = ${q(c.report.id)}`, `DOL inspection opened from OSHA report ${c.report.id} (referral ${c.report.upa})`, "research");
      const rows = asObjects(r.result);
      lane.searched.push({ step, label: STEP_LABEL[step], qid: r.receipt.qid, found: rows.length });
      const i = rows[0];
      const site = c.site!;
      const atPlant = !!i && streetNumber(i.site_address ?? "") === streetNumber(site.street) && (i.site_city ?? "").toLowerCase() === site.city.toLowerCase();
      lane.research.dol_inspection = i ? { found: true, inspection: i.activity_nr, estab_name: i.estab_name, address: `${i.site_address}, ${i.site_city} ${i.site_zip}`, opened: i.open_date, at_our_plant_address: atPlant }
        : { found: false };
      if (i) await world.addInspection(i.activity_nr!, i.estab_name ?? "", i.site_address ?? "", i.site_zip ?? "", i.open_date ?? "", c.report.id);
      trace.emit({ agent: "research", kind: "sql", lane: lane.id, receipts: [r.receipt.qid],
        summary: i ? `DOL inspection ${i.activity_nr} (${i.open_date}) of "${i.estab_name}" at ${i.site_address}, ${i.site_city}${atPlant ? " — our plant's address." : "."}` : "No DOL inspection behind this referral." });
    }
    if (step === "narrative_compare") {
      const log = c.log ?? lane.log!;
      const msgs = [
        { role: "system" as const, content: "You are the Research agent. Read two descriptions of a workplace injury and list factual differences only (date, side, finger, body part, injury type, machine). Reply JSON only: {\"same_event_likely\":true|false,\"differences\":[\"<10 words each\"]}." },
        { role: "user" as const, content: JSON.stringify({ company_log: { date: log.date, text: log.text.slice(0, 700), body: log.body }, osha_report: { date: c.report.date, text: c.report.text.slice(0, 700), body: c.report.body, amputation_flag: c.report.amputation } }) },
      ];
      const r = await models.chat("fast", msgs, { tag: `research.compare.${lane.id}`, stub: () => stubCompare(c, log) });
      this.ctx.noteModel("research", r, "compare both narratives", lane.id);
      const v = parseReply<{ same_event_likely: boolean; differences: string[] }>(this.ctx, r, () => stubCompare(c, log), "research", "compare", lane.id);
      lane.research.narrative_compare = v;
      lane.searched.push({ step, label: STEP_LABEL[step], found: (v.differences ?? []).length });
      trace.emit({ agent: "research", kind: "verdict", lane: lane.id, summary: v.differences?.length ? `Differences: ${v.differences.join("; ")}.` : "No factual differences." });
    }
    if (step === "dol_sites" && this.T.dolInspection) {
      // DOL inspections at OSHA's ZIP or at its house number in its city, whatever referral opened them
      const no = streetNumber(c.report.street);
      const r = await sql.run(`SELECT activity_nr, estab_name, site_address, site_city, site_zip, open_date FROM ${this.T.dolInspection} WHERE site_zip = ${q(c.report.zip)}${no ? ` OR (upper(site_city) = ${q(c.report.city.toUpperCase())} AND site_address rlike ${q("^ *" + no + " ")})` : ""}`,
        `DOL inspections at ZIP ${c.report.zip} or house number ${no} in ${c.report.city}`, "research");
      const rows = asObjects(r.result).map((x) => ({ inspection: x.activity_nr, house_number: streetNumber(x.site_address ?? ""), zip: x.site_zip, opened: x.open_date, establishment: x.estab_name }));
      lane.research.dol_sites = { osha_house_number: no, plant_house_number: streetNumber(c.site!.street), inspections: rows };
      lane.searched.push({ step, label: STEP_LABEL[step], qid: r.receipt.qid, found: rows.length });
      trace.emit({ agent: "research", kind: "sql", lane: lane.id, receipts: [r.receipt.qid],
        summary: rows.length ? `DOL inspections at ZIP ${c.report.zip} / no. ${no}: ${rows.map((x) => `${x.inspection} at no. ${x.house_number} (${x.opened})`).join(", ")}.` : `No DOL inspection at ZIP ${c.report.zip} or house number ${no}.` });
    }
    if (step === "osha_history") {
      const r = await sql.run(`SELECT ID, EventDate, Address1, Zip, UPA FROM ${this.T.sir} WHERE Zip = ${q(c.report.zip)} AND ID <> ${q(c.report.id)}`,
        `other OSHA reports at ZIP ${c.report.zip}`, "research");
      const rows = asObjects(r.result).map((x) => ({ report: x.ID, date: x.EventDate, house_number: streetNumber(x.Address1 ?? ""), referral: !!x.UPA }));
      lane.research.osha_history = { osha_house_number: streetNumber(c.report.street), plant_house_number: streetNumber(c.site!.street), reports: rows.slice(0, 20) };
      lane.searched.push({ step, label: STEP_LABEL[step], qid: r.receipt.qid, found: rows.length });
      const same = rows.filter((x) => x.house_number === streetNumber(c.report.street)).length, ours = rows.filter((x) => x.house_number === streetNumber(c.site!.street)).length;
      trace.emit({ agent: "research", kind: "sql", lane: lane.id, receipts: [r.receipt.qid],
        summary: `${rows.length} other OSHA report(s) at ZIP ${c.report.zip}: ${same} at no. ${streetNumber(c.report.street)}, ${ours} at the plant's no. ${streetNumber(c.site!.street)}.` });
    }
    if (step === "address_check") {
      // which of our plants sit at the report's ZIP, or at its house number in its city (the unified site table)
      const no = streetNumber(c.report.street);
      const r = await sql.run(`SELECT site_code, city, state, zip, street_number FROM ${this.usl}.site WHERE zip = ${q(c.report.zip)}${no ? ` OR (upper(city) = ${q(c.report.city.toUpperCase())} AND street_number = ${q(no)})` : ""}`,
        `our plants at ZIP ${c.report.zip} or at house number ${no} in ${c.report.city}`, "research");
      const rows = asObjects(r.result);
      lane.research.address_check = { report_zip: c.report.zip, report_house_number: no, plants: rows.map((x) => ({ site: x.site_code, zip: x.zip, house_number: x.street_number, city: x.city })) };
      lane.searched.push({ step, label: STEP_LABEL[step], qid: r.receipt.qid, found: rows.length });
      trace.emit({ agent: "research", kind: "sql", lane: lane.id, receipts: [r.receipt.qid],
        summary: rows.length ? `At ZIP ${c.report.zip} or house number ${no} in ${c.report.city}: ${rows.map((x) => `${x.site_code} (ZIP ${x.zip}, no. ${x.street_number})`).join(", ")}.` : `None of our plants at ZIP ${c.report.zip} or house number ${no}.` });
    }
    if (step === "letters" && lane.site && this.T.letters) {
      const r = await sql.run(`SELECT doc_id, sent_on, subject FROM ${this.T.letters} WHERE site = ${q(lane.site.code)} AND subject rlike ${q(c.report.upa || "^$")}`, `letters citing referral ${c.report.upa}`, "research");
      lane.research.letters = { found: r.result.data.length, docs: asObjects(r.result).map((x) => x.doc_id) };
      lane.searched.push({ step, label: STEP_LABEL[step], qid: r.receipt.qid, found: r.result.data.length });
      trace.emit({ agent: "research", kind: "sql", lane: lane.id, receipts: [r.receipt.qid], summary: `${r.result.data.length} reply letter(s) cite referral ${c.report.upa}.` });
    }
  }

  private async link(lane: Lane, c: Cand, by: string, why: string) {
    const { world, trace } = this.ctx;
    const log = c.log ?? lane.log!;
    lane.linkedReport = c.report.id; lane.linkedLog = log.key; lane.state = "linked";
    const key = `${c.report.id}|${log.key}`;
    lane.differences = union(this.pairDiffs.get(key) ?? [], differencesOf(c, log, lane.research));
    this.pairDiffs.set(key, lane.differences);
    await world.linkSameInjury(c.report.id, log.key, by, why);
    const emp = `osha-employer:sir-employer:${employerKey(c.report.employer, c.report.zip, c.report.street)}`;
    const { p, isNew } = await world.proposeAlias(emp, c.site!.code, evidenceLine(c, lane.research), by);
    trace.emit({ agent: "world", kind: "proposal", lane: lane.id, detail: p,
      summary: !p ? `"${c.report.employer}" = ${c.site!.code} was already approved.` : isNew ? `Proposed: OSHA's "${c.report.employer}" at ${c.report.street} = ${c.site!.code}. Waiting for a person.` : `Same identity already waiting in the queue (${p.id}).` });
  }

  private async noMatch(lane: Lane) {
    const { trace } = this.ctx;
    if (lane.dir === "osha" && lane.site && lane.report) {
      // the report sits at one of our addresses but no log line matched: the identity question still goes to the reviewer
      const emp = `osha-employer:sir-employer:${employerKey(lane.report.employer, lane.report.zip, lane.report.street)}`;
      const { p, isNew } = await this.ctx.world.proposeAlias(emp, lane.site.code, "OSHA's address is this plant's address", "linker");
      if (p && isNew) trace.emit({ agent: "world", kind: "proposal", lane: lane.id, summary: `Proposed: "${lane.report.employer}" = ${lane.site.code}. Waiting for a person.`, detail: p });
      const own = `${lane.report.text} ${lane.report.body}`;
      if (!/SYNTHETIC|COMPOSITE CASE/.test(own)) {
        // only SYNTHETIC records may end as "not in this company's log": a published report goes to a person who reads the log
        trace.emit({ agent: "linker", kind: "conclusion", lane: lane.id, summary: "No matching line in this company's log sample." });
        return this.escalate(lane, "verifier", "a published OSHA report with no matching log line is checked by a person, not concluded 'not in the log'.");
      }
    }
    if (lane.dir === "log") {
      const ex = exclusions(lane.log!.text);
      lane.searched.push({ step: "exclusions", label: STEP_LABEL.exclusions, found: ex.length });
      if (ex.length) {
        lane.state = "excluded"; lane.exclusion = ex[0];
        trace.emit({ agent: "research", kind: "verdict", lane: lane.id, summary: `May not need a report: ${ex[0].why}. ${ex[0].cite}.` });
        return;
      }
      if (tempWorker(lane.log!.text)) lane.notes.push("Narrative mentions a temporary or contract worker: check the staffing agency's reports.");
      if (lane.site && this.statePlans.has(lane.site.state)) {
        // nothing in OSHA's federal file; a State Plan state may hold the report in its own system, which this run cannot read
        lane.state = "not_covered";
        trace.emit({ agent: "research", kind: "verdict", lane: lane.id, receipts: [this.statePlansQid],
          summary: `Searched ${placesSearched(lane)} places in OSHA's federal file. ${lane.site.state} runs a State Plan, which keeps its own records; this run does not read them.` });
        return;
      }
    }
    lane.state = "no_match";
    trace.emit({ agent: "linker", kind: "conclusion", lane: lane.id, summary: lane.dir === "log" ? `Searched ${placesSearched(lane)} places. No matching report in this sample's OSHA file.` : "No matching line in this company's log sample." });
  }
}

/** the six competing explanations, as the models are asked about them. A State Plan state is not an exemption: State
 * Plans set their own reporting rules (29 CFR 1904.37(b)(2) lets them be stricter) and may keep the report in their own
 * system; the 1904.39(b) exclusions are a separate question. */
const hypMenu = (dir: Dir) => `written_differently (the same injury, written differently), different_injury, wrong_site (${dir === "log" ? "a nearby OSHA report is about another site" : "the report is about another site"}), state_plan (${dir === "log" ? "the plant is in a State Plan state: the report may be in the State Plan's records rather than OSHA's federal file; only a State Plan record supports it" : "the plant reports to a State Plan"}), excluded (${dir === "log" ? "a 29 CFR 1904.39(b) reporting exclusion applies" : "not recordable in the plant log"}), not_found (${dir === "log" ? "no report in OSHA's federal file" : "no line in the plant log"})`;
const NEUTRAL = "Neutral words only: never say anyone failed to report, that an injury is or was reportable or unreported, or that a rule was broken.";

const EVAL_PROMPT = `You are the Evaluator in an injury-records self-audit run under counsel, with an experienced EHS reviewer's judgement.
Decide whether an OSHA severe-injury report and a company log entry describe the same injury.
Employer names are masked by policy, so the place rests on the address (house number plus ZIP or city) or on records that place the report.
How severe-injury reports work: the employer phones OSHA within 24 hours of an in-patient hospitalization or an amputation. The phone report often
describes what was known that day (for example "laceration, hospitalized"), while the log, written later, records the confirmed outcome (for example
"amputation"). Same address, same date, same side and body part, same machine or task is the same injury written differently, unless something
contradicts it (another side, another body part, another task, days apart).
You first see each record's structured fields; the full narratives arrive with "narrative_compare".
Evidence you can ask for: "dol_inspection" (the DOL inspection opened from OSHA's referral, with the inspected address), "dol_sites" (DOL inspections
at the report's ZIP or house number), "osha_history" (other OSHA reports at that ZIP), "address_check" (which of our plants sit at the report's ZIP or
house number), "narrative_compare" (both full narratives, read side by side), "letters" (the plant's reply letters citing the referral).
"verifier_objections" lists what a Verifier found missing in your earlier decisions on this pair, if any.
Decide one of: "same", "different", "insufficient" (one of the evidence steps could change your answer: name it), or "escalate" (the records that
could settle it are not available: a person must decide; say what the person should check). Cite in "evidence" the receipt ids your decision rests on.
When you answer "same" and the wording differs, say exactly what differs. ${NEUTRAL}
Also weigh every competing explanation and mark each supported, ruled_out or not_ruled_out, citing receipt ids: ${hypMenu("log")}.
Your explanations must agree with your decision. Reply with JSON only:
{"hypotheses":[{"h":"written_differently","status":"supported|ruled_out|not_ruled_out","why":"<= 15 words","evidence":["Q-…"]}, … one per explanation],
 "verdict":"same"|"different"|"insufficient"|"escalate","reason":"<= 25 words, plain English","evidence":["Q-…"],"need":[zero or more evidence steps]}`;

/** the place is settled by a receipt: DOL inspected this plant's address, or the plant list shows this plant (and no
 * other of ours) at OSHA's house number in OSHA's city while none of ours sits at OSHA's ZIP */
function placeSettled(lane: Lane, c: Cand): boolean {
  const dol = lane.research.dol_inspection as { at_our_plant_address?: boolean } | undefined;
  if (dol?.at_our_plant_address) return true;
  const ac = lane.research.address_check as { plants?: { site: string; zip: string; house_number: string }[]; report_zip?: string } | undefined;
  if (!ac?.plants) return false;
  const atZip = ac.plants.filter((p) => p.zip === ac.report_zip);
  const atHouse = ac.plants.filter((p) => p.house_number === streetNumber(c.report.street));
  return atZip.length === 0 && atHouse.length === 1 && atHouse[0].site === c.site!.code;
}

export type Objection = { text: string; requires: string; rule: string; receipts?: string[] };

/** receipt ids the Evaluator cited inside its explanations */
export function hypothesisEvidence(h: unknown): string[] {
  return Array.isArray(h) ? h.flatMap((x) => (x && Array.isArray((x as { evidence?: unknown }).evidence) ? ((x as { evidence: unknown[] }).evidence.map(String)) : [])) : [];
}

/** Verifier: receipts already gathered that bear on the place must be cited or explicitly ruled out, whatever the
 * decision. Today: a DOL inspection at OSHA's house number within 14 days of the report, or the inspection opened from
 * OSHA's referral. */
export function placeReceipts(lane: Lane, c: Cand): { qid: string; what: string; ids: string[] }[] {
  const qid = (step: string) => [...lane.searched].reverse().find((s) => s.step === step && s.qid)?.qid;
  const rep = c.report.date ? new Date(c.report.date + "T00:00:00Z").getTime() : NaN;
  const sites = lane.research.dol_sites as { osha_house_number?: string; plant_house_number?: string; inspections?: { inspection?: string; house_number?: string; opened?: string }[] } | undefined;
  const near = (sites?.inspections ?? []).filter((x) => x.house_number && x.house_number === sites!.osha_house_number && x.house_number !== sites!.plant_house_number
    && x.opened && Math.abs(new Date(x.opened + "T00:00:00Z").getTime() - rep) <= 14 * 86400000);
  const needs: { qid: string; what: string; ids: string[] }[] = [];
  if (near.length && qid("dol_sites")) needs.push({ qid: qid("dol_sites")!, ids: [...near.map((x) => x.inspection ?? ""), sites!.osha_house_number ?? ""], what: `DOL inspection ${near.map((x) => `${x.inspection} (opened ${x.opened})`).join(", ")} at OSHA's house number ${sites!.osha_house_number}, not the plant's` });
  const dol = lane.research.dol_inspection as { found?: boolean; inspection?: string; address?: string } | undefined;
  if (dol?.found && qid("dol_inspection")) needs.push({ qid: qid("dol_inspection")!, ids: [dol.inspection ?? "", streetNumber(dol.address ?? "")], what: `DOL inspection ${dol.inspection} opened from OSHA's referral (${dol.address})` });
  return needs;
}

/** same ZIP and week, compatible amputation, OSHA's employer masked for the agents: only a person can place it */
export function maskedNear(c: Cand): boolean {
  return /^[^A-Za-z0-9]+$/.test(c.report.employer || "*") && c.f.zipSame && !c.f.streetSame && Math.abs(c.f.days) <= 7 && (c.f.sirAmp || c.f.logAmp) && c.f.body.compatible;
}

/** for the Evaluator's input: the receipts it will be held to, only when there are any */
function mustAddress(lane: Lane, c: Cand): { must_address?: { rule: string; receipts: { id: string; what: string }[] } } {
  const n = placeReceipts(lane, c);
  return n.length ? { must_address: { rule: "Receipts already gathered that bear on the place. Your reason must say what each one means for this pair (for example that it points to another site), or why it does not matter.", receipts: n.map((x) => ({ id: x.qid, what: x.what })) } } : {};
}

/** the Evaluator's own explanation texts */
export function hypothesisWhy(h: unknown): string[] {
  return Array.isArray(h) ? h.map((x) => String((x as { why?: unknown })?.why ?? "")) : [];
}

/** Verifier: each receipt from placeReceipts must be cited AND its meaning stated (the inspection named, or "DOL" /
 * "inspection" said) in the decision's reason or explanations; a bare receipt id is not an explanation. */
export function unaddressed(lane: Lane, c: Cand, cited: string[], text = ""): Objection | undefined {
  // "explained" = the inspection or OSHA's house number is named, or the text says what the inspection shows about the
  // place (plant, site, address ...) without negating it; "No DOL data reviewed" or "inspection not checked" is not one
  const named = (n: { ids: string[] }) => n.ids.some((id) => id && new RegExp(`(^|[^0-9A-Za-z-])${id.replace(/[-]/g, "\\-")}($|[^0-9A-Za-z-])`).test(text));
  const placed = /\b(DOL|inspection|inspected)\b/i.test(text) && /\b(plant|site|address|house|location|establishment|premises)\b/i.test(text)
    && !/\b(no|not|without|never|unchecked|unreviewed)\b[^.;]{0,30}\b(DOL|inspect\w*)/i.test(text) && !/\b(DOL|inspection)\b[^.;]{0,25}\b(not|n't|never|unavailable|missing)\b/i.test(text);
  const said = (n: { ids: string[] }) => named(n) || placed;
  const missing = placeReceipts(lane, c).filter((n) => !cited.includes(n.qid) || !said(n));
  if (!missing.length) return undefined;
  return { rule: "unaddressed", receipts: missing.map((m) => m.qid), requires: "cite these receipts and say what they mean for this pair, or why they do not matter",
    text: `Verifier: the decision does not address ${missing.map((m) => `${m.what} (${m.qid})`).join("; ")}.` };
}
const MAX_ROUNDS = 3;

/** Verifier (code, its own agent): does the Evaluator's decision rest on receipts? It never changes a decision; it
 * objects, says what receipt would satisfy it, and the Planner and the Evaluator take another round. */
export function verify(lane: Lane, c: Cand, v: { verdict: string; evidence: string[] }, receipts: Set<string>): Objection | undefined {
  const cited = v.evidence.filter((x) => receipts.has(x));
  if (v.evidence.length && !cited.length)
    return { rule: "citations", text: `The decision cites ${v.evidence.join(", ")}, which are not receipts of this run.`, requires: "cite the receipts the decision rests on" };
  const f = c.f;
  const exact = f.streetSame && f.zipSame;
  if (v.verdict === "same") {
    if (!exact && !placeSettled(lane, c))
      return { rule: "place", requires: "a receipt that places OSHA's report at this plant (a DOL inspection at the plant's address, or the plant list showing this plant alone at OSHA's house number and none of ours at its ZIP)",
        text: `Verifier: 'same injury' but OSHA's address (${c.report.street}, ZIP ${c.report.zip}) is not the plant's (no. ${c.site!.street}, ZIP ${c.site!.zip}) and the employer is masked; no receipt places the report at this plant.` };
    if (Math.abs(f.days) > 7 && !lane.research.narrative_compare)
      return { rule: "date", requires: "both narratives read (narrative_compare) to explain the gap", text: `Verifier: 'same injury' with the dates ${Math.abs(f.days)} days apart, and the narratives were not read.` };
  }
  if (v.verdict === "different") {
    const near = (exact || (f.streetSame && f.citySame) || f.zipSame) && Math.abs(f.days) <= 7 && (f.sirAmp || f.logAmp) && f.body.compatible;
    const nc = lane.research.narrative_compare as { same_event_likely?: boolean } | undefined;
    const dol = lane.research.dol_inspection as { found?: boolean; at_our_plant_address?: boolean } | undefined;
    const sites = lane.research.dol_sites as { inspections?: { house_number: string }[]; osha_house_number?: string; plant_house_number?: string } | undefined;
    const otherSite = (dol?.found && !dol.at_our_plant_address) || !!sites?.inspections?.some((x) => x.house_number && x.house_number === sites.osha_house_number && x.house_number !== sites.plant_house_number);
    if (near && nc?.same_event_likely !== false && !otherSite)
      return { rule: "different", requires: "a receipt that shows another site (a DOL inspection elsewhere) or another injury (the narratives read side by side)",
        text: `Verifier: 'different' for a ${exact ? "same-address" : "same-ZIP"} amputation in the same week, with compatible injuries, and no receipt shows another site or another injury.` };
    // another address is not another employer: when OSHA's employer and the inspected establishment are masked for the
    // agents, only a person who sees names can say whether that address belongs to this company
    const masked = (s?: string) => !s || /^[^A-Za-z0-9]+$/.test(s);
    const estab = (dol?.found ? (lane.research.dol_inspection as { estab_name?: string }).estab_name : undefined);
    if (near && nc?.same_event_likely !== false && otherSite && masked(c.report.employer) && masked(estab))
      return { rule: "masked_identity", requires: "a person who sees employer names (the reviewer role)",
        text: `Verifier: 'different' rests on another address, but OSHA's employer${estab !== undefined ? " and the inspected establishment are" : " is"} masked for the agents; another address is not another employer. A person who sees names decides.` };
  }
  return undefined;
}

function stubEvaluate(c: Cand, research: Record<string, unknown>, objections: string[] = [], qids: string[] = []): string {
  const out = stubVerdict(c, research, objections);
  return JSON.stringify({ ...JSON.parse(out), evidence: qids }); // the rule stub cites every receipt the lane holds
}

function stubVerdict(c: Cand, research: Record<string, unknown>, objections: string[] = []): string {
  if (objections.length >= 2) return JSON.stringify({ verdict: "escalate", reason: "The records that would place the report are not available.", need: [] });
  const f = c.f;
  const dol = research.dol_inspection as { found?: boolean; at_our_plant_address?: boolean } | undefined;
  const placeOk = (f.streetSame && (f.zipSame || f.citySame)) || !!dol?.at_our_plant_address;
  if (!placeOk) return JSON.stringify({ verdict: "different", reason: "Different address.", need: [] });
  if (Math.abs(f.days) > 7) return JSON.stringify({ verdict: "different", reason: `Dates are ${Math.abs(f.days)} days apart.`, need: [] });
  if (!f.sirAmp && f.logAmp && !research.narrative_compare) return JSON.stringify({ verdict: "insufficient", reason: "OSHA's report does not say amputation. The log does. Not enough.", need: ["narrative_compare", "dol_inspection"] });
  if (!f.body.compatible && !research.narrative_compare) return JSON.stringify({ verdict: "insufficient", reason: `Body part differs (${f.body.diffs.join(", ")}).`, need: ["narrative_compare"] });
  if (!dol) return JSON.stringify({ verdict: "insufficient", reason: "Address and week match, but the employer is masked. Need the inspection behind the referral.", need: ["dol_inspection"] });
  if (dol.at_our_plant_address) {
    const word = !f.sirAmp ? " Same injury, written differently: OSHA's report does not flag an amputation." : "";
    return JSON.stringify({ verdict: "same", reason: `Same address, same date, same injury, and DOL inspected that address.${word}`, need: [] });
  }
  return JSON.stringify({ verdict: "insufficient", reason: "The inspection does not settle the place.", need: ["letters"] });
}

function stubCompare(c: Cand, log: LogCase): string {
  const diffs = [...c.f.body.diffs];
  if (!c.report.amputation && mentionsAmputation(log.text)) diffs.push("OSHA report: laceration; log: amputation");
  if (c.f.days) diffs.push(`dates ${Math.abs(c.f.days)} day(s) apart`);
  return JSON.stringify({ same_event_likely: c.f.body.compatible && Math.abs(c.f.days) <= 7, differences: diffs });
}

const union = (a: string[], b: string[]) => [...a, ...b.filter((x) => !a.some((y) => y.toLowerCase() === x.toLowerCase()))];

function differencesOf(c: Cand, log: LogCase, research: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (!c.f.streetSame) out.push(`house number differs: OSHA ${streetNumber(c.report.street)}, plant ${streetNumber(c.site!.street)}`);
  if (!c.f.zipSame) out.push(`ZIP differs: OSHA ${c.report.zip}, plant ${c.site!.zip}`);
  // compatible but not the same: the log says "hand", OSHA names a finger (or the reverse)
  const lb = bodyFacts(`${log.body} ${log.text}`), rb = bodyFacts(`${c.report.body} ${c.report.text}`);
  if (lb.fingers.length !== rb.fingers.length && (lb.fingers.length === 0 || rb.fingers.length === 0) && (lb.region || rb.region))
    out.push(`body part named differently: log ${lb.fingers.length ? lb.fingers.join("/") + " finger" : lb.region || "unstated"}, OSHA ${rb.fingers.length ? rb.fingers.join("/") + " finger" : rb.region || "unstated"}`);
  if (!c.report.amputation && mentionsAmputation(log.text)) out.push("OSHA's report does not flag an amputation; the log does");
  if (c.f.days) out.push(`dates differ by ${Math.abs(c.f.days)} day(s)`);
  for (const d of c.f.body.diffs) out.push(d);
  const nc = research.narrative_compare as { differences?: string[] } | undefined;
  const flagged = out.some((x) => /amputation/i.test(x));
  for (const d of nc?.differences ?? []) {
    if (flagged && /amputat|lacerat/i.test(d)) continue; // already said by the amputation-flag line
    if (!out.some((x) => x.toLowerCase() === d.toLowerCase())) out.push(d);
  }
  return out;
}

function evidenceLine(c: Cand, research: Record<string, unknown>): string {
  const parts = [];
  if (c.f.streetSame) parts.push("same house number");
  if (c.f.citySame) parts.push("same city");
  if (c.f.zipSame) parts.push("same ZIP");
  const dol = research.dol_inspection as { found?: boolean; inspection?: string; at_our_plant_address?: boolean } | undefined;
  if (dol?.at_our_plant_address) parts.push(`DOL inspection ${dol.inspection} at this plant's address`);
  if (Math.abs(c.f.days) <= 7) parts.push(c.f.days === 0 ? "same day" : `${Math.abs(c.f.days)} day(s) apart`);
  return parts.join("; ");
}

export { REG };
