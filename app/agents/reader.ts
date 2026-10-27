// Reader (Nemotron VL, `vision` lane): some plants keep their injury log on paper OSHA 301 forms. For every amputation
// lane whose log line has a scanned form (scans/301_<site>_case<n>.jpg) the Reader reads the form, checks it against the typed transcription in the unified table,
// and writes what it read into the World Model. For a paper log the form is the only place that records side and body part,
// so the Linker and the Evaluator use these fields when they compare the injury with OSHA's report.
// Vision through Nightshift is unreliable (see docs/nightshift_vl_issue.md): many retries; if it still fails the lane
// goes on with the typed text and the trace says so. SAMPLE_MODE replays the recorded VL answers.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { ModelUnavailable } from "../llm.ts";
import { parseReply, type Ctx } from "./ctx.ts";
import type { Lane } from "./matching.ts";
import { compareBody } from "../rules.ts";

export const FORM_PROMPT = `This is a scanned, hand-filled OSHA Form 301 incident report. Read it and return ONLY one JSON object, no prose, with exactly these keys:
{"establishment": string as written,
 "case_no": string as written in item 10,
 "injury_date": "YYYY-MM-DD" (item 11),
 "time_of_event": "HH:MM" 24-hour (item 13),
 "job_title": string (the unnumbered "Job title" line),
 "er_visit": "yes" or "no" (item 8, the checked box),
 "side": "left" or "right" (which side of the body was injured, from items 15-16),
 "body_part": the injured body part from item 16, as specific as written (for example "thumb" or "index finger"),
 "injury": item 16 as written}
If a value is unreadable, use null.`;

export type Form301 = { establishment?: string; case_no?: string; injury_date?: string; time_of_event?: string; job_title?: string; er_visit?: string; side?: string; body_part?: string; injury?: string };

// Privacy guard: the scan generator (and any real intake step) blacks out the employee name before the form is stored and
// writes the JPEG comment "L1-REDACTED:<fields>". A form without that marker never goes to a model.
export const isRedacted = (b: Buffer) => b.subarray(0, 4096).includes("L1-REDACTED:name");

export const scanFile = (site: string, caseId: string) => path.join(config.sampleDir, "scans", `301_${site}_case${caseId}.jpg`);

export async function readPaperForms(ctx: Ctx, lanes: Lane[]) {
  const { trace, models, world } = ctx;
  const paper = lanes.filter((l) => l.dir === "log" && l.log && existsSync(scanFile(l.log.site, l.log.case_id)));
  if (!paper.length) return;
  trace.emit({ agent: "reader", kind: "plan", summary: `${paper.length} amputation log lines have a scanned paper 301 form (${[...new Set(paper.map((l) => l.log!.group))].join(", ")}). Reading them.` });
  for (const lane of paper) {
    const lc = lane.log!;
    const file = scanFile(lc.site, lc.case_id);
    if (!existsSync(file)) { trace.emit({ agent: "reader", kind: "info", lane: lane.id, summary: `No scan for ${lc.site} case ${lc.case_id}; typed transcription only.` }); continue; }
    const bytes = readFileSync(file);
    if (!isRedacted(bytes)) { trace.emit({ agent: "reader", kind: "info", lane: lane.id, summary: `Scan for ${lc.site} case ${lc.case_id} is not marked as redacted (employee name). Not sent to the vision model; typed transcription only.` }); continue; }
    const img = "data:image/jpeg;base64," + bytes.toString("base64");
    let r;
    try {
      r = await models.chat("vision", [{ role: "user", content: [{ type: "text", text: FORM_PROMPT }, { type: "image_url", image_url: { url: img } }] }],
        { tag: `reader.${path.basename(file)}`, maxTokens: 6000, retries: config.nightshift.visionRetries, stub: () => "{}" });
    } catch (e) {
      if (!(e instanceof ModelUnavailable)) throw e;
      trace.emit({ agent: "reader", kind: "fallback", lane: lane.id, summary: `Vision lane unavailable after ${config.nightshift.visionRetries} tries; this lane uses the typed transcription.` });
      continue;
    }
    ctx.noteModel("reader", r, `read the 301 form for ${lc.site} case ${lc.case_id}`, lane.id);
    const f = parseReply<Form301>(ctx, r, () => "{}", "reader", "read 301 form", lane.id);
    if (!f || !Object.keys(f).length) { trace.emit({ agent: "reader", kind: "info", lane: lane.id, summary: "No reading (offline). Typed transcription only." }); continue; }
    // check the paper against the typed transcription
    const diffs: string[] = [];
    if (f.case_no && String(f.case_no).trim() !== lc.case_id) diffs.push(`case ${f.case_no} on paper, ${lc.case_id} typed`);
    if (f.injury_date && f.injury_date !== lc.date) diffs.push(`date ${f.injury_date} on paper, ${lc.date} typed`);
    const body = compareBody(`${f.side ?? ""} ${f.body_part ?? ""} ${f.injury ?? ""}`, lc.text);
    for (const d of body.diffs) diffs.push(`paper vs typed: ${d}`);
    // the form's body-part box often already says the side ("right ring finger"): add the side only when it does not
    const read = (f.body_part && /\b(left|right)\b/i.test(f.body_part) ? [f.body_part] : [f.side, f.body_part]).filter(Boolean).join(" ");
    lane.research.form301 = { ...f, read_by: r.served, source: r.source, agrees_with_typed_log: diffs.length === 0, differences: diffs };
    if (read && (!lc.body || lc.body === lc.text)) lc.body = read; // a paper log has no body-part column (or the map points at the text): the form is the source
    await world.wm.upsertEntity({ type: "log-case", externalKey: { system: "log", id: lc.key }, attrs: { body: lc.body, form301: f, form301_read_by: r.served },
      source: { kind: "model", by: r.served, at: `${lc.date}T00:00:00.000Z` } });
    trace.emit({ agent: "reader", kind: diffs.length ? "reject" : "verdict", lane: lane.id,
      summary: `Form 301 says ${read || "?"}, ${f.injury_date ?? "?"} ${f.time_of_event ?? ""}, ${f.job_title ?? ""}. ${diffs.length ? "Differs from the typed log: " + diffs.join("; ") + "." : "Agrees with the typed log."}`,
      detail: { form301: f } });
  }
}
