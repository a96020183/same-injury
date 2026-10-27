// Local web app for the EHS records lead: `npm start` → http://127.0.0.1:8740
import { syntheticSentence } from "./synthetic_note.ts";
import { gateChanged, gateReceipt, gateReplay, gateReviewer, gateScan } from "./gate.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { config, ROOT, scrub } from "./config.ts";
import { Run } from "./run.ts";
import { Trace } from "./trace.ts";
import { readdirSync } from "node:fs";

// a composite company generated after the code was written (sample/unseen<seed>, made by scripts/make_unseen_company.py)
let unseen: { phase: "running" | "done" | "error"; trace: Trace; result?: unknown; error?: string; folder: string } | undefined;
let unseen2: { phase: "running" | "done" | "error"; result?: unknown; error?: string } | undefined;
const unseenFolder = () => readdirSync(path.join(ROOT, "sample")).find((f) => /^unseen\d+$/.test(f));

let run: Run | undefined;
const UI = path.join(ROOT, "ui");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };

const send = (res: ServerResponse, code: number, body: unknown, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? scrub(JSON.stringify(body)) : (body as string));
};
const body = (req: IncomingMessage) => new Promise<Record<string, unknown>>((ok) => {
  let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch { ok({}); } });
});

const intro = () => {
  const f = path.join(config.sampleDir, "intro.json");
  if (!existsSync(f)) return null;
  const d = JSON.parse(readFileSync(f, "utf8"));
  // the sentence about the synthetic records is the result of the check, not typed text (app/synthetic_note.ts)
  if (typeof d.note === "string") d.note = d.note.replace("{{synthetic_check}}", syntheticSentence());
  return d;
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/ui/"))) {
      const f = url.pathname === "/" ? path.join(UI, "index.html") : path.join(UI, path.normalize(url.pathname.slice(4)).replace(/^(\.\.[/\\])+/, ""));
      if (!f.startsWith(UI) || !existsSync(f)) return send(res, 404, { error: "not found" });
      return send(res, 200, readFileSync(f, "utf8"), TYPES[path.extname(f)] ?? "text/plain");
    }
    if (url.pathname === "/api/intro") return send(res, 200, intro());
    if (url.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
    if (url.pathname === "/api/state") return send(res, 200, run ? run.state() : { phase: "idle", sqlMode: config.sampleMode ? "sample" : "live" });
    if (url.pathname === "/api/trace") {
      const since = Number(url.searchParams.get("since") ?? 0);
      return send(res, 200, run ? run.trace.events.filter((e) => e.seq > since) : []);
    }
    if (url.pathname === "/api/receipt") {
      // ?replay=unseen2: a receipt from the unseen company's replay (child process), else from the current run
      if (url.searchParams.get("replay") === "unseen2") {
        const r2 = (unseen2?.result as { receipts?: Record<string, unknown> } | undefined)?.receipts?.[String(url.searchParams.get("qid"))];
        return r2 ? send(res, 200, gateReceipt(r2 as { result?: { data?: unknown[][] } })) : send(res, 404, { error: "no such query in the replay" });
      }
      const r = run?.ctx.sql.receipts.find((x) => x.qid === url.searchParams.get("qid"));
      return r ? send(res, 200, gateReceipt(r as never)) : send(res, 404, { error: "no such query" });
    }
    if (url.pathname === "/api/export") {
      if (!run?.items.length) return send(res, 409, { error: "nothing to export yet" });
      const { renderExport } = await import("./export.ts");
      return send(res, 200, renderExport(run), "text/html; charset=utf-8");
    }
    if (url.pathname.startsWith("/scans/")) {
      const f = path.join(config.sampleDir, "scans", path.basename(url.pathname));
      if (!gateScan(path.basename(f)) || !existsSync(f)) return send(res, 404, { error: "no scan" });
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=3600" });
      return res.end(readFileSync(f));
    }
    if (url.pathname === "/api/unseen") {
      if (req.method === "POST" && unseen?.phase !== "running") {
        const folder = unseenFolder();
        if (!folder) return send(res, 404, { error: "no unseen company in sample/" });
        const trace = new Trace("unseen-" + Date.now());
        unseen = { phase: "running", trace, folder };
        const u = unseen;
        const { runCompany } = await import("./exam.ts");
        void runCompany(path.join(ROOT, "sample", folder, "tables"), { trace }).then((r) => {
          // table roles and field maps only: no plant, no result (app/gate.ts EXITS)
          u.result = { tag: r.tag, rows: r.rows, counts: r.counts, models: r.models, zetaris: r.zetaris, queries: r.queries, stub: r.stub, calls: r.calls.length };
          u.phase = "done";
        }).catch((e) => { u.phase = "error"; u.error = scrub(String((e as Error).message ?? e)); });
      }
      if (!unseen) return send(res, 200, { phase: "idle", folder: unseenFolder() });
      return send(res, 200, { phase: unseen.phase, folder: unseen.folder, error: unseen.error, result: unseen.result, events: unseen.trace.events.slice(-6).map((e) => ({ agent: e.agent, summary: e.summary })) });
    }
    if (url.pathname === "/api/unseen2") {
      // the unseen company's second layer, replayed from its live recording in a child process (its own sample folder)
      if (req.method === "POST" && unseen2?.phase !== "running") {
        const folder = unseenFolder();
        if (!folder) return send(res, 404, { error: "no unseen company in sample/" });
        unseen2 = { phase: "running" };
        const u = unseen2;
        const { spawn } = await import("node:child_process");
        const env = { ...process.env, L1_SAMPLE_DIR: path.join(ROOT, "sample", folder, "full"), SAMPLE_MODE: "true", L1_MODEL_OFFLINE: "true", L1_USL_NAME: `${folder}_records`, L1_RUNS_DIR: path.join(ROOT, "runs", "unseen2") };
        const ch = spawn(process.execPath, ["--no-warnings", "--import", "tsx", path.join(ROOT, "scripts", "variant_run.ts")], { env, cwd: ROOT });
        let out = "";
        ch.stdout.on("data", (b) => (out += b));
        ch.on("close", () => {
          const line = out.split("\n").find((l) => l.startsWith("@@RESULT"));
          // an error here must not stop the server (QA round 10): the replay ends as an error, the server keeps serving
          try {
            if (line) { u.phase = "done"; u.result = gateReplay(JSON.parse(line.slice(8))); } // the output gate (app/gate.ts)
            else { u.phase = "error"; u.error = "replay failed"; }
          } catch (e) { u.phase = "error"; u.error = "replay could not be shown"; console.error("unseen2:", scrub(String((e as Error).stack ?? e))); }
        });
      }
      return send(res, 200, unseen2 ?? { phase: "idle" });
    }
    if (url.pathname === "/api/reviewer") {
      if (!run) return send(res, 409, { error: "no run" });
      // an id from an earlier run (an old tab) or one with no OSHA report behind it: 404, not a server error
      try {
        const v = await run.reviewerView(String(url.searchParams.get("id"))) as { site?: string; reportId?: string };
        const shown = gateReviewer(v, run.items.find((i) => i.reportId === v.reportId && i.site === v.site));
        return shown ? send(res, 200, shown) : send(res, 404, { error: "not shown at this plant" });
      }
      catch (e) { return send(res, 404, { error: scrub(String((e as Error).message ?? e)) }); }
    }
    if (req.method === "POST" && url.pathname === "/api/run") {
      // demo pacing for replayed answers: ?pace=ms per step (0 = instant)
      if (url.searchParams.has("pace")) config.paceMs = Math.max(0, Math.min(2000, Number(url.searchParams.get("pace")) || 0));
      run = new Run({ sqlMode: url.searchParams.get("live") === "1" ? "live" : undefined });
      void run.start();
      return send(res, 200, { id: run.id });
    }
    if (req.method === "POST" && url.pathname === "/api/usl/approve") {
      if (!run) return send(res, 409, { error: "no run" });
      const b = await body(req);
      void run.approveUsl(String(b.by ?? "EHS records lead (admin)"));
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/merge") {
      if (!run) return send(res, 409, { error: "no run" });
      const b = await body(req);
      const changed = await run.decideMerge(String(b.id), b.approve !== false, String(b.by ?? "EHS records lead"));
      return send(res, 200, { changed: gateChanged(changed.map((c) => ({ lane: c.lane, column: c.column, site: c.site }))).map(({ lane, column }) => ({ lane, column })) });
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: scrub(String((e as Error).message ?? e)) });
  }
});

// nothing a request or a background step throws may stop the server (QA round 10): log it and keep serving
process.on("uncaughtException", (e) => console.error("uncaught:", scrub(String((e as Error).stack ?? e))));
process.on("unhandledRejection", (e) => console.error("unhandled:", scrub(String((e as Error)?.stack ?? e))));

// port busy (another copy running, or another app): try the next ten ports instead of crashing
let port = config.port;
server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE" && port < config.port + 10) { console.log(`Port ${port} is busy, trying ${port + 1}…`); port += 1; server.listen(port, "127.0.0.1"); return; }
  console.error(e.code === "EADDRINUSE" ? `Ports ${config.port}-${port} are all busy. Set PORT=<free port> and start again.` : String(e));
  process.exit(1);
});
server.on("listening", () => {
  console.log(`Same Injury · http://127.0.0.1:${port} · ${config.sampleMode ? "SAMPLE_MODE" : "live Zetaris"} · models: ${config.nightshift.offline || !config.nightshift.token ? "replay / offline stub" : "Nightshift"}`);
});
server.listen(port, "127.0.0.1");
