// One audit run: discovery -> (person approves USL) -> matching -> (person reviews merge proposals) -> counsel export.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config, scrub } from "./config.ts";
import { Trace } from "./trace.ts";
import { SqlTool } from "./zetaris.ts";
import { Models } from "./llm.ts";
import { L1World } from "./world.ts";
import { makeNoteModel, type Ctx } from "./agents/ctx.ts";
import { discover, compileUsl, type DiscoveryResult } from "./agents/discovery.ts";
import { Matcher } from "./agents/matching.ts";
import { skeptic, type SkepticResult } from "./agents/skeptic.ts";
import { buildItems, certifySummary, distinctItems, nextSteps, type Item } from "./agents/final.ts";
import { asObjects, q } from "./zetaris.ts";
import { renderExport } from "./export.ts";
import { gateItems, gateLanes, gateQueue, gateReceipt, gateWorldLog, gateReviewer } from "./gate.ts";

export type Phase = "idle" | "discovering" | "awaiting_usl" | "compiling" | "matching" | "review" | "error";

export class Run {
  readonly id = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-") + "-" + Math.random().toString(16).slice(2, 6);
  readonly dir: string;
  readonly trace: Trace;
  readonly ctx: Ctx;
  phase: Phase = "idle";
  error?: string;
  discovery?: DiscoveryResult;
  matcher?: Matcher;
  items: Item[] = [];
  skeptic?: SkepticResult;
  yearly: { site: string; log: number; summary: number }[] = [];

  constructor(opts: { record?: boolean; sqlMode?: "live" | "sample" } = {}) {
    this.dir = path.join(config.runsDir, this.id);
    mkdirSync(this.dir, { recursive: true });
    this.trace = new Trace(this.id, this.dir);
    const sql = new SqlTool({ mode: opts.sqlMode, record: opts.record });
    const models = new Models({ record: opts.record, runDir: this.dir });
    models.siteOf = (lane) => this.trace.siteOf(lane);
    this.ctx = { sql, models, trace: this.trace, world: new L1World(), cfg: config.zetaris, noteModel: makeNoteModel(this.trace) };
    this.trace.emit({ agent: "system", kind: "phase", summary: `Run ${this.id} · data: ${sql.mode === "sample" ? "SAMPLE_MODE (recorded Zetaris answers)" : "live Zetaris"} · models: Nightshift${config.nightshift.offline || !config.nightshift.token ? " (offline: replay or stub)" : ""}` });
  }

  private async guard(phase: Phase, next: Phase, fn: () => Promise<void>) {
    this.phase = phase;
    try { await fn(); this.phase = next; }
    catch (e) { this.phase = "error"; this.error = scrub(String((e as Error).message ?? e)); this.trace.emit({ agent: "system", kind: "error", summary: this.error }); }
    this.save();
  }

  start() { return this.guard("discovering", "awaiting_usl", async () => { this.discovery = await discover(this.ctx); }); }

  approveUsl(by: string) {
    if (this.phase !== "awaiting_usl" || !this.discovery?.usl) throw new Error("no USL draft waiting");
    return this.guard("compiling", "review", async () => {
      this.yearly = await compileUsl(this.ctx, this.discovery!.usl!, by, this.discovery!.tables);
      this.phase = "matching";
      this.matcher = new Matcher(this.ctx, this.discovery!.tables);
      await this.matcher.load();
      await this.matcher.runAll();
      this.skeptic = await skeptic(this.ctx, this.matcher);
      this.items = buildItems(this.ctx, this.matcher.lanes);
      // what the agents concluded, before any person (or the CLI's operator flag) decides an identity: the README quotes this
      this.itemsAtReview = this.items.map((i) => ({ ...i }));
    });
  }

  itemsAtReview?: Item[];
  private reviewerCache = new Map<string, unknown>();
  /** The reviewer sees what the agents cannot: the same OSHA row read with the administrator's key, and the plant's legal name. */
  async reviewerView(proposalId: string) {
    if (this.reviewerCache.has(proposalId)) return this.reviewerCache.get(proposalId);
    const item = this.items.find((i) => i.proposalId === proposalId && i.reportId && i.site);
    if (!item) throw new Error("no item for this proposal");
    const { sql, trace } = this.ctx;
    const sirQ = `SELECT ID, Employer, Address1, City, Zip FROM ${this.matcher!.T.sir} WHERE ID = ${q(item.reportId!)}`;
    const asAgent = await sql.run(sirQ, `OSHA report ${item.reportId} as the agents see it`, "reviewer");
    const asReviewer = await sql.run(sirQ, `OSHA report ${item.reportId} as the reviewer sees it`, "reviewer", { admin: true });
    const group = this.matcher?.sites.find((x) => x.code === item.site)?.group ?? "";
    const siteTable = this.discovery?.tables.find((t) => t.role === "site_list" && t.group === group);
    const plant = siteTable ? await sql.run(`SELECT * FROM ${siteTable.fq} WHERE ${"`" + (siteTable.map?.code ?? "code") + "`"} = ${q(item.site!)}`,
      `plant ${item.site} as the reviewer sees it`, "reviewer", { admin: true }) : undefined;
    const view = { reportId: item.reportId, site: item.site, agent: asObjects(asAgent.result)[0] ?? {}, reviewer: asObjects(asReviewer.result)[0] ?? {},
      plant: plant ? asObjects(plant.result)[0] ?? {} : {}, receipts: [asAgent.receipt.qid, asReviewer.receipt.qid, ...(plant ? [plant.receipt.qid] : [])] };
    this.reviewerCache.set(proposalId, view);
    trace.emit({ agent: "human", kind: "info", receipts: view.receipts, summary: `Reviewer view for ${item.reportId}: the same SQL with the administrator's key shows the names the agents never see.` });
    return view;
  }

  async decideMerge(id: string, approve: boolean, by: string) {
    const p = this.ctx.world.wm.mergeQueue().find((x) => x.id === id);
    if (!p) throw new Error("no such proposal");
    if (p.status !== "pending") return []; // a second click on the same proposal does nothing
    const before = new Map(this.items.map((i) => [i.lane, i.column]));
    if (approve) await this.ctx.world.wm.approveMerge(id, by); else await this.ctx.world.wm.rejectMerge(id, by);
    this.trace.emit({ agent: "human", kind: approve ? "merge" : "reject", summary: `${by} ${approve ? "approved" : "rejected"}: "${p.leftName}" = ${p.rightName}.`, detail: p });
    this.items = buildItems(this.ctx, this.matcher?.lanes ?? []);
    const changed = this.items.filter((i) => before.get(i.lane) !== i.column);
    this.trace.emit({ agent: "world", kind: "conclusion", summary: changed.length ? `Updated ${changed.length} conclusion(s): ${changed.map((c) => `${c.lane} → ${c.column}`).join(", ")}.` : "No conclusion changed." });
    this.save();
    return changed;
  }

  state() {
    const wm = this.ctx.world.wm;
    const queue = wm.mergeQueue().map((p) => ({ ...p, left: p.status === "pending" ? wm.entity(p.leftId)?.attrs : undefined, right: wm.entity(p.rightId)?.attrs }));
    return {
      id: this.id, phase: this.phase, error: this.error, sqlMode: this.ctx.sql.mode,
      busy: busy(this.ctx),
      models: { offline: config.nightshift.offline || !config.nightshift.token, calls: summarizeModels(this.ctx.models.calls) },
      discovery: this.discovery && {
        sources: this.discovery.sources,
        tables: this.discovery.tables.map(({ source, table, fq, columns, role, why, map, group }) => ({ source, table, fq, columns, role, why, map, group })),
        usl: this.discovery.usl,
      },
      // what leaves the run passes the output gate (app/gate.ts)
      items: gateItems(this.items).items, withheld: gateItems(distinctItems(this.items)).withheld, queue: gateQueue(queue), // withheld: one injury seen from both directions counts once, as in the certify table
      lanes: gateLanes((this.matcher?.lanes ?? []).map((l) => ({ id: l.id, dir: l.dir, state: l.state, title: l.title, verdicts: l.verdicts, form301: l.research.form301,
        dol: l.research.dol_inspection, mapDol: l.mapDol, site: l.log?.site ?? l.site?.code, caseId: l.log?.case_id, reportId: l.report?.id ?? l.linkedReport }))),
      certify: certifySummary(this.items, this.yearly),
      skeptic: this.skeptic,
      nextSteps: this.items.length ? nextSteps(this.items, this.yearly) : [],
      reviewer: Object.fromEntries([...this.reviewerCache].filter(([, v]) => { const x = v as { site?: string; reportId?: string }; return !!gateReviewer(x, this.items.find((i) => i.reportId === x.reportId && i.site === x.site)); })),
      counts: { receipts: this.ctx.sql.receipts.length, events: this.trace.events.length, worldEvents: this.ctx.world.wm.log().length },
    };
  }

  save() {
    writeFileSync(path.join(this.dir, "receipts.json"), scrub(JSON.stringify(this.ctx.sql.receipts.map((r) => gateReceipt(r as never)), null, 1)));
    writeFileSync(path.join(this.dir, "items.json"), scrub(JSON.stringify(gateItems(this.items).items, null, 1)));
    if (this.itemsAtReview) writeFileSync(path.join(this.dir, "items_at_review.json"), scrub(JSON.stringify(gateItems(this.itemsAtReview).items, null, 1)));
    writeFileSync(path.join(this.dir, "world_log.json"), scrub(JSON.stringify(gateWorldLog({ events: this.ctx.world.wm.log(), audit: this.ctx.world.wm.audit(), queue: this.ctx.world.wm.mergeQueue() } as never), null, 1)));
    if (this.items.length) writeFileSync(path.join(this.dir, "counsel_export.html"), renderExport(this));
  }
}

/** what the agents are waiting for right now (a model answer or a Zetaris query), with how long it has taken */
function busy(ctx: Ctx) {
  const m = ctx.models.inflight, s = ctx.sql.inflight;
  if (m) return { kind: "model", lane: m.lane, what: m.tag, replay: m.replay, ms: Date.now() - m.since };
  if (s) return { kind: "sql", agent: s.agent, what: s.purpose, ms: Date.now() - s.since };
  return undefined;
}

function summarizeModels(calls: { served: string; source: string; lane: string }[]) {
  const m = new Map<string, number>();
  for (const c of calls) { const k = `${c.lane}|${c.source}|${c.served}`; m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].map(([k, n]) => { const [lane, source, served] = k.split("|"); return { lane, source, served, n }; });
}
