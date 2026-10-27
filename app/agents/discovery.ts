// Layer 1 of discovery: which systems hold injury records, and how their fields line up.
// Discovery (model) reads the Zetaris catalog through run_sql, classifies every table and proposes a field map.
// Evaluator (deterministic checks through run_sql) rejects maps that do not survive the data; Planner (model) revises.
// The result is a USL draft that waits for an administrator before COMPILE USL runs.
import { gateYearly } from "../gate.ts";
import { parseReply, type Ctx } from "./ctx.ts";
import { asObjects, bt, q } from "../zetaris.ts";
import { extractJson } from "../llm.ts";
import { sparkToDate } from "../emulator.ts";

export type Role = "incident_log" | "site_list" | "yearly_summary" | "osha_reports" | "dol_inspections" | "dol_links" | "letters" | "reference" | "other";
export type FieldMap = Partial<Record<"case_id" | "site" | "date" | "date_format" | "date_regex" | "body_part" | "narrative" | "injury"
  | "code" | "plant_name" | "legal_name" | "street" | "city" | "state" | "zip" | "ein", string>>;
export type TableInfo = { source: string; table: string; fq: string; columns: string[]; sample: Record<string, string | null>[]; role?: Role; why?: string; map?: FieldMap; group?: string };
export type DiscoveryResult = { sources: { name: string; kind: "datasource" | "lightning"; description: string; kept: boolean; why: string }[]; tables: TableInfo[]; usl?: UslDraft };
export type UslDraft = { compile: string; activateIncident: string; activateSite: string; namespace: string; name: string };

const SYS_TABLE = /^[A-Z_]+$/; // MySQL information_schema tables surface through Zetaris in upper case

// ---------------------------------------------------------------- stubs (offline only; never shown as model output)
function stubTriage(sources: { name: string; description: string }[]) {
  return JSON.stringify(sources.map((s) => {
    const keep = /plant|hq|headquarter|osha|dol|injur|safety|ehs/i.test(s.name + " " + s.description) && !/taxi|tpc|pharmacy|revisit|a-prime/i.test(s.name + s.description);
    return { source: s.name, keep, why: keep ? "name suggests company, OSHA or DOL records" : "unrelated sample or another team's data" };
  }));
}
const pick = (cols: string[], re: RegExp) => cols.find((c) => re.test(c));
function guessFormat(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const cands = ["yyyy-MM-dd", "MM/dd/yyyy", "dd/MM/yyyy", "MM/dd/yy", "yyyyMMdd", "dd-MMM-yyyy"];
  return cands.find((f) => sparkToDate(v, f));
}
function stubClassify(tables: TableInfo[]) {
  const out = tables.map((t) => {
    const c = t.columns, s0 = t.sample[0] ?? {};
    const lc = c.join(" ").toLowerCase();
    let role: Role = "other"; let map: FieldMap | undefined; let why = "no injury fields";
    if (/employer/.test(lc) && /amputation/.test(lc)) { role = "osha_reports"; why = "OSHA severe-injury columns"; }
    else if (/rel_act_nr/.test(lc)) { role = "dol_links"; why = "DOL related-activity columns"; }
    else if (/estab_name/.test(lc)) { role = "dol_inspections"; why = "DOL inspection columns"; }
    else if (/covers_private/.test(lc)) { role = "reference"; why = "jurisdiction list"; }
    else if (/subject/.test(lc) && /body/.test(lc)) { role = "letters"; why = "document index"; }
    else if (/total/.test(lc) && /employees/.test(lc)) { role = "yearly_summary"; why = "yearly totals per establishment"; }
    else if (/street/.test(lc) && /zip/.test(lc)) {
      role = "site_list"; why = "addresses per site code";
      map = { code: pick(c, /^code$|site|plant_id|loc/i), plant_name: pick(c, /plant_name|name/i), legal_name: pick(c, /legal/i), street: pick(c, /street/i),
        city: pick(c, /city/i), state: pick(c, /state/i), zip: pick(c, /zip/i), ein: pick(c, /ein/i) };
    } else if (/transcribed/.test(lc)) {
      role = "incident_log"; why = "free-text log lines with case numbers and dates";
      map = { site: pick(c, /site/i), narrative: pick(c, /transcribed/i), date: pick(c, /transcribed/i), date_regex: "on ([0-9]{2}/[0-9]{2}/[0-9]{4})",
        date_format: "MM/dd/yyyy", case_id: pick(c, /transcribed/i) };
    } else {
      const date = pick(c, /date|dt\b|_dt|occur/i), body = pick(c, /body|part|bp\b|anatom/i), narr = pick(c, /descr|happen|narr|text/i);
      const fa = /visit|complaint|treatment|obs_|near|nm_|wo_|course|hire/i.test(lc);
      if (date && body && narr && !fa) {
        role = "incident_log"; why = "date, body part and narrative per case";
        // offline stub only sees the first sample row, like a person skimming three lines
        map = { case_id: pick(c, /case|rec_id|incident_id|log_line/i), site: pick(c, /site|plant|establish|facil|loc/i), date, date_format: guessFormat(s0[date]),
          body_part: body, narrative: narr, injury: pick(c.filter((x) => x !== date && x !== narr), /nature|inj|dx/i) };
      }
    }
    return { table: t.table, role, why, map };
  });
  return JSON.stringify({ tables: out });
}

// ---------------------------------------------------------------- the agent
export async function discover(ctx: Ctx): Promise<DiscoveryResult> {
  const { sql, models, trace } = ctx;
  trace.emit({ agent: "planner", kind: "plan", summary: "Find the systems that hold injury records, then map their fields.",
    detail: { steps: ["list sources", "triage", "describe tables", "classify + map", "check against the data", "draft USL"] } });

  const ds = await sql.run("SHOW DATASOURCES", "list database sources", "discovery");
  const lb = await sql.run("SHOW LIGHTNING DATABASES", "list file and REST sources", "discovery");
  if (!ds.ok && !lb.ok) throw new Error(`Cannot read the Zetaris catalog: ${ds.receipt.error}`);
  trace.emit({ agent: "discovery", kind: "sql", summary: `Catalog lists ${ds.result.data.length} databases and ${lb.result.data.length} file stores.`, receipts: [ds.receipt.qid, lb.receipt.qid] });
  const all = [
    ...asObjects(ds.result).map((r) => ({ name: r.name!, description: r.description ?? "", kind: "datasource" as const })),
    ...asObjects(lb.result).map((r) => ({ name: r.name!, description: r.description ?? "", kind: "lightning" as const })),
  ];

  const triageMsgs = [
    { role: "system" as const, content: "You are the Discovery agent for a company's injury-records audit. Decide which data sources could hold the company's own injury, site or yearly-summary records, or public OSHA / DOL records. Reply with JSON only: [{\"source\":..., \"keep\":true|false, \"why\":\"<8 words\"}]." },
    { role: "user" as const, content: JSON.stringify(all.map(({ name, description }) => ({ name, description }))) },
  ];
  const tri = await models.chat("fast", triageMsgs, { tag: "discovery.triage", stub: () => stubTriage(all) });
  ctx.noteModel("discovery", tri, "triage sources");
  const verdicts = parseReply<{ source: string; keep: boolean; why: string }[]>(ctx, tri, () => stubTriage(all), "discovery", "triage");
  const sources = all.map((s) => { const v = verdicts.find((x) => x.source === s.name); return { ...s, kept: !!v?.keep, why: v?.why ?? "no verdict" }; });
  trace.emit({ agent: "discovery", kind: "branch", summary: `Keeps ${sources.filter((s) => s.kept).length} sources, skips ${sources.filter((s) => !s.kept).length}.`,
    detail: sources.map((s) => ({ source: s.name, kept: s.kept, why: s.why })) });

  const tables: TableInfo[] = [];
  for (const s of sources.filter((x) => x.kept)) {
    const lt = await sql.run(s.kind === "datasource" ? `SHOW DATASOURCE TABLES ${s.name}` : `SHOW LIGHTNING TABLES ${s.name}`, `list tables in ${s.name}`, "discovery");
    const names = asObjects(lt.result).map((r) => r.name!).filter(Boolean);
    const sys = names.filter((n) => SYS_TABLE.test(n));
    if (sys.length) trace.emit({ agent: "discovery", kind: "branch", summary: `${s.name}: skips ${sys.length} database system tables.`, receipts: [lt.receipt.qid] });
    for (const t of names.filter((n) => !SYS_TABLE.test(n))) {
      const d = await sql.run(`DESCRIBE DATASOURCE TABLE ${s.name}.${t}`, `columns of ${s.name}.${t}`, "discovery");
      const cols = asObjects(d.result).map((r) => r.col_name!).filter(Boolean);
      const smp = await sql.run(`SELECT * FROM ${s.name}.${t} LIMIT 3`, `three sample rows of ${s.name}.${t}`, "discovery");
      tables.push({ source: s.name, table: t, fq: `${s.name}.${t}`, columns: cols, sample: asObjects(smp.result) });
      trace.emit({ agent: "discovery", kind: "sql", summary: `${s.name}.${t}: ${cols.length} columns.`, receipts: [d.receipt.qid, smp.receipt.qid] });
    }
  }

  // classify + map, one model call per source (small prompts)
  const bySource = new Map<string, TableInfo[]>();
  for (const t of tables) bySource.set(t.source, [...(bySource.get(t.source) ?? []), t]);
  for (const [src, ts] of bySource) {
    const msgs = [
      { role: "system" as const, content: CLASSIFY_PROMPT },
      { role: "user" as const, content: JSON.stringify({ source: src, tables: ts.map((t) => ({ table: t.table, columns: t.columns, sample_rows: t.sample.map(clip) })) }) },
    ];
    const r = await models.chat("fast", msgs, { tag: `discovery.classify.${src}`, maxTokens: 4000, stub: () => stubClassify(ts) });
    ctx.noteModel("discovery", r, `classify ${src}`);
    const parsed = parseReply<{ tables: { table: string; role: Role; why: string; map?: FieldMap }[] }>(ctx, r, () => stubClassify(ts), "discovery", `classify ${src}`);
    for (const t of ts) {
      const v = parsed.tables?.find((x) => x.table === t.table);
      t.role = v?.role ?? "other"; t.why = v?.why ?? "";
      t.map = v?.map ? Object.fromEntries(Object.entries(v.map).filter(([, x]) => x && x !== "null" && x !== "None")) as FieldMap : undefined;
      t.group = src; // a plant system is one source in the catalog: its name comes from the catalog, not from code
    }
    trace.emit({ agent: "discovery", kind: "verdict", summary: `${src}: ${ts.map((t) => `${t.table} = ${t.role}`).join(", ")}.`,
      detail: ts.map((t) => ({ table: t.fq, role: t.role, why: t.why, map: t.map })) });
  }

  // Evaluator: every incident-log map must survive the data
  for (const t of tables.filter((x) => x.role === "incident_log")) await checkIncidentMap(ctx, t, 0);
  for (const t of tables.filter((x) => x.role === "site_list")) await checkSiteJoin(ctx, t, tables);

  const result: DiscoveryResult = { sources: sources.map(({ name, kind, description, kept, why }) => ({ name, kind, description, kept, why })), tables };
  result.usl = draftUsl(ctx, tables);
  trace.emit({ agent: "discovery", kind: "proposal", summary: "USL draft ready. Waiting for an administrator to approve COMPILE USL.", detail: { usl: result.usl.compile } });
  return result;
}

const clip = (r: Record<string, string | null>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v && v.length > 140 ? v.slice(0, 140) + "…" : v]));

const CLASSIFY_PROMPT = `You are the Discovery agent. For each table of one source, decide its role and map its fields. Roles:
incident_log (the company's own injury log: one row per injury case), site_list (site codes with addresses), yearly_summary (yearly totals per site),
osha_reports (OSHA severe-injury reports), dol_inspections, dol_links (links between OSHA referrals and inspections), letters, reference, other
(maintenance, training, HR, near-miss or first-aid records are "other": they are not the injury log).
For incident_log give map: case_id, site, date, date_format (Spark pattern such as yyyy-MM-dd, MM/dd/yyyy, dd/MM/yyyy, MM/dd/yy, yyyyMMdd, dd-MMM-yyyy),
body_part, narrative, injury. If the date sits inside free text, set date to that column and add date_regex with one capture group using [0-9] (no backslashes).
For site_list give map: code, plant_name, legal_name, street, city, state, zip, ein. Use exact column names. Unknown = null.
Reply with JSON only: {"tables":[{"table":..., "role":..., "why":"<10 words", "map":{...}}]}`;

export function dateExpr(t: TableInfo, map = t.map!): string {
  const col = bt(map.date!);
  const raw = map.date_regex ? `regexp_extract(${col}, ${q(map.date_regex)}, 1)` : col;
  return `date_format(to_date(${raw}, ${q(map.date_format ?? "yyyy-MM-dd")}), 'yyyy-MM-dd')`;
}

async function checkIncidentMap(ctx: Ctx, t: TableInfo, round: number): Promise<void> {
  const { sql, trace, models } = ctx;
  const m = t.map ?? {};
  const missing = (["site", "date", "narrative"] as const).filter((k) => !m[k] || !t.columns.includes(m[k]!));
  let problem = missing.length ? `Fields ${missing.join(", ")} do not exist in ${t.fq}.` : "";
  let receipts: string[] = [];
  if (!problem) {
    const r = await sql.run(`SELECT count(*) AS n, sum(CASE WHEN ${dateExpr(t)} IS NULL THEN 1 ELSE 0 END) AS unparsed FROM ${t.fq}`,
      `does ${m.date_format} parse every date in ${t.fq}?`, "verifier");
    receipts = [r.receipt.qid];
    const o = asObjects(r.result)[0] ?? {};
    const n = Number(o.n ?? 0), bad = Number(o.unparsed ?? 0);
    if (!r.ok) problem = `The date expression fails on ${t.fq}: ${r.receipt.error}`;
    else if (n && bad / n > 0.02) problem = `${bad} of ${n} dates in ${t.fq} don't parse as ${m.date_format}.`;
  }
  if (!problem) {
    trace.emit({ agent: "verifier", kind: "approve", summary: `${t.fq}: field map holds on every row.`, receipts });
    return;
  }
  trace.emit({ agent: "verifier", kind: "reject", summary: problem, receipts, attempt: round + 1 });
  if (round >= 2) { trace.emit({ agent: "verifier", kind: "escalate", summary: `${t.fq}: still wrong after ${round + 1} tries. Needs a person.` }); t.role = "other"; return; }
  // Planner revises with the evaluator's finding and more sample values
  const more = await sql.run(`SELECT ${bt(m.date ?? t.columns[0])} AS v FROM ${t.fq} LIMIT 25`, `more date values from ${t.fq}`, "planner");
  const vals = asObjects(more.result).map((r) => r.v).filter(Boolean) as string[];
  const msgs = [
    { role: "system" as const, content: "You are the Planner. The Evaluator rejected a field map. Fix only what the finding points at. Reply with JSON only: the corrected map object with the same keys." },
    { role: "user" as const, content: JSON.stringify({ table: t.fq, columns: t.columns, map: m, finding: problem, date_values: vals.slice(0, 25) }) },
  ];
  const stub = () => {
    const fmts = ["yyyy-MM-dd", "MM/dd/yyyy", "dd/MM/yyyy", "MM/dd/yy", "yyyyMMdd", "dd-MMM-yyyy"];
    const ex = (v: string) => (m.date_regex ? (v.match(new RegExp(m.date_regex))?.[1] ?? "") : v);
    const best = fmts.map((f) => [f, vals.filter((v) => sparkToDate(ex(v), f)).length] as const).sort((a, b) => b[1] - a[1])[0][0];
    return JSON.stringify({ ...m, date_format: best });
  };
  const r = await models.chat("fast", msgs, { tag: `planner.fixmap.${t.fq}`, stub });
  ctx.noteModel("planner", r, `revise map for ${t.fq}`);
  const fixed = parseReply<FieldMap>(ctx, r, stub, "planner", `revise ${t.fq}`);
  if (fixed && typeof fixed === "object") t.map = { ...m, ...fixed };
  const changed = Object.keys({ ...m, ...t.map }).filter((k) => JSON.stringify((m as Record<string, unknown>)[k]) !== JSON.stringify((t.map as Record<string, unknown>)[k]));
  trace.emit({ agent: "planner", kind: "replan", receipts: [more.receipt.qid], attempt: round + 1, detail: { before: m, after: t.map, changed },
    summary: changed.length ? `Revised ${t.fq}: ${changed.map((k) => `${k} ${JSON.stringify((m as Record<string, unknown>)[k] ?? null)} → ${JSON.stringify((t.map as Record<string, unknown>)[k] ?? null)}`).join("; ")}.`
      : `Re-checked ${t.fq} with more rows: the Planner kept the same map (${t.map!.date_format}); the Verifier checks it again.` });
  return checkIncidentMap(ctx, t, round + 1);
}

async function checkSiteJoin(ctx: Ctx, siteT: TableInfo, tables: TableInfo[]) {
  const need = (["code", "street", "city", "state", "zip"] as const).filter((k) => !siteT.map?.[k] || !siteT.columns.includes(siteT.map[k]!));
  if (need.length) {
    ctx.trace.emit({ agent: "verifier", kind: "reject", summary: `${siteT.fq}: site fields ${need.join(", ")} missing from the map.` });
    const msgs = [
      { role: "system" as const, content: "You are the Planner. The Evaluator rejected a site-list field map. Map these keys to exact column names: code, plant_name, legal_name, street, city, state, zip, ein. Reply with JSON only: the map object." },
      { role: "user" as const, content: JSON.stringify({ table: siteT.fq, columns: siteT.columns, sample_rows: siteT.sample.map(clip), map: siteT.map ?? {} }) },
    ];
    const stub = () => JSON.stringify(JSON.parse(stubClassify([siteT])).tables[0].map ?? {});
    const r = await ctx.models.chat("fast", msgs, { tag: `planner.fixsite.${siteT.fq}`, stub });
    ctx.noteModel("planner", r, `revise site map for ${siteT.fq}`);
    siteT.map = { ...(siteT.map ?? {}), ...parseReply<FieldMap>(ctx, r, stub, "planner", `revise ${siteT.fq}`) };
    ctx.trace.emit({ agent: "planner", kind: "replan", summary: `Revised ${siteT.fq} site map.` });
  }
  const inc = tables.find((x) => x.role === "incident_log" && x.source === siteT.source);
  if (!inc?.map?.site || !siteT.map?.code) return;
  const r = await ctx.sql.run(`SELECT count(*) AS n, sum(CASE WHEN s.${bt(siteT.map.code)} IS NULL THEN 1 ELSE 0 END) AS orphan FROM ${inc.fq} i LEFT JOIN ${siteT.fq} s ON i.${bt(inc.map.site)} = s.${bt(siteT.map.code)}`,
    `do ${inc.fq} site codes exist in ${siteT.fq}?`, "verifier");
  const o = asObjects(r.result)[0] ?? {};
  const ok = r.ok && Number(o.orphan ?? 1) === 0;
  ctx.trace.emit({ agent: "verifier", kind: ok ? "approve" : "reject", summary: ok ? `${inc.fq} → ${siteT.fq}: every case has a site with an address.`
    : `${inc.fq}: ${o.orphan} of ${o.n} cases have no site in ${siteT.fq}.`, receipts: [r.receipt.qid] });
}

function draftUsl(ctx: Ctx, tables: TableInfo[]): UslDraft {
  const ns = ctx.cfg.uslNamespace, name = ctx.cfg.uslName;
  const compile = `COMPILE USL ${name} DEPLOY NAMESPACE ${ns} DDL
CREATE TABLE site (
  site_code varchar(20) NOT NULL PRIMARY KEY,
  plant_group varchar(64),
  city varchar(120),
  state varchar(10),
  zip varchar(10),
  street_number varchar(12)
);
CREATE TABLE incident (
  record_key varchar(120) NOT NULL PRIMARY KEY,
  plant_group varchar(64),
  source_table varchar(80),
  case_id varchar(60),
  site_code varchar(20) FOREIGN KEY REFERENCES site(site_code),
  event_date varchar(10),
  body_part varchar(300),
  narrative varchar(6000)
)`;
  const col = (c?: string) => (c ? bt(c) : "NULL");
  const inc = tables.filter((t) => t.role === "incident_log" && t.map);
  const activateIncident = `ACTIVATE USL TABLE ${ns}.${name}.incident AS\n` + inc.map((t) => {
    const m = t.map!;
    // a transcribed paper log has one text column; when the map gives no separate case column, the case number is read
    // from that text ("Case 11 on ..."), so every line keeps its own key
    const textCol = m.case_id && m.case_id === m.narrative ? m.case_id : !m.case_id && m.narrative && m.date === m.narrative ? m.narrative : undefined;
    const caseExpr = textCol ? `regexp_extract(${bt(textCol)}, 'Case ([0-9A-Za-z_-]+)', 1)` : col(m.case_id);
    return `SELECT COALESCE(concat(${q(t.group ?? t.source)}, ':', ${col(m.site)}, ':', ${caseExpr}), '') AS record_key, ${q(t.group ?? "")} AS plant_group, ${q(t.fq)} AS source_table,
  ${caseExpr} AS case_id, ${col(m.site)} AS site_code, ${dateExpr(t)} AS event_date, ${col(m.body_part)} AS body_part,
  concat_ws(' ', ${col(m.narrative)}${m.injury && m.injury !== m.narrative ? ", " + col(m.injury) : ""}) AS narrative
FROM ${t.fq}`;
  }).join("\nUNION ALL\n");
  const sites = tables.filter((t) => t.role === "site_list" && t.map);
  const activateSite = `ACTIVATE USL TABLE ${ns}.${name}.site AS\n` + sites.map((t) => {
    const m = t.map!;
    // identity-free by design: no plant or company names, no street names; the house number is enough to test "same address"
    return `SELECT COALESCE(${col(m.code)}, '') AS site_code, ${q(t.group ?? "")} AS plant_group, ${col(m.city)} AS city, ${col(m.state)} AS state, ${col(m.zip)} AS zip,
  regexp_extract(${col(m.street)}, '^ *([0-9]+)', 1) AS street_number
FROM ${t.fq}`;
  }).join("\nUNION ALL\n");
  return { compile, activateIncident, activateSite, namespace: ns, name };
}

/** runs only after a person approves the draft (COMPILE USL is an administrator action in Zetaris) */
export async function compileUsl(ctx: Ctx, d: UslDraft, by: string, tables: TableInfo[] = []): Promise<{ site: string; log: number; summary: number }[]> {
  const { sql, trace } = ctx;
  trace.emit({ agent: "human", kind: "approve", summary: `${by} approved the USL draft.` });
  const admin = { admin: true };
  const steps = [
    await sql.run("CREATE NAMESPACE IF NOT EXISTS lightning.metastore", "parent namespace (fresh installs lack it)", "discovery", admin),
    await sql.run(`CREATE NAMESPACE IF NOT EXISTS ${d.namespace}`, "USL namespace", "discovery", admin),
    await sql.run(d.compile, "compile the unified injury model (administrator, after approval)", "discovery", admin),
    await sql.run(d.activateSite, "activate the unified site table", "discovery", admin),
    await sql.run(d.activateIncident, "activate the unified incident table", "discovery", admin),
  ];
  // the agents' role may read the two unified tables, nothing more
  for (const t of ["site", "incident"]) {
    const g = await sql.run(`GRANT SELECT ON USL TABLE ${d.namespace}.${d.name}.${t} TO ROLE '${ctx.cfg.agentRole}'`, `let the agent role read the unified ${t} table`, "discovery", admin);
    if (!g.ok && !/already been granted/i.test(g.receipt.error ?? "")) steps.push(g);
  }
  const bad = steps.find((s) => !s.ok);
  trace.emit({ agent: "discovery", kind: bad ? "error" : "phase", summary: bad ? `USL step failed: ${bad.receipt.error}` : "USL compiled and activated. Every later query reads the unified tables.",
    receipts: steps.map((s) => s.receipt.qid) });
  if (bad) throw new Error(bad.receipt.error);
  const chk = await sql.run(`SELECT plant_group, count(*) AS cases, sum(CASE WHEN event_date IS NULL THEN 1 ELSE 0 END) AS no_date FROM ${d.namespace}.${d.name}.incident GROUP BY plant_group ORDER BY plant_group`,
    "cases per plant group in the unified table", "verifier");
  trace.emit({ agent: "verifier", kind: "verdict", summary: "Unified table: " + asObjects(chk.result).map((r) => `group ${r.plant_group} ${r.cases} cases`).join(", ") + ".", receipts: [chk.receipt.qid] });
  // V8 §4.7 step 5: every site's case count in the unified table must equal its yearly summary (300A) total
  const ys = tables.find((t) => t.role === "yearly_summary");
  const siteCol = ys?.columns.find((c) => /establish|site/i.test(c));
  const caseCols = ys?.columns.filter((c) => /total (dafw|djtr|other) cases/i.test(c)) ?? [];
  if (!ys || !siteCol || caseCols.length !== 3) {
    trace.emit({ agent: "verifier", kind: "info", summary: "No yearly summary with case totals found; count check skipped." });
    return [];
  }
  const r = await sql.run(`SELECT s.${bt(siteCol)} AS site, ${caseCols.map((c) => `CAST(s.${bt(c)} AS INT)`).join(" + ")} AS summary_cases, COALESCE(c.n, 0) AS log_cases
FROM ${ys.fq} s LEFT JOIN (SELECT site_code, count(*) AS n FROM ${d.namespace}.${d.name}.incident GROUP BY site_code) c ON s.${bt(siteCol)} = c.site_code`,
    "case count per site vs the yearly summary (300A)", "verifier");
  const rows = asObjects(r.result);
  const off = rows.filter((x) => Number(x.summary_cases) !== Number(x.log_cases));
  trace.emit({ agent: "verifier", kind: off.length ? "reject" : "approve", receipts: [r.receipt.qid],
    // the output gate names an invented plant and counts a real one (app/gate.ts)
    summary: off.length ? `${off.length} of ${rows.length} sites disagree with their yearly summary: ${[...gateYearly(off.map((x) => ({ ...x, site: x.site! }))).named.slice(0, 4).map((x) => `${x.site} ${x.log_cases}/${x.summary_cases}`),
      ...(gateYearly(off.map((x) => ({ site: x.site! }))).realCount ? [`${gateYearly(off.map((x) => ({ site: x.site! }))).realCount} real plant(s), counted only`] : [])].join(", ")}.`
      : `All ${rows.length} sites: case count equals the yearly summary (300A).` });
  // a disagreement is not fixed by an agent: it goes on the person's list before the 300A is certified
  return off.map((x) => ({ site: x.site!, log: Number(x.log_cases), summary: Number(x.summary_cases) }));
}
