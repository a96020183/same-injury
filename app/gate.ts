// The output gate: the one exit every result leaves through (trace events, UI state, counsel export, item files, the
// replay summary, and so the README numbers, which are read from the published items and traces).
// Every plant carries real: true/false (sample/**/plants.json, written by scripts/compose_records.py; a plant that is not
// listed counts as real). The gate is a WHITELIST (QA round 9): at a real plant it lets through only
//   - the structured result codes found (reported, in_log, and "likely OSHA report X" waiting for the reviewer),
//     written differently (reported_differs, in_log_differs) and State Plan (outside), and
//   - text that matches one of the approved templates below (sentences the code writes, with ids and counts filled in).
// Everything else at a real plant is counted in the totals and not shown plant by plant; model-written text at a real
// plant is replaced by a fixed sentence that says what kind of step it was. No word list decides what is shown.
// scripts/gate_scan.ts (test/gate.test.ts, scripts/scan_identity.py) scans every committed file as an independent check.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
export const SITE_RX = /\bSite-[A-Z0-9]{4}\b/g;

// ------------------------------------------------------------------------------------------------ plants
let registry: Map<string, boolean> | undefined;
function walk(dir: string, out: string[], depth = 0) {
  if (depth > 3 || !existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (f === "plants.json") out.push(p);
    else if (!f.startsWith(".") && statSync(p).isDirectory()) walk(p, out, depth + 1);
  }
}
/** every plant in the samples: site -> real */
export function plants(): Map<string, boolean> {
  if (registry) return registry;
  const files: string[] = [];
  walk(path.join(ROOT, "sample"), files);
  const m = new Map<string, boolean>();
  for (const f of files) for (const p of JSON.parse(readFileSync(f, "utf8")).plants as { site: string; real: boolean }[]) m.set(p.site, (m.get(p.site) ?? false) || p.real);
  registry = m;
  return m;
}
/** a plant not listed anywhere counts as real (the safe default) */
export const isReal = (site?: string | null) => !!site && plants().get(site) !== false;
export const sitesIn = (s: string) => [...new Set(s.match(SITE_RX) ?? [])];

// ------------------------------------------------------------------------------------------------ approved templates
const ID = String.raw`[A-Za-z0-9_:.\-]+`, N = String.raw`\d+`, DAY = String.raw`\d{4}-\d{2}-\d{2}`, MASK = String.raw`[*][* ]*`, TOWN = String.raw`[A-Z][A-Za-z .'-]*`;
const MODEL = String.raw`[\w./-]+`;
const T = (...xs: string[]) => xs.map((x) => new RegExp(`^(?:${x})$`));
/** sentences the code writes about a real plant's step (ids, counts, dates and masked addresses filled in) */
export const EVENT_TEMPLATES = T(
  String.raw`(OSHA reports, same ZIP|OSHA reports, same city, other ZIP|Plant log, same site)(, ±${N}|, ${N}–${N}) days: (${N} found|searched)\.`,
  String.raw`Candidate map: unified log × OSHA × DOL, same house number, ±${N} days: (${ID}|none|searched)\.`,
  String.raw`Reply letters on the HQ drive: (${N} within ${N} days|searched)\.`,
  String.raw`(OSHA ${ID}|${ID} case ${ID} \(${DAY}\)): (Same address, same week, same injury|Same area\. Different address|Same ZIP and week, another house number\. The Evaluator decides|Same house number\. Different ZIP and city\. Not enough|(Same address|Same house number and city \(ZIP differs\)),? (${N} days apart|and week\. (OSHA's report does not say amputation|The log line does not say amputation))|Same house number and city, same week, same injury, but the ZIP differs\. The Evaluator decides)\.`,
  String.raw`${N} ${MASK}, ${TOWN} → Site-\w{4} \(${TOWN}, [A-Z]{2}\) by house number and (ZIP|city)\.`,
  String.raw`(judge OSHA ${ID} vs Site-\w{4} case ${ID}|decide ${N} candidate\(s\)|weigh competing explanations|compare both narratives|re-plan after the objection) — ${MODEL}`,
  String.raw`${ID} → (link|evaluate|drop) \(the Linker's words are shown only for invented plants\)\.`,
  String.raw`Linked by the Linker; no Evaluator call needed\.`,
  String.raw`The Linker linked a log line\. Skips ${N} search\(es\)\.`,
  String.raw`Same injury \(the Evaluator's words are shown only for invented plants\)\.`,
  String.raw`Same pair already judged in the other direction: same\.`,
  String.raw`${N} explanations weighed: supported: Same injury, written differently\. ${N} ruled out\.`,
  String.raw`Explanations weighed \(at a real plant only their status codes are shown\)\.`,
  String.raw`Explanations as weighed on [LR]${N} \(mirrored\)\.`,
  String.raw`[A-Z]{2} runs its own State Plan: its report may be in the State Plan's records rather than OSHA's federal file\. Searching the federal file anyway\.`,
  String.raw`Searched ${N} places in OSHA's federal file\. [A-Z]{2} runs a State Plan, which keeps its own records; this run does not read them\.`,
  String.raw`DOL inspection ${ID} \(${DAY}\) behind OSHA ${ID}'s referral, at ${N} ${MASK}, ${TOWN} — our plant's address\.`,
  String.raw`The 'same injury' decision rests on the cited receipts \((Q-${N}(, )?)+\)\.`,
  String.raw`Linker said (drop|link|evaluate) for ${ID}; kept as a candidate \((a same-address or same-ZIP amputation in the same week is not dropped by the Linker|a link needs the same house number and ZIP, week and injury)\)\. The Evaluator judges the closest candidate\.`,
  String.raw`Proposed: OSHA's "${MASK}" at ${N} ${MASK} = Site-\w{4}\. Waiting for a person\.`,
  String.raw`Same identity already waiting in the queue \(merge_\w+\)\.`,
  String.raw`"${MASK}" = Site-\w{4} was already approved\.`,
  String.raw`[A-Za-z ()]+ approved: "${MASK}" = Site-\w{4}\.`,
  String.raw`Candidate map, one query across the unified log, OSHA's file and DOL: ${N} same-address pairs within a week \(${N} with a DOL inspection\)\. Lanes [LR0-9, ]+ start with that candidate; the rest need the wider searches\.`,
  String.raw`Updated ${N} conclusion\(s\): ([LR]${N} → (reported|reported_differs|in_log|in_log_differs|outside|pending)(, )?)+\.`,
  String.raw`A step at a real plant: not shown plant by plant \(counted in the totals\)\.`,
);
/** the differences the code itself finds (rules.ts compareBody, matching.ts differencesOf) */
export const DIFF_TEMPLATES = T(
  String.raw`house number differs: OSHA ${N}, plant ${N}`, String.raw`ZIP differs: OSHA \d{5}, plant \d{5}`, String.raw`dates differ by ${N} day\(s\)`,
  String.raw`body part named differently: log [a-z/]+( finger)?, OSHA [a-z/]+( finger)?`, String.raw`(left|right) vs (left|right) side`,
  String.raw`(thumb|index|middle|ring|little)(/(thumb|index|middle|ring|little))* vs (thumb|index|middle|ring|little)(/(thumb|index|middle|ring|little))*`,
  String.raw`(finger|hand|foot|arm) vs (finger|hand|foot|arm)`,
);
const DIFF_SRC = DIFF_TEMPLATES.map((r) => r.source.slice(1, -1)).join("|");
/** an item's headline and detail lines at a real plant */
export const ITEM_TEMPLATES = T(
  String.raw`(Likely )?OSHA report ${ID}`, String.raw`Site-\w{4} log, case ${ID}`, String.raw`[A-Z]{2} runs a State Plan, which keeps its own records`,
  String.raw`A person approved the employer identity\.`, String.raw`Becomes a conclusion only after you approve the identity\.`,
  String.raw`The State Plan's own records were not part of this run\.`, String.raw`Searched ${N} places; see the path below\.`,
  String.raw`State Plan states set their own reporting rules \(29 CFR 1904\.37\(b\)\(2\) lets them be more stringent\) and may keep the report in their own system, so OSHA's federal Severe Injury file may not show it`,
  String.raw`Linked from (OSHA's|the log's) side \(shared World Model\)\.`,
  String.raw`(Written differently|Differs): (${DIFF_SRC})`,
  String.raw`${N} more difference\(s\) from reading both narratives side by side \(model text\) are shown only for invented plants\.`,
);
export const approvedEvent = (s: string) => EVENT_TEMPLATES.some((r) => r.test(s));
export const approvedItemText = (s: string) => ITEM_TEMPLATES.some((r) => r.test(s));
export const approvedDiff = (s: string) => DIFF_TEMPLATES.some((r) => r.test(s));

// ------------------------------------------------------------------------------------------------ items
type Hyp = { h: string; status: string; why?: string; qids?: string[]; by?: string };
type GItem = { site?: string; column: string; synthetic?: boolean; differences: string[]; basis?: string; hypotheses?: Hyp[]; headline: string; detail: string[];
  evaluator?: string; verifier?: unknown[]; searched: { label: string; qid?: string; found?: number }[] };
/** the structured result codes a real plant may show: found, written differently, State Plan */
const CODES: Record<string, string> = { reported: "found", in_log: "found", pending: "found", reported_differs: "written_differently", in_log_differs: "written_differently", outside: "state_plan" };
const HYP_SHOWN: Record<string, string[]> = { found: ["written_differently", "different_injury", "wrong_site"], written_differently: ["written_differently", "different_injury", "wrong_site"], state_plan: ["state_plan"] };

/** the structured result code of an item at a real plant, or undefined when it may not be shown there */
export function resultCode(i: GItem): string | undefined {
  if (i.synthetic) return undefined;
  const c = CODES[i.column];
  if (!c || (i.column === "pending" && i.basis !== "linked")) return undefined;
  if (c === "written_differently" && (i.differences ?? []).some((d) => /^OSHA's report does not flag an amputation/.test(d))) return undefined; // a statement about what was told to OSHA
  return c;
}

/** a real plant's item rebuilt from its result code and approved text only */
function realItem<T extends GItem>(i: T, code: string): T {
  // a summary that lacks a field (QA round 10: the replay summary) is gated the same way, never a crash
  const differences = Array.isArray(i.differences) ? i.differences : [], detailIn = Array.isArray(i.detail) ? i.detail : [];
  const diffs = differences.filter(approvedDiff), hidden = differences.length - diffs.length;
  const detail = detailIn.filter(approvedItemText);
  if (hidden) detail.push(`${hidden} more difference(s) from reading both narratives side by side (model text) are shown only for invented plants.`);
  // only these fields leave for a real plant (QA round 11: the replay summary carried the source narrative, town and state)
  const keep: Record<string, unknown> = {};
  for (const k of ["lane", "dir", "site", "date", "column", "basis", "reportId", "caseId", "proposalId", "receipts"]) if ((i as Record<string, unknown>)[k] !== undefined) keep[k] = (i as Record<string, unknown>)[k];
  return {
    ...keep, resultCode: code, differences: diffs, detail,
    headline: typeof i.headline === "string" && approvedItemText(i.headline) ? i.headline : code === "state_plan" ? "State Plan state" : "OSHA report found",
    hypotheses: i.hypotheses?.filter((h) => HYP_SHOWN[code].includes(h.h) && ["supported", "ruled_out", "not_ruled_out"].includes(h.status))
      .map((h) => ({ h: h.h, status: h.status, why: "", qids: h.qids ?? [], by: h.by })),
    // a search count is shown only where something was found (QA round 9: a State Plan plant carries no "0 found")
    searched: (Array.isArray(i.searched) ? i.searched : []).map((s) => ({ label: s.label, qid: s.qid, ...(code !== "state_plan" && s.found ? { found: s.found } : {}) })),
  } as unknown as T;
}

export type Withheld = { count: number; note: string };
export function gateItems<T extends GItem>(items: T[]): { items: T[]; withheld: Withheld } {
  const shown: T[] = [];
  let count = 0;
  for (const i of items) {
    if (!isReal(i.site)) { shown.push(i); continue; }
    const code = resultCode(i);
    if (!code) { count++; continue; }
    shown.push(realItem(i, code));
  }
  return { items: shown, withheld: { count, note: count ? `${count} result(s) hidden by the real-plant gate: counted in the totals and in Next steps, not shown plant by plant (at a real plant only found, written differently and State Plan are shown).` : "" } };
}
/** may this item be shown at its plant? */
export const plantLevel = <T extends GItem>(i: T) => !isReal(i.site) || !!resultCode(i);

/** the 300A count check: name an invented plant, count a real one */
export function gateYearly<T extends { site: string }>(yearly: T[]): { named: T[]; realCount: number } {
  return { named: yearly.filter((y) => !isReal(y.site)), realCount: yearly.filter((y) => isReal(y.site)).length };
}

/** the lanes view (the live ticker and the lane drawer): a real plant's lane shows a neutral state code only */
export function gateLanes<T extends { site?: string; state: string; verdicts?: unknown[]; title?: string }>(lanes: T[]): T[] {
  return lanes.map((l) => (!isReal(l.site) ? l : { ...l, state: ["open", "linked", "not_covered", "not_ours"].includes(l.state) ? l.state : "withheld", verdicts: [], form301: undefined, dol: undefined, mapDol: undefined,
    title: `${l.site} · ${l.state === "not_covered" ? "State Plan" : "plant log"}` }));
}

// ------------------------------------------------------------------------------------------------ trace
export const WITHHELD = "A step at a real plant: not shown plant by plant (counted in the totals).";
/** only ids, codes and numbers: no sentence */
const idsOnly = (v: unknown): boolean => v == null || typeof v === "number" || typeof v === "boolean" || (typeof v === "string" ? /^[A-Za-z0-9_:.\-]{0,40}$/.test(v)
  : Array.isArray(v) ? v.every(idsOnly) : typeof v === "object" ? Object.values(v as object).every(idsOnly) : false);
const LANE_RX = /\b[LR]\d+\b/g;

/** a model-written sentence at a real plant becomes a fixed sentence that says what kind of step it was */
function rewriteModelText(s: string): string {
  const linker = s.match(/^(\S+) → (link|evaluate|drop):/);
  if (linker) return `${linker[1]} → ${linker[2]} (the Linker's words are shown only for invented plants).`;
  if (/^Same injury:/.test(s)) return "Same injury (the Evaluator's words are shown only for invented plants).";
  if (/^\d+ explanations weighed:/.test(s) && !EVENT_TEMPLATES.some((r) => r.test(s))) return "Explanations weighed (at a real plant only their status codes are shown).";
  return s.replace(/: 0 found\.$/, ": searched.").replace(/: 0 within \d+ days\.$/, ": searched.");
}

export function gateEvent<T extends { summary: string; detail?: unknown; lane?: string; site?: string }>(e: T, siteOf: (lane: string) => string | undefined = () => undefined): T {
  const sites = [e.site, ...sitesIn(e.summary), ...(e.summary.match(LANE_RX) ?? []).map(siteOf), ...(e.detail && typeof e.detail === "object" ? sitesIn(JSON.stringify(e.detail)) : [])];
  if (!sites.some(isReal)) return e;
  const s = rewriteModelText(e.summary);
  const summary = approvedEvent(s) ? s : WITHHELD;
  // a step of a real plant's lane keeps no attached data; a company-wide step keeps it only when it is ids alone
  const detail = !isReal(e.site) && idsOnly(e.detail) ? e.detail : undefined;
  if (summary === e.summary && detail === e.detail) return e;
  return { ...e, summary, detail, ...(summary === WITHHELD || detail !== e.detail ? { withheld: true } : {}) };
}

/** the unseen company's replay summary (scripts/variant_run.ts) as the UI shows it: only these fields leave, gated */
export function gateReplay(r: { items?: GItem[]; verifierLanes?: { site?: string; state: string; path?: { receipts?: string[] }[] }[]; counts?: unknown; models?: unknown; modelCalls?: unknown;
  liveCalls?: unknown; receipts?: Record<string, unknown> }) {
  const g = gateItems(r.items ?? []);
  const lanes = (r.verifierLanes ?? []).filter((l) => !isReal(l.site));
  const cited = new Set(lanes.flatMap((l) => (l.path ?? []).flatMap((e) => e.receipts ?? [])));
  const receipts = Object.fromEntries(Object.entries(r.receipts ?? {}).filter(([q]) => cited.has(q)).map(([q, v]) => [q, gateReceipt(v as { result?: { data?: unknown[][] } })]));
  return { items: g.items, verifierLanes: lanes, counts: r.counts, models: r.models, modelCalls: r.modelCalls, liveCalls: r.liveCalls, receipts,
    withheld: { count: g.withheld.count + (r.verifierLanes?.length ?? 0) - lanes.length, note: g.withheld.note } };
}

// ------------------------------------------------------------------------------------------------ the independent scan's detector
/** words that read as a finding about a plant: used only by scripts/gate_scan.ts to check the committed files from the
 * outside (the gate above does not use it) */
export const NON_NEUTRAL = new RegExp([
  String.raw`"(column|to)":\s*"(not_found|not_in_log|not_required|review)"`, String.raw`"state":\s*"(no_match|needs_review|excluded)"`, String.raw`\bosha_less\b`,
  String.raw`"h":\s*"(not_found|excluded)",\s*"status":\s*"supported"`, String.raw`federal file has no report|no report (of it )?in OSHA's federal file`,
  String.raw`no matching (report|line|log line)`, String.raw`not (found )?in (this company's |the |its )?(plant )?log`, String.raw`not found in`, String.raw`could not settle`,
  String.raw`needs? a person`, String.raw`a person (checks|decides|must judge)`, String.raw`for counsel`, String.raw`counsel to (assess|confirm|review)`, String.raw`send to counsel`,
  String.raw`unresolved`, String.raw`disagrees? with (their|its) yearly summary`, String.raw`says less than the log`, String.raw`does not flag an amputation`,
  String.raw`add (the|it to the) (missing )?(case|log)`, String.raw`identity rejected`, String.raw`SYNTHETIC`, String.raw`COMPOSITE CASE`, String.raw`"escalate":\s*true`,
  String.raw`\bescalat(ed|es|ing)\b`, String.raw`sent to a person`, String.raw`differs? from (the|its) yearly summary`, String.raw`log \d+ / 300A \d+`, String.raw`\b0 found\b`,
].join("|"), "i");
export function breaks(text: string, extraSites: (string | undefined)[] = []) {
  const real = [...extraSites.filter(Boolean) as string[], ...sitesIn(text)].filter(isReal);
  return real.length > 0 && NON_NEUTRAL.test(text) ? real : null;
}

// ------------------------------------------------------------------------------------------------ every other exit
/** every way a result leaves the app, and the gate it passes (test/gate.test.ts checks that server.ts serves no other) */
export const EXITS: Record<string, string> = {
  "/": "static page", "/ui/": "static files", "/favicon.ico": "nothing", "/api/intro": "intro.json: invented plants only (test: global scan)",
  "/api/state": "gateItems, gateLanes, gateQueue; certifySummary on gated items; nextSteps: company-wide counts, plants named only through gateYearly (invented plants)", "/api/trace": "gateEvent at Trace.emit",
  "/api/receipt": "gateReceipt", "/api/export": "renderExport: gateItems", "/scans/": "gateScan: synthetic 301 forms and the SYNTHETIC test forms only",
  "/api/unseen": "exam result: table roles and field maps, no plant; its trace through gateEvent", "/api/unseen2": "gateReplay",
  "/api/reviewer": "gateReviewer", "/api/run": "a run id", "/api/usl/approve": "ok: true (no result)", "/api/merge": "gateChanged",
  "runs/<id>/items*.json": "gateItems", "runs/<id>/trace.jsonl": "gateEvent", "runs/<id>/receipts.json": "gateReceipt", "runs/<id>/world_log.json": "gateWorldLog",
  "runs/<id>/counsel_export.html": "renderExport",
};

/** a merge proposal at a real plant is the identity question behind a found report: shown; anything else is counted */
export function gateQueue<T extends { rightId?: string; status?: string }>(queue: T[]): T[] {
  return queue.filter((p) => { const site = (p.rightId ?? "").split(":").pop(); return !isReal(site) || ["pending", "approved", "rejected"].includes(String(p.status)); });
}
/** a changed conclusion after a person's decision: at a real plant only the result codes it may show */
export function gateChanged<T extends { lane: string; column: string; site?: string }>(changed: T[]): T[] {
  return changed.filter((c) => !isReal(c.site) || ["reported", "reported_differs", "in_log", "in_log_differs", "outside", "pending"].includes(c.column));
}
/** a query receipt is source data (the rows a query returned), not a result; it may not put a synthetic record next to a
 * real plant in one row */
export function gateReceipt<T extends { result?: { headers?: string[]; data?: unknown[][] } }>(r: T): T {
  const data = r.result?.data;
  if (!Array.isArray(data)) return r;
  const keep = data.filter((row) => { const t = JSON.stringify(row); return !(sitesIn(t).some(isReal) && /SYNTHETIC/.test(t)); });
  return keep.length === data.length ? r : { ...r, result: { ...r.result, data: keep }, withheldRows: data.length - keep.length };
}
/** the reviewer's view of one proposal: shown only for a plant the gate lets through */
export function gateReviewer<T extends { site?: string }>(v: T, item?: { site?: string; column: string; basis?: string; synthetic?: boolean; differences?: string[] }): T | undefined {
  if (!isReal(v.site)) return v;
  return item && resultCode({ headline: "", detail: [], searched: [], differences: [], ...item }) ? v : undefined;
}
/** a scan image: only the synthetic forms exist; anything else is not served */
export const gateScan = (file: string) => /^(301_Site-SYN\d+_case[\w-]+|scan_D\d)\.jpg$/.test(file);
/** the World Model's log, as written to a run folder: at a real plant only entity, link and identity records */
export function gateWorldLog<T extends { events?: { kind?: string; payload?: unknown }[]; audit?: { kind?: string; summary?: string }[]; queue?: { rightId?: string; status?: string }[] }>(w: T): T {
  const ok = new Set(["upsertEntity", "relate", "merge-proposed", "alias"]);
  const real = (x: unknown) => sitesIn(JSON.stringify(x)).some(isReal);
  return { ...w, events: (w.events ?? []).filter((e) => !real(e) || ok.has(String(e.kind))), audit: (w.audit ?? []).filter((a) => !real(a) || ok.has(String(a.kind))),
    queue: gateQueue(w.queue ?? []) };
}
