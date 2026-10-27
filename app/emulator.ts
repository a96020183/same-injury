// SAMPLE_MODE fallback for run_sql: answers the same Zetaris statements from the bundled CSVs with node:sqlite.
// Used only when a statement is not in the recorded Zetaris cassette (for example a judge changed a prompt).
// Every receipt it produces says backend "emulator", so nothing it returns can pass for a live Zetaris answer.
// Spark functions the agents use are shimmed: to_date, datediff, date_add, regexp_extract, rlike, levenshtein.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

export type SqlResult = { headers: string[]; data: (string | null)[][] };

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** Spark-style to_date(s, pattern) for the patterns the plant systems use. Returns ISO date or null (Spark returns null too). */
export function sparkToDate(s: unknown, fmt?: unknown): string | null {
  if (s === null || s === undefined) return null;
  const str = String(s).trim();
  if (!fmt) { const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; }
  const f = String(fmt);
  let re = "", order: string[] = [], i = 0;
  while (i < f.length) {
    const rest = f.slice(i);
    const tok = ["yyyy", "MMM", "MM", "dd", "yy", "M", "d"].find((t) => rest.startsWith(t));
    if (tok) {
      order.push(tok);
      re += tok === "yyyy" ? "(\\d{4})" : tok === "yy" ? "(\\d{2})" : tok === "MMM" ? "([A-Za-z]{3})" : tok.length === 2 ? "(\\d{2})" : "(\\d{1,2})";
      i += tok.length;
    } else { re += f[i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"); i++; }
  }
  const m = str.match(new RegExp("^" + re + "$"));
  if (!m) return null;
  let y = 0, mo = 0, d = 0;
  order.forEach((t, k) => {
    const v = m[k + 1];
    if (t === "yyyy") y = +v; else if (t === "yy") y = 2000 + +v;
    else if (t === "MMM") mo = MONTHS.indexOf(v.toLowerCase()) + 1; else if (t[0] === "M") mo = +v; else d = +v;
  });
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return dt.toISOString().slice(0, 10);
}

function lev(a: string, b: string) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function jsRegex(p: string) { let flags = ""; if (p.startsWith("(?i)")) { flags = "i"; p = p.slice(4); } return new RegExp(p, flags); }

type Catalog = {
  datasources: { name: string; description: string; folder: string | null; engine?: string; systemTables?: string[] }[];
  lightning: { name: string; description: string; tables: Record<string, string> }[];
  policies?: Record<string, Record<string, string>>; // "source.table" -> column -> mask regex (Zetaris MASKED policy for the agent role)
};

export class ZetarisEmulator {
  private db = new DatabaseSync(":memory:");
  private cat: Catalog;
  private tables = new Map<string, { file: string; cols: string[]; kind: string }>(); // "src.table" -> info
  private usl = new Map<string, string[]>(); // "ns.usl" -> table names

  constructor(private dir: string) {
    this.cat = JSON.parse(readFileSync(path.join(dir, "catalog.json"), "utf8"));
    this.db.function("to_date", { varargs: true, deterministic: true }, (...a: unknown[]) => sparkToDate(a[0], a[1]));
    this.db.function("datediff", { deterministic: true }, (e: unknown, s: unknown) => {
      const a = sparkToDate(e), b = sparkToDate(s);
      return a && b ? Math.round((Date.parse(a) - Date.parse(b)) / 86400000) : null;
    });
    this.db.function("date_add", { deterministic: true }, (d: unknown, n: unknown) => {
      const a = sparkToDate(d); if (!a) return null;
      return new Date(Date.parse(a) + Number(n) * 86400000).toISOString().slice(0, 10);
    });
    this.db.function("date_format", { varargs: true, deterministic: true }, (...a: unknown[]) => sparkToDate(a[0])); // only 'yyyy-MM-dd' is used
    this.db.function("regexp_extract", { deterministic: true }, (s: unknown, p: unknown, i: unknown) => {
      if (s === null || s === undefined) return null;
      const m = String(s).match(jsRegex(String(p)));
      return m ? (m[Number(i ?? 1)] ?? "") : "";
    });
    this.db.function("rlike", { deterministic: true }, (s: unknown, p: unknown) => (s === null || s === undefined ? null : jsRegex(String(p)).test(String(s)) ? 1 : 0));
    this.db.function("levenshtein", { deterministic: true }, (a: unknown, b: unknown) => (a == null || b == null ? null : lev(String(a), String(b))));
    for (const ds of this.cat.datasources) {
      if (!ds.folder) continue; // listed in the catalog only (SQLite allows 10 attached databases)
      this.db.exec(`ATTACH DATABASE ':memory:' AS ${ds.name}`);
      const folder = path.join(dir, ds.folder);
      for (const f of readdirCsv(folder)) this.load(ds.name, path.basename(f, ".csv").toLowerCase(), f, "datasource");
    }
    for (const lb of this.cat.lightning) {
      if (!Object.keys(lb.tables).length) continue;
      this.db.exec(`ATTACH DATABASE ':memory:' AS ${lb.name}`);
      for (const [t, rel] of Object.entries(lb.tables)) this.load(lb.name, t, path.join(dir, rel), "filestore");
    }
    this.db.exec(`ATTACH DATABASE ':memory:' AS usl`);
  }

  private load(src: string, table: string, file: string, kind: string) {
    const rows = parseCsv(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    const cols = rows[0];
    const masks = this.cat.policies?.[`${src}.${table}`] ?? {};
    for (const [col, re] of Object.entries(masks)) {
      const i = cols.indexOf(col); if (i < 0) continue;
      const rx = new RegExp(re, "g");
      for (const r of rows.slice(1)) if (r[i]) r[i] = r[i].replace(rx, "*");
    }
    this.db.exec(`CREATE TABLE ${src}."${table}" (${cols.map((c) => `"${c.replace(/"/g, '""')}" TEXT`).join(", ")})`);
    const ins = this.db.prepare(`INSERT INTO ${src}."${table}" VALUES (${cols.map(() => "?").join(",")})`);
    this.db.exec("BEGIN");
    for (const r of rows.slice(1)) ins.run(...cols.map((_, i) => r[i] ?? null));
    this.db.exec("COMMIT");
    this.tables.set(`${src}.${table}`, { file, cols, kind });
  }

  run(sqlIn: string): SqlResult {
    const sql = sqlIn.trim().replace(/;\s*$/, "");
    let m: RegExpMatchArray | null;
    if (/^SHOW DATASOURCES$/i.test(sql))
      return { headers: ["name", "description", "id"], data: this.cat.datasources.map((d, i) => [d.name, d.description, String(3900 + i)]) };
    if (/^SHOW LIGHTNING DATABASES$/i.test(sql))
      return { headers: ["name", "description", "id"], data: this.cat.lightning.map((d, i) => [d.name, d.description, String(4800 + i)]) };
    if ((m = sql.match(/^SHOW DATASOURCE TABLES (\w+)( WITH STATISTICS)?$/i))) {
      const ds = this.cat.datasources.find((d) => d.name === m![1]);
      if (!ds) throw new Error(`datasource ${m[1]} not found`);
      const own = [...this.tables.keys()].filter((k) => k.startsWith(ds.name + ".")).map((k) => k.split(".")[1]);
      return { headers: ["name", "description", "tags", "number of rows", "size in bytes", "analysed time", "index time"],
        data: [...(ds.systemTables ?? []), ...own].map((n) => [n, null, null, null, null, null, null]) };
    }
    if ((m = sql.match(/^SHOW LIGHTNING TABLES (\w+)$/i))) {
      const lb = this.cat.lightning.find((d) => d.name === m![1]);
      if (!lb) throw new Error(`lightning database ${m[1]} not found`);
      return { headers: ["name", "materialized_table", "source_table", "table_type", "format", "id"],
        data: Object.entries(lb.tables).map(([t, rel], i) => [t, null, `s3a://l1data/${rel}`, "filestore", "csv", String(4900 + i)]) };
    }
    if ((m = sql.match(/^DESCRIBE DATASOURCE TABLE (\w+)\.(\w+)$/i))) {
      const t = this.tables.get(`${m[1]}.${m[2].toLowerCase()}`);
      if (!t) throw new Error(`table ${m[1]}.${m[2]} not found`);
      return { headers: ["col_name", "data_type", "comment", "description", "tags"], data: t.cols.map((c) => [c, "string", null, null, null]) };
    }
    // the emulator has no users, roles or grants: it says so instead of pretending the statement took effect
    if (/^(GRANT |ASSIGN )/i.test(sql)) return { headers: ["Result"], data: [["emulator: not enforced (no roles here; only live Zetaris enforces GRANT and ASSIGN)"]] };
    if (/^CREATE NAMESPACE/i.test(sql)) return { headers: ["Result"], data: [] };
    if ((m = sql.match(/^COMPILE USL (\w+)(?: DEPLOY)? NAMESPACE ([\w.]+) DDL\s+([\s\S]+)$/i))) {
      const names = [...m[3].matchAll(/CREATE TABLE (\w+)/gi)].map((x) => x[1].toLowerCase());
      if (!names.length) throw new Error("USL DDL has no CREATE TABLE");
      this.usl.set(`${m[2]}.${m[1]}`, names);
      return { headers: ["Result"], data: [] };
    }
    if ((m = sql.match(/^ACTIVATE USL TABLE ([\w.]+)\.(\w+)\.(\w+) AS\s+([\s\S]+)$/i))) {
      const key = `${m[1]}.${m[2]}`;
      if (!this.usl.get(key)?.includes(m[3].toLowerCase())) throw new Error(`USL table ${m[2]}.${m[3]} is not compiled`);
      this.db.exec(`DROP TABLE IF EXISTS usl."${m[2]}__${m[3]}"`);
      this.db.exec(`CREATE TABLE usl."${m[2]}__${m[3]}" AS ${this.rewrite(m[4])}`);
      return { headers: ["Result"], data: [] };
    }
    if (/^EXPLAIN /i.test(sql)) throw new Error("EXPLAIN is only available on a live Zetaris (emulator has no physical plan)");
    if (!/^(SELECT|WITH)\b/i.test(sql)) throw new Error(`emulator does not support: ${sql.slice(0, 40)}`);
    const st = this.db.prepare(this.rewrite(sql));
    const rows = st.all() as Record<string, unknown>[];
    const headers = st.columns().map((c) => c.name);
    return { headers, data: rows.map((r) => headers.map((h) => (r[h] === null || r[h] === undefined ? null : String(r[h])))) };
  }

  /** Spark SQL -> SQLite: USL 5-part names, `x rlike 'p'`, `x NOT rlike 'p'`. */
  private rewrite(sql: string): string {
    return sql
      .replace(/lightning\.metastore\.\w+\.(\w+)\.(\w+)/gi, (_, u, t) => `usl."${u}__${t}"`)
      .replace(/([\w.`"]+|\([^()]*\))\s+NOT\s+RLIKE\s+('(?:[^']|'')*')/gi, "NOT rlike($1, $2)")
      .replace(/([\w.`"]+|\([^()]*\))\s+RLIKE\s+('(?:[^']|'')*')/gi, "rlike($1, $2)");
  }
}

function readdirCsv(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((f) => f.endsWith(".csv")).sort().map((f) => path.join(folder, f));
}
