// The output gate's rule over every file git would commit (app/gate.ts):
//   (a unit that names a real plant) x (a non-neutral label, or a synthetic record) = 0
// A unit is one trace event, one model answer (with the plant of its lane), one Zetaris result row, one item, one CSV
// row, one JSON entry, one line of text or code, one scan's file name. test/gate.test.ts runs it; scripts/scan_identity.py
// repeats it. Prints a JSON summary: node --no-warnings --import tsx scripts/gate_scan.ts
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { breaks, isReal } from "../app/gate.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
type Hit = { file: string; at: string; sites: string[]; text: string };

export function files(): string[] {
  const run = (c: string) => execSync(c, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 }).split("\n").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...run("git ls-files"), ...run("git ls-files --others --exclude-standard")])].filter((f) => !/^(node_modules|runs)\//.test(f));
}

function units(f: string, body: string): { at: string; text: string; sites: (string | undefined)[] }[] {
  const out: { at: string; text: string; sites: (string | undefined)[] }[] = [];
  const ext = path.extname(f).toLowerCase();
  if (ext === ".jsonl") {
    body.split("\n").forEach((l, i) => {
      if (!l.trim()) return;
      let r: Record<string, unknown>;
      try { r = JSON.parse(l); } catch { out.push({ at: `line ${i + 1}`, text: l, sites: [] }); return; }
      if (r.result && typeof r.result === "object" && Array.isArray((r.result as { data?: unknown[] }).data)) // a Zetaris answer: one unit per row
        ((r.result as { data: unknown[] }).data).forEach((row, j) => out.push({ at: `line ${i + 1} row ${j + 1}`, text: JSON.stringify(row), sites: [] }));
      else if (typeof r.text === "string" && r.tag) out.push({ at: `line ${i + 1} (${r.tag})`, text: r.text, sites: [r.site as string | undefined] }); // a model answer
      else out.push({ at: `line ${i + 1}${r.seq ? ` (event ${r.seq})` : ""}`, text: `${r.summary ?? ""} ${JSON.stringify(r.detail ?? "")}${r.summary === undefined ? l : ""}`, sites: [r.site as string | undefined] });
    });
  } else if (ext === ".json") {
    let j: unknown;
    try { j = JSON.parse(body); } catch { return [{ at: "file", text: body, sites: [] }]; }
    const walk = (v: unknown, at: string, depth: number) => {
      if (Array.isArray(v)) v.forEach((x, i) => (depth < 2 && typeof x === "object" && x && !("lane" in x) ? walk(x, `${at}[${i}]`, depth + 1) : out.push({ at: `${at}[${i}]`, text: JSON.stringify(x), sites: [] })));
      else if (v && typeof v === "object" && depth < 2) for (const [k, x] of Object.entries(v)) (typeof x === "object" && x ? walk(x, `${at}.${k}`, depth + 1) : out.push({ at: `${at}.${k}`, text: `${k}: ${JSON.stringify(x)}`, sites: [] }));
      else out.push({ at, text: JSON.stringify(v), sites: [] });
    };
    walk(j, "$", 0);
  } else if ([".jpg", ".png", ".jpeg"].includes(ext)) {
    out.push({ at: "file name", text: path.basename(f) + (/^301_/.test(path.basename(f)) ? " SYNTHETIC form" : ""), sites: [] }); // a 301 form is a synthetic document
  } else if ([".csv", ".md", ".txt", ".html", ".js", ".mjs", ".ts", ".py", ".sh", ".css", ".yml", ".yaml"].includes(ext) || !ext) {
    body.split("\n").forEach((l, i) => out.push({ at: `line ${i + 1}`, text: l, sites: [] }));
  }
  return out;
}

export function scanOutputs(): { files: number; units: number; hits: Hit[] } {
  const hits: Hit[] = [];
  let n = 0, nf = 0;
  for (const f of files()) {
    let body = "";
    const bin = /\.(jpg|jpeg|png)$/i.test(f);
    if (!bin) { try { body = readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; } }
    nf++;
    for (const u of units(f, body)) {
      n++;
      const b = breaks(u.text, u.sites);
      if (b) hits.push({ file: f, at: u.at, sites: b, text: u.text.slice(0, 200) });
    }
  }
  return { files: nf, units: n, hits };
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  const r = scanOutputs();
  const show = process.argv.includes("--show");
  console.log(JSON.stringify({ files: r.files, units: r.units, real_plant_units_with_non_neutral_or_synthetic: r.hits.length,
    by_file: Object.fromEntries([...new Set(r.hits.map((h) => h.file))].map((f) => [f, r.hits.filter((h) => h.file === f).length])),
    ...(show ? { hits: r.hits } : {}) }, null, 1));
  void isReal;
}
