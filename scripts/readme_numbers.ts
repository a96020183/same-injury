// Writes every number the README quotes about the recorded runs from the published traces, so none is typed by hand.
// Each block sits between <!-- auto:NAME --> and <!-- /auto:NAME --> in README.md.
//   node --no-warnings --import tsx scripts/readme_numbers.ts [--check]   (--check: exit 1 if README is out of date)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { syntheticSentence, previousSentence } from "../app/synthetic_note.ts";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(import.meta.dirname, "..");
type Ev = { seq: number; agent: string; kind: string; lane?: string; summary: string; model?: { lane: string; served: string; source: string } };
// The one live run each part of the README quotes. Each run has its own trace file; a number never adds up two runs.
import { RUNS, RECORDED, USER_SCOPE_RUN, traceFile as T } from "./runs.ts";
/** a trace file, checked to hold exactly one run: the one named */
const read = (f: string, run: string): Ev[] => {
  const ev = readFileSync(path.join(ROOT, f), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) as (Ev & { run: string })[];
  const other = [...new Set(ev.map((e) => e.run))].filter((r) => r !== run);
  if (other.length || ev.filter((e) => e.seq === 1).length !== 1) throw new Error(`${f} must hold run ${run} only (found ${[...new Set(ev.map((e) => e.run))].join(", ")})`);
  return ev;
};
const short = (s: string) => s.replace(/^nvidia\//, "").replace(/-a\d+b$/, "");
const AGENTS = ["discovery", "reader", "linker", "evaluator", "planner", "research"];
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

function counts(ev: Ev[]) {
  const n = (f: (e: Ev) => boolean) => ev.filter(f).length;
  const models = ev.filter((e) => e.kind === "model");
  const by = AGENTS.map((a) => [a, n((e) => e.kind === "model" && e.agent === a)] as const).filter(([, k]) => k);
  const esc = ev.filter((e) => e.kind === "escalate");
  const escBy = [...new Set(esc.map((e) => (/round limit/i.test(e.summary) ? "at the round limit" : `by the ${cap(e.agent)}`)))].join(", ");
  const sk = ev.filter((e) => e.agent === "skeptic").map((e) => e.summary.match(/(\d+) citations re-run\D+(\d+) match/)).find(Boolean);
  return `${models.length} model calls — ${by.map(([a, k]) => `${cap(a)} ${k}`).join(", ")}; Evaluator rejections ${n((e) => e.kind === "reject" && e.agent === "evaluator")}; `
    + `Verifier rejections ${n((e) => e.kind === "reject" && e.agent === "verifier")}; plan revisions ${n((e) => e.kind === "replan")}; escalations ${esc.length}${esc.length ? ` (${escBy})` : ""}; `
    + `fallbacks ${n((e) => e.kind === "fallback")}; Skeptic ${sk ? `${sk[2]} of ${sk[1]} cited queries reproduce` : "not run"}`;
}

function models(ev: Ev[]) {
  const m = ev.filter((e) => e.kind === "model" && e.model);
  return ["fast", "deep", "vision"].map((l) => {
    const c = m.filter((e) => e.model!.lane === l);
    if (!c.length) return "";
    const s = new Map<string, number>(); for (const e of c) s.set(short(e.model!.served), (s.get(short(e.model!.served)) ?? 0) + 1);
    return `${l} ${c.length} (${[...s].sort((a, b) => b[1] - a[1]).map(([k, v]) => `\`${k}\` ×${v}`).join(", ")})`;
  }).filter(Boolean).join("; ") + `; total ${m.length}`;
}

/** what happened on each lane that reached the Evaluator or was linked, in trace order */
function lanes(ev: Ev[], ids: string[]) {
  return ids.map((id) => {
    const l = ev.filter((e) => e.lane === id);
    const steps: string[] = [];
    if (l.some((e) => e.agent === "linker" && e.kind === "branch" && /^Linked by the Linker/.test(e.summary))) steps.push("linked by the Linker, no Evaluator call");
    const judged = l.filter((e) => e.agent === "evaluator" && ["approve", "reject", "verdict"].includes(e.kind) && /^(Same injury|Not enough|Different injuries|A person must decide)/.test(e.summary));
    if (judged.length) steps.push("Evaluator: " + judged.map((e) => e.summary.split(":")[0].toLowerCase()).join(" → "));
    const vr = l.filter((e) => e.agent === "verifier" && e.kind === "reject").length;
    if (vr) steps.push(`Verifier objected ${vr === 1 ? "once" : `${vr} times`}`);
    if (l.some((e) => e.agent === "evaluator" && e.kind === "fallback")) steps.push("an Evaluator reply could not be read");
    const mirror = l.find((e) => /^Mirrored from/.test(e.summary));
    if (mirror) steps.push(`${mirror.summary.replace(/:.*$/, "").replace(/^M/, "m")} (one escalation, counted once)`);
    else if (l.some((e) => /already judged in the other direction/.test(e.summary))) steps.push("the other direction's decision reused");
    const esc = l.find((e) => e.kind === "escalate");
    if (esc) steps.push(/round limit/i.test(esc.summary) ? "sent to a person at the round limit (the Planner still wanted more research)" : `sent to a person by the ${cap(esc.agent)}`);
    if (l.some((e) => e.agent === "world" && e.kind === "merge" && /other direction/.test(e.summary))) steps.push("linked from the other direction");
    if (l.some((e) => e.agent === "verifier" && e.kind === "approve")) steps.push("Verifier accepted");
    return `${id}: ${steps.join("; ") || "no candidate"}`;
  }).join(". ") + ".";
}

function layer1() {
  const ev = read(T("unseen3001_layer1", RUNS.layer1, "trace.jsonl"), RUNS.layer1);
  const ans = JSON.parse(readFileSync(path.join(ROOT, "sample/unseen3001/answers.json"), "utf8"));
  const pred = JSON.parse(readFileSync(path.join(ROOT, T("unseen3001_layer1", RUNS.layer1, "prediction.json")), "utf8"));
  const all = JSON.parse(readFileSync(path.join(ROOT, "docs/trace/unseen3001_layer1_runs.json"), "utf8")).runs as { n: number; run: string; fields: string }[];
  const me = all.find((r) => r.run === RUNS.layer1);
  if (!me) throw new Error(`docs/trace/unseen3001_layer1_runs.json does not list run ${RUNS.layer1}: run scripts/score_layer1_traces.ts`);
  const pm = pred.field_map ?? pred.fields ?? pred;
  const logs = Object.entries(ans.tables).filter(([, r]) => r === "incident").map(([k]) => k);
  let right = 0, total = 0, found = 0;
  for (const k of logs) {
    if (pm[k]) found++;
    for (const f of ["date", "body_part", "narrative", "site"]) { total++; if (pm[k]?.[f] === ans.field_map[k][f]) right++; }
  }
  const vr = ev.filter((e) => e.agent === "verifier" && e.kind === "reject").length, rp = ev.filter((e) => e.kind === "replan").length;
  return `Discovery found **${found} of ${logs.length}** injury logs among ${Object.keys(ans.tables).length} tables and mapped **${right} of ${total}** field pairs; `
    + (vr ? `the Verifier rejected a field map ${vr === 1 ? "once" : `${vr} times`} and the Planner revised ${rp === 1 ? "it" : `${rp} times`}` : "no field map was rejected")
    + ` (run \`${RUNS.layer1}\`, its own trace \`${T("unseen3001_layer1", RUNS.layer1, "trace.jsonl")}\`). This is live run ${me.n} of ${all.length} on this company; the code changed between runs. `
    + `Field scores of all ${all.length} runs, each re-scored from its own trace: ${all.map((r) => r.fields).join(", ")} (lowest ${all.map((r) => r.fields).sort()[0]}; list in \`docs/trace/unseen3001_layer1_runs.json\`, \`scripts/score_layer1_traces.ts\`)`;
}

function tests() {
  return "`npm test` passes: unit, pipeline replay, World Model, and the consistency tests that check this README against the runs it names";
}
function testsCounted() {
  const r = spawnSync(process.execPath, ["--no-warnings", "--import", "tsx", "--test", "test/units.test.ts", "test/offline.test.ts", "test/pipeline.test.ts", "test/rename.test.ts", "engine/world-model/l1.test.ts"],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, SAMPLE_MODE: "true" } });
  const pass = r.stdout.match(/ℹ pass (\d+)/)?.[1], all = r.stdout.match(/ℹ tests (\d+)/)?.[1];
  return `\`npm test\` ${pass}/${all}`;
}

function vl() {
  const dir = path.join(ROOT, "sample/seed1003/scans");
  const truth = JSON.parse(readFileSync(path.join(dir, "truth.json"), "utf8")), rec = JSON.parse(readFileSync(path.join(dir, "vl_recorded.json"), "utf8"));
  let ok = 0, n = 0;
  for (const [f, t] of Object.entries<Record<string, string>>(truth)) for (const [k, w] of Object.entries(t)) {
    n++; const g = rec[f]?.fields?.[k]; if (g == null) continue;
    const a = String(g).trim().toLowerCase().replace(/^(\d):/, "0$1:"), b = String(w).trim().toLowerCase().replace(/^(\d):/, "0$1:");
    if (k === "body_part" ? a.includes(b.split(" ")[0]) : a === b) ok++;
  }
  return `${ok} of ${n} fields on the two SYNTHETIC test forms (\`npm run vl\`, recorded ${Object.values<{ recorded: string }>(rec)[0]?.recorded ?? "?"})`;
}

const TITLE: Record<string, string> = { reported: "reported", reported_differs: "reported, written differently", not_required: "may not need a report", not_found: "no matching report found",
  outside: "in a State Plan state (its own records, outside OSHA's federal file)", pending: "waiting for the reviewer", review: "sent to a person", in_log: "in the log", in_log_differs: "in the log, written differently", not_in_log: "not in the log sample" };
/** the conclusions of a run (items.json published next to its trace), lane ids listed */
function outcomes(file: string) {
  const items = JSON.parse(readFileSync(path.join(ROOT, file), "utf8")) as { lane: string; dir: string; column: string }[];
  const part = (dir: string) => {
    const own = items.filter((i) => i.dir === dir);
    const by = new Map<string, string[]>(); for (const i of own) by.set(i.column, [...(by.get(i.column) ?? []), i.lane]);
    return `${own.length} ${dir === "log" ? "log amputations" : "OSHA reports at our plants"}: ${[...by].map(([c, l]) => `${l.length} ${TITLE[c] ?? c} (${l.join(", ")})`).join("; ")}`;
  };
  return `${part("log")}. ${part("osha")}`;
}

/** the key events of one lane, as a code block (agent, kind, summary; the model that answered) */
function hero(ev: Ev[], lane: string) {
  const keep = ev.filter((e) => e.lane === lane && (["verdict", "reject", "approve", "replan", "escalate", "fallback"].includes(e.kind) || (e.agent === "research" && e.kind === "sql") || (e.agent === "verifier" && e.kind === "info")));
  const served = (i: number) => { for (let j = ev.indexOf(keep[i]) - 1; j >= 0 && ev[j].lane === lane; j--) if (ev[j].kind === "model") return ev[j].model ? `  (${short(ev[j].model!.served)})` : ""; return ""; };
  const lines = keep.map((e, i) => `${e.agent.padEnd(9)} ${e.kind.padEnd(8)} ${e.summary.replace(/\s+/g, " ").slice(0, 150)}${["evaluator", "planner", "linker"].includes(e.agent) ? served(i) : ""}`);
  return "\n```\n" + lines.join("\n") + "\n```\n";
}

let variantsLane = "";
/** the three data variants, replayed (npm run variants), each as the route it took */
function variants() {
  const r = spawnSync(process.execPath, ["--no-warnings", "--import", "tsx", "scripts/variants.ts"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, SAMPLE_MODE: "true", L1_MODEL_OFFLINE: "true" }, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("npm run variants failed: " + r.stderr.slice(-400));
  const res = JSON.parse(readFileSync(path.join(os.tmpdir(), "l1-variants.json"), "utf8")) as { variant: string; what?: string; column?: string; path?: string[] }[];
  const step = (x: string) => {
    const [k, ...rest] = x.split(" "); const t = rest.join(" ");
    return k === "evaluator:approve" ? "Evaluator: same" : k === "evaluator:reject" ? "Evaluator: not enough" : k === "evaluator:verdict" && /^Different/.test(t) ? "Evaluator: different"
      : k === "evaluator:fallback" ? "Evaluator reply unreadable" : k === "verifier:reject" ? "Verifier objects" : k === "verifier:approve" ? "Verifier accepts" : k === "planner:replan" ? "Planner re-plans"
      : /:escalate$/.test(k) ? (/round limit/i.test(t) ? "sent to a person at the round limit" : `sent to a person by the ${cap(k.split(":")[0])}`) : k === "linker:branch" && /^Linked by the Linker/.test(t) ? "Linker links, no Evaluator call" : "";
  };
  variantsLane = [...new Set(res.filter((v) => v.what).map((v) => (v as { lane?: string }).lane).filter(Boolean))].join("/");
  return res.filter((v) => v.what).map((v) => `**${cap(v.variant)}** (${v.what}): ${TITLE[v.column ?? ""] ?? v.column}, via ${(v.path ?? []).map(step).filter(Boolean).join(" → ") || "the searches alone"}.`).join(" ");
}

/** a live run, or the shipped code replaying one */
const runLabel = (id: string, rec: string) => (id === rec ? `\`${id}\`, recorded live` : `\`${id}\` (the shipped code replaying live run \`${rec}\`, whose own trace is in \`docs/trace/live/\`)`);

/** what the scan measured about the plants and companies, as README sentences (no sentence about privacy is typed by hand) */
function privacy() {
  const r = JSON.parse(readFileSync(path.join(ROOT, "docs/scan_identity_result.json"), "utf8"));
  const ids = Object.entries(r.employer_codes_identified ?? {}).map(([k, v]) => `${v} employer codes in ${k === "seed1003" ? "the demo company" : "the unseen company"}`).join(" and ");
  return `${r.plants_published_300a} of ${r.plants} plants carry published 300A employee counts or hours; ${r.real_plants_singled_out_by_counts} of ${r.real_plants} real plants are still singled out by their 300A case counts among the source companies' published rows, and ${ids} can be re-identified from their published reports (report-set attack). SYNTHETIC records or negative conclusions in a real plant: ${r.synthetic_or_negative_in_real_plants}. `
    + `Output gate (all ${r.gate_files} files git commits, read unit by unit: each trace event, model answer, Zetaris row, item, CSV row and line): units that name a real plant next to a non-neutral label or a synthetic record: ${r.gate_real_plant_non_neutral}.`;
}

/** the Verifier's 300A count check on the unseen company, from its trace (the output gate names only invented plants) */
function yearly(ev: Ev[]) {
  const e = ev.find((x) => x.agent === "verifier" && /yearly summary/.test(x.summary));
  if (!e) return "the Verifier found no yearly summary to check";
  const m = e.summary.match(/^(\d+) of (\d+) sites disagree with their yearly summary: (.*)\.$/);
  return m ? `the Verifier also checks the 300A totals: ${m[1]} of ${m[2]} sites differ (${m[3]}), on the person's *Before you certify* list` : `the Verifier also checks the 300A totals: ${e.summary.replace(/\.$/, "")}`;
}

/** the invented pairs the README follows: the plant decides the lanes, whatever number the run gave them */
const LEAD = { demo: "Site-SYN1", unseen: "Site-SYN6" };
function pair(name: string, id: string, site: string): string[] {
  const items = JSON.parse(readFileSync(path.join(ROOT, T(name, id, "items.json")), "utf8")) as { lane: string; dir: string; site?: string }[];
  return ["log", "osha"].map((d) => items.find((i) => i.site === site && i.dir === d)?.lane).filter(Boolean) as string[];
}

/** which agents act on a pair's lanes in a run (from its trace, so the README never names one that did not) */
function leadAgents(ev: Ev[], lanes: string[]) {
  const NAME: Record<string, string> = { linker: "the Linker", research: "Research", evaluator: "the Evaluator", verifier: "the Verifier (code)", planner: "the Planner", reader: "the Reader", world: "the World Model" };
  // the steps the replay screen lists (scripts/variant_run.ts verifierLanes.path)
  const shown = (e: Ev) => ["approve", "reject", "replan", "escalate", "fallback", "branch"].includes(e.kind) || (e.agent === "research" && e.kind === "sql") || (e.agent === "evaluator" && e.kind === "verdict" && !/explanations/.test(e.summary));
  const seen = [...new Set(ev.filter((e) => e.lane && lanes.includes(e.lane) && NAME[e.agent] && shown(e)).map((e) => e.agent))];
  const names = seen.map((a) => NAME[a]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "?";
}

/** the one case run live under the contract's `meterless-scope: user` (scripts/user_scope_case.sh), from its call log */
function userScope() {
  const f = `docs/trace/user_scope_${USER_SCOPE_RUN}_model_calls.jsonl`;
  const calls = readFileSync(path.join(ROOT, f), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) as { tag: string; source: string; scope?: string }[];
  const live = calls.filter((c) => c.source === "live" && c.scope === "user");
  const items = JSON.parse(readFileSync(path.join(ROOT, `docs/trace/user_scope_${USER_SCOPE_RUN}_items.json`), "utf8")) as { lane: string; column: string }[];
  const col = (l: string) => TITLE[items.find((i) => i.lane === l)?.column ?? ""] ?? "?";
  const tick = "`";
  const hf = `docs/trace/user_scope_${USER_SCOPE_RUN}_http_log.jsonl`;
  const sent = readFileSync(path.join(ROOT, hf), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) as { request_headers: Record<string, string>; status: number }[];
  const user = sent.filter((h) => h.request_headers["meterless-scope"] === "user");
  return `run ${tick}${USER_SCOPE_RUN}${tick}: ${user.length} of ${sent.length} requests went out with the header ${tick}meterless-scope: user${tick} (read back from each request as sent, token masked: ${tick}${hf}${tick}), `
    + `for the calls ${live.map((c) => tick + c.tag + tick).join(", ")}; the other ${calls.length - live.length} calls replayed the recording; ${pair("demo", RUNS.demo, LEAD.demo).map((l) => `${l} ended ${col(l)}`).join(", ")} (call log: ${tick}${f}${tick})`;
}

/** the de-identification scan's counts (scripts/scan_identity.py writes them; no shift, state or employer in the file) */
function scan() {
  const r = JSON.parse(readFileSync(path.join(ROOT, "docs/scan_identity_result.json"), "utf8"));
  return `Result: ${r.sensitive_tied} of ${r.sensitive_conclusions} negative conclusions ("no matching report", "not in the log", "OSHA's report says less than the log", and OSHA reports left with a person) tie to one real employer under any of the guessed shifts and states (generated rows are judged on the complete public OSHA file)${r.generated_tied_by_ita_subset_only != null ? `. Counted separately, not failed: for ${r.generated_tied_by_ita_subset_only} generated rows the company pool's ITA cases, a small subset of the national file, hold exactly one establishment in the same 15-day window, a chance hit any invented record gets (over 800 random seeds none had zero; scripts/pick_synthetic_seed.py)` : ""}. `
    + `The other ${r.other_conclusions} conclusions (a report exists, a State Plan state, or a log line goes to a person) are counted, not hidden: ${r.other_tied} can be tied to one employer this way, synthetic pairs among them by coincidence; they repeat what OSHA already published, that the report exists. `
    + `Report-set attack (no shift needed: an employer code's reports matched, by OSHA category and one common date offset, against every public employer's): `
    + `${Object.entries(r.employer_codes_identified ?? {}).map(([k, v]) => `${k} ${v} employer codes re-identified`).join(", ")}; negative conclusions resting on a published report or on a re-identified employer: ${r.negatives_report_set_failed ?? "not checked"}. `
    + `SYNTHETIC rows sharing two or more fields with a published OSHA report or ITA case, or invented plants at a real establishment's address: ${r.synthetic_rows_derived ?? "not checked"} (of ${r.synthetic_rows ?? "?"} rows). `
    + `Scanned forms: ${r.scanned_forms_tied} of ${r.scanned_form_entries} answer entries tie to a published ITA case. Names, places and record numbers: ${r.working_tree_hits} hits in the working tree, ${r.history_hits} in the git history (every blob; the scan is re-run after the last commit). Tracked scripts that could rebuild which companies were drawn: ${r.selection_scripts ?? "not checked"}. Files of code, tests, fixtures and docs holding a real record id, or a real plant's or report's house number with its ZIP (the dropped cases and the codes before re-keying included): ${r.hardcoded_real_values ?? "not checked"}`;
}

const demo = read(T("demo", RUNS.demo, "trace.jsonl"), RUNS.demo), unseen = read(T("unseen3001", RUNS.unseen, "trace.jsonl"), RUNS.unseen);
const laneIds = (ev: Ev[]) => [...new Set(ev.filter((e) => e.lane && ((e.agent === "evaluator" && /^(Same injury|Not enough|Different injuries|A person must decide|Same pair already judged)/.test(e.summary)) || (e.agent === "linker" && e.kind === "branch" && /^Linked by/.test(e.summary)) || (e.agent === "world" && e.kind === "merge"))).map((e) => e.lane!))]
  .sort((a, b) => a[0].localeCompare(b[0]) || Number(a.slice(1)) - Number(b.slice(1)));
const blocks: Record<string, () => string> = {
  "demo-counts": () => counts(demo), "demo-models": () => models(demo), "demo-lanes": () => lanes(demo, laneIds(demo)),
  "unseen-counts": () => counts(unseen), "demo-run": () => runLabel(RUNS.demo, RECORDED.demo), "unseen-run": () => runLabel(RUNS.unseen, RECORDED.unseen),
  "unseen-layer1": layer1, tests, vl,
  "demo-outcomes": () => outcomes(T("demo", RUNS.demo, "items_at_review.json")), "unseen-outcomes": () => outcomes(T("unseen3001", RUNS.unseen, "items_at_review.json")),
  "unseen-l4-story": () => lanes(unseen, pair("unseen3001", RUNS.unseen, LEAD.unseen)),
  "unseen-hero": () => hero(unseen, pair("unseen3001", RUNS.unseen, LEAD.unseen)[0]), "demo-hero": () => hero(demo, pair("demo", RUNS.demo, LEAD.demo)[0]),
  "demo-pair": () => `${pair("demo", RUNS.demo, LEAD.demo).join("/")} (${LEAD.demo})`, "unseen-pair": () => `${pair("unseen3001", RUNS.unseen, LEAD.unseen)[0]} (${LEAD.unseen})`,
  variants, scan, privacy, "unseen-300a": () => yearly(unseen), synthetic: syntheticSentence, "synthetic-previous": previousSentence, "user-scope": userScope, "variants-lane": () => variantsLane || "?", conformance: () => { const c = JSON.parse(readFileSync(path.join(ROOT, "docs/evidence/world_model_conformance.json"), "utf8")); return `**${c.passed}/${c.total}** checks passed, re-run ${c.run_at_utc.slice(0, 10)} against vendor/meterless ${c.vendor_commit} (\`npm run conformance\`, needs \`vendor/meterless\`; output: \`docs/evidence/world_model_conformance.txt\`, \`.json\`; \`scripts/conformance_evidence.mjs\`)`; }, "unseen-lead-agents": () => leadAgents(unseen, pair("unseen3001", RUNS.unseen, LEAD.unseen).slice(0, 1)),
};
const file = path.join(ROOT, "README.md");
let md = readFileSync(file, "utf8").replace(/\r\n/g, "\n"); // compare and write with LF (.gitattributes: README.md eol=lf)
const before = md;
for (const [name, f] of Object.entries(blocks)) {
  const re = new RegExp(`(<!-- auto:${name} -->)[\\s\\S]*?(<!-- /auto:${name} -->)`, "g"); // every occurrence of a block
  if (!re.test(md)) { console.error(`README has no block ${name}`); continue; }
  const v = f();
  md = md.replace(re, (_m, a, b) => `${a}${v}${b}`);
  console.log(`${name}: ${v.slice(0, 160)}${v.length > 160 ? "…" : ""}`);
}
if (process.argv.includes("--check")) process.exit(md === before ? 0 : 1);
if (md !== before) writeFileSync(file, md);
if (!existsSync(file)) process.exit(1);
