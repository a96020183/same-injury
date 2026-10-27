// Plant group D keeps paper logs. Nemotron Super VL (Nightshift `meterless/vision` lane) reads a scanned OSHA 301 form
// into the fields the log table needs. `npm run vl`
//   SAMPLE_MODE / no token: replays the recorded answers (sample/seed1003/scans/vl_recorded.json) and says so.
//   live: one request at a time through Nightshift; the served model is printed; answers are scored against truth.json;
//   --record writes them to vl_recorded.json.
// The two forms are SYNTHETIC cases (case number, date, times, job, body part, narrative all invented) on a 301 layout,
// handwriting font, noise; the name and sex boxes are blacked out before the scan exists, so no model is asked for them.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { Models, extractJson } from "./llm.ts";

const DIR = path.join(config.sampleDir, "scans");
const truth = JSON.parse(readFileSync(path.join(DIR, "truth.json"), "utf8")) as Record<string, Record<string, string>>;
const recorded = JSON.parse(readFileSync(path.join(DIR, "vl_recorded.json"), "utf8")) as Record<string, { served: string; tokens: number; fields: Record<string, string | null>; recorded: string }>;

export const PROMPT = `This is a scanned, hand-filled OSHA Form 301 incident report. Read it and return ONLY one JSON object, no prose, with exactly these keys:
{"case_no": string as written in item 10,
 "injury_date": "YYYY-MM-DD" (item 11),
 "time_began_work": "HH:MM" 24-hour (item 12),
 "time_of_event": "HH:MM" 24-hour (item 13),
 "job_title": string (the unnumbered "Job title" line),
 "er_visit": "yes" or "no" (item 8, the checked box),
 "inpatient_overnight": "yes" or "no" (item 9, the checked box),
 "side": "left" or "right" (which side of the body was injured, from item 16),
 "body_part": the primary body part injured, from item 16}
If a value is unreadable, use null.`;

/** scoring rule fixed before the gate run (scripts/l1_6_vl_read.py) */
export function fieldOk(k: string, want: string, got: unknown) {
  if (got === null || got === undefined) return false;
  const pad = (s: string) => s.replace(/^(\d):/, "0$1:");
  let g = String(got).trim().toLowerCase(), w = String(want).trim().toLowerCase();
  if (k === "body_part") return g.includes(w.split(" ")[0]);
  if (k.startsWith("time_")) { g = pad(g); w = pad(w); }
  return g.replace(/\s+/g, " ") === w.replace(/\s+/g, " ");
}

export async function readScans() {
  const models = new Models({});
  const live = !config.sampleMode && !config.nightshift.offline && !!config.nightshift.token;
  let right = 0, total = 0;
  const out = [];
  for (const file of Object.keys(truth)) {
    let fields: Record<string, unknown>, served: string, source: string;
    if (live) {
      const img = readFileSync(path.join(DIR, file)).toString("base64");
      const r = await models.chat("vision", [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: "data:image/jpeg;base64," + img } }] }],
        { tag: `vl.${file}`, maxTokens: 2500, stub: () => "{}" });
      fields = extractJson<Record<string, unknown>>(r.text) ?? {}; served = r.served; source = r.source;
      if (process.argv.includes("--record")) recorded[file] = { requested: r.requested, served, tokens: r.tokens ?? 0, fields: fields as Record<string, string | null>, recorded: `${new Date().toISOString().slice(0, 10)} live run (parsed fields)` } as never;
    } else {
      fields = recorded[file].fields; served = recorded[file].served; source = "replay · " + recorded[file].recorded;
    }
    const score = Object.entries(truth[file]).map(([k, w]) => ({ k, want: w, got: fields[k], ok: fieldOk(k, w, fields[k]) }));
    right += score.filter((s) => s.ok).length; total += score.length;
    out.push({ file, served, source, score });
  }
  if (live && process.argv.includes("--record")) writeFileSync(path.join(DIR, "vl_recorded.json"), JSON.stringify(recorded, null, 1));
  return { right, total, out };
}

if (process.argv[1]?.endsWith("vl.ts")) {
  const r = await readScans();
  for (const s of r.out) {
    console.log(`${s.file} · answered by ${s.served} (${s.source})`);
    for (const f of s.score) console.log(`  ${f.ok ? "ok " : "MISS"} ${f.k.padEnd(20)} want ${String(f.want).padEnd(14)} got ${f.got}`);
  }
  console.log(`\n${r.right} of ${r.total} fields correct.`);
}
