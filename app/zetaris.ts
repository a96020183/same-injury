// run_sql: the only way any agent gets evidence. Every call returns a receipt (query id, SQL, backend, sources, row count,
// result hash). Backends:
//   zetaris  - live local Zetaris REST API (POST /sql-editor/sqls/run)
//   replay   - a recorded Zetaris response for the exact same SQL (SAMPLE_MODE)
//   emulator - bundled SQLite emulator over the same CSVs, only on a replay miss or when Zetaris is down
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config, scrub } from "./config.ts";
import { ZetarisEmulator, type SqlResult } from "./emulator.ts";

export type Backend = "zetaris" | "replay" | "emulator";
export type Receipt = {
  qid: string; sql: string; purpose: string; agent: string; backend: Backend; sources: string[]; as: "agent-role" | "admin";
  rows: number; resultSha: string; rowsSha: string; at: string; ms: number; error?: string;
};

export const sqlKey = (sql: string) => createHash("sha256").update(sql.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 24);
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
// every <source>.<table> after FROM / JOIN (a USL table is lightning.metastore.<namespace>.<model>.<table>)
const SOURCE_RE = /\b(?:FROM|JOIN)\s+(?:lightning\.metastore\.\w+\.(\w+)\.(\w+)|`?(\w+)`?\.`?(\w+)`?)/gi;

export class SqlTool {
  readonly receipts: Receipt[] = [];
  private cassette = new Map<string, SqlResult & { error?: string }>(); // a recorded refusal replays as the same refusal
  private emulator?: ZetarisEmulator;
  private cassetteFile: string;
  readonly mode: "live" | "sample";

  constructor(opts: { mode?: "live" | "sample"; record?: boolean; dir?: string; agentKey?: string } = {}) {
    this.agentKey = opts.agentKey;
    this.mode = opts.mode ?? (config.sampleMode && !config.liveZetaris ? "sample" : "live");
    const dir = opts.dir ?? config.sampleDir;
    this.cassetteFile = path.join(dir, "zetaris_cassette.jsonl");
    this.record = opts.record ?? false;
    this.dir = dir;
    if (existsSync(this.cassetteFile))
      for (const line of readFileSync(this.cassetteFile, "utf8").split("\n").filter(Boolean)) {
        const r = JSON.parse(line); this.cassette.set(r.key, r.error ? { headers: [], data: [], error: r.error } : r.result);
      }
  }
  private record: boolean;
  private agentKey?: string; // a narrower role than the default agent role (one company only), for the live exam
  private dir: string;

  private emu() { return (this.emulator ??= new ZetarisEmulator(this.dir)); }

  private async live(sql: string, admin: boolean): Promise<SqlResult> {
    const key = admin ? config.zetaris.apiKey : (this.agentKey ?? config.zetaris.agentKey);
    if (!key) throw new Error(admin ? "ZETARIS_API_KEY is not set" : "ZETARIS_AGENT_API_KEY is not set (run scripts/setup_governance.py)");
    const res = await fetch(config.zetaris.url.replace(/\/$/, "") + "/sql-editor/sqls/run", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "X-Org-ID": config.zetaris.orgId, "X-Request-ID": randomUUID(), "Content-Type": "application/json" },
      body: JSON.stringify({ queryId: randomUUID(), sql, source: "SqlEditor", limit: 5000 }),
      signal: AbortSignal.timeout(300_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Zetaris HTTP ${res.status}: ${scrub(text).slice(0, 600)}`);
    const out = JSON.parse(text);
    return { headers: out.headers ?? [], data: out.data ?? [] };
  }

  /** opts.admin: only the person-approved USL compile runs with the administrator key; everything else runs as the agent role */
  /** the statement running right now, for the progress line in the UI */
  inflight?: { purpose: string; agent: string; since: number };

  async run(sql: string, purpose: string, agent: string, opts: { admin?: boolean } = {}): Promise<{ ok: boolean; result: SqlResult; receipt: Receipt }> {
    this.inflight = { purpose, agent, since: Date.now() };
    try { return await this.runInner(sql, purpose, agent, opts); } finally { this.inflight = undefined; }
  }

  private async runInner(sql: string, purpose: string, agent: string, opts: { admin?: boolean }): Promise<{ ok: boolean; result: SqlResult; receipt: Receipt }> {
    const admin = !!opts.admin;
    const t0 = Date.now();
    if (this.mode === "sample" && config.paceMs) await new Promise((r) => setTimeout(r, config.paceMs));
    const key = sqlKey((admin ? "admin|" : "") + sql); // the same SQL answers differently per identity (column policies)
    let backend: Backend = "zetaris", result: SqlResult = { headers: [], data: [] }, error: string | undefined;
    try {
      if (this.mode === "sample") {
        const hit = this.cassette.get(key);
        // keep the emulator's USL state in step even when the statement itself is replayed
        if (hit && /^\s*(COMPILE USL|ACTIVATE USL|CREATE NAMESPACE)/i.test(sql)) { try { this.emu().run(sql); } catch { /* replay is the answer */ } }
        if (hit?.error) { backend = "replay"; error = hit.error; }
        else if (hit) { result = hit; backend = "replay"; }
        else { backend = "emulator"; result = this.emu().run(sql); }
      } else {
        try { result = await this.live(sql, admin); }
        catch (e) {
          const msg = String((e as Error).message);
          // only fall back when Zetaris is unreachable; a SQL error from Zetaris is a real answer and is reported as such
          if (!/fetch failed|ECONNREFUSED|timeout|aborted|not set/i.test(msg)) {
            if (this.record) appendFileSync(this.cassetteFile, JSON.stringify({ key, sql: scrub(sql), error: scrub(msg), at: new Date().toISOString() }) + "\n");
            throw e;
          }
          const hit = this.cassette.get(key);
          if (hit) { result = hit; backend = "replay"; } else { result = this.emu().run(sql); backend = "emulator"; }
          error = "Zetaris unreachable, served by " + backend;
        }
        if (backend === "zetaris" && this.record) {
          appendFileSync(this.cassetteFile, JSON.stringify({ key, sql: scrub(sql), result, at: new Date().toISOString() }) + "\n");
          this.cassette.set(key, result);
        }
      }
    } catch (e) {
      error = scrub(String((e as Error).message ?? e));
    }
    const sources = [...new Set([...sql.matchAll(SOURCE_RE)].map((m) => (m[1] ? `usl.${m[1]}.${m[2]}` : `${m[3]}.${m[4]}`).toLowerCase()))];
    const receipt: Receipt = {
      qid: `Q-${String(this.receipts.length + 1).padStart(4, "0")}`, sql: scrub(sql), purpose, agent, backend, sources, as: admin ? "admin" : "agent-role",
      rows: result.data.length, resultSha: sha(result), rowsSha: sha([result.headers, result.data.map((r) => JSON.stringify(r)).sort()]), at: new Date().toISOString(), ms: Date.now() - t0,
      ...(error ? { error } : {}),
    };
    this.receipts.push(receipt);
    const ok = !error || error.startsWith("Zetaris unreachable");
    return { ok, result, receipt };
  }
}

/** rows as objects keyed by header (Zetaris returns every value as a string or null) */
export const asObjects = (r: SqlResult) => r.data.map((row) => Object.fromEntries(r.headers.map((h, i) => [h, row[i]])) as Record<string, string | null>);
export const q = (s: string) => "'" + String(s).replace(/'/g, "''") + "'";
export const bt = (c: string) => "`" + c.replace(/`/g, "``") + "`";
