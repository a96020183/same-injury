// The README's judge path, button by button, against the real server (npm start), over HTTP the way ui/app.js calls it.
// After every step the server must still answer (QA round 10: "Replay both layers" stopped the whole process), and
// nothing it returns may name a real plant next to a non-neutral label or a synthetic record (app/gate.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { readFileSync } from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
const { breaks, isReal, sitesIn, approvedEvent } = await import("../app/gate.ts");
const PORT = 18740 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: ChildProcess, log = "";
async function call(p: string, o?: RequestInit) {
  const r = await fetch(base + p, o);
  const text = await r.text();
  assert.ok(r.status < 500, `${p}: HTTP ${r.status} ${text.slice(0, 200)}`);
  return { status: r.status, text, json: () => JSON.parse(text) };
}
async function alive() {
  const r = await fetch(base + "/api/state").catch(() => undefined);
  assert.ok(r && r.ok, `the server stopped answering. Its log:\n${log.slice(-1500)}`);
}
/** every object in an answer that names a real plant: no non-neutral label, no synthetic record next to it */
function clean(where: string, v: unknown) {
  const walk = (x: unknown, at: string) => {
    if (Array.isArray(x)) { x.forEach((y, i) => walk(y, `${at}[${i}]`)); return; }
    if (x && typeof x === "object") {
      const t = JSON.stringify(x);
      if (sitesIn(t).some(isReal) && Object.values(x).every((y) => typeof y !== "object" || y === null)) assert.equal(breaks(t), null, `${where} ${at}: ${t.slice(0, 200)}`);
      for (const [k, y] of Object.entries(x)) walk(y, `${at}.${k}`);
    }
  };
  walk(v, "$");
}
async function until(p: string, done: (j: Record<string, unknown>) => boolean, ms = 240000) {
  const t0 = Date.now();
  for (;;) {
    const j = (await call(p)).json();
    if (done(j)) return j;
    assert.ok(Date.now() - t0 < ms, `${p} did not finish: ${JSON.stringify(j).slice(0, 300)}`);
    await sleep(400);
  }
}

test("judge path, every button, on the real server: it keeps answering and every answer passes the output gate", { timeout: 900000 }, async () => {
  server = spawn(process.execPath, ["--no-warnings", "--import", "tsx", "app/server.ts"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), SAMPLE_MODE: "true", L1_MODEL_OFFLINE: "true", L1_PACE_MS: "0" } });
  server.stdout!.on("data", (b) => (log += b)); server.stderr!.on("data", (b) => (log += b));
  try {
    for (let i = 0; i < 100 && !log.includes(String(PORT)); i++) await sleep(200);
    // the first screen
    assert.match((await call("/")).text, /Find the systems/);
    await call("/ui/app.js");
    const intro = (await call("/api/intro")).json();
    assert.doesNotMatch(intro.note, /\{\{/, "the intro note's check sentence is filled in");
    clean("intro", intro);
    // 1. Score · unseen company → Replay both layers
    await call("/api/unseen2", { method: "POST" });
    const u2 = await until("/api/unseen2", (j) => j.phase !== "running");
    await alive();
    assert.equal(u2.phase, "done", JSON.stringify(u2).slice(0, 300));
    clean("unseen2", u2);
    const r2 = u2.result as { items: unknown[]; verifierLanes: { path: { receipts: string[] }[] }[]; receipts: Record<string, unknown> };
    assert.ok(r2.items.length > 5 && r2.verifierLanes.length >= 1);
    for (const q of Object.keys(r2.receipts).slice(0, 3)) clean("unseen2 receipt", (await call(`/api/receipt?qid=${q}&replay=unseen2`)).json());
    //    Run Discovery on it (Layer 1)
    await call("/api/unseen", { method: "POST" });
    const u1 = await until("/api/unseen", (j) => j.phase !== "running");
    await alive();
    assert.equal(u1.phase, "done");
    clean("unseen", u1);
    // 2. Find the systems → Approve and compile → Same (each identity) → Trace → Counsel export
    await call("/api/run?pace=0", { method: "POST" });
    await until("/api/state", (j) => j.phase === "awaiting_usl" || j.phase === "error");
    await call("/api/usl/approve", { method: "POST", body: JSON.stringify({ by: "EHS records lead (Zetaris admin)" }) });
    let st = await until("/api/state", (j) => j.phase === "review" || j.phase === "error");
    assert.equal(st.phase, "review");
    clean("state at review", st);
    for (const p of (st.queue as { id: string; status: string }[]).filter((x) => x.status === "pending")) {
      const rv = await call(`/api/reviewer?id=${p.id}`);
      if (rv.status === 200) clean("reviewer", rv.json());
      clean("merge", (await call("/api/merge", { method: "POST", body: JSON.stringify({ id: p.id, approve: true, by: "EHS records lead" }) })).json());
      await alive();
    }
    st = (await call("/api/state")).json();
    clean("state after review", st);
    const ev = (await call("/api/trace?since=0")).json() as { summary: string; site?: string }[];
    assert.ok(ev.length > 100);
    for (const e of ev) if (isReal(e.site) || sitesIn(e.summary).some(isReal)) assert.ok(approvedEvent(e.summary), e.summary);
    clean("trace", ev);
    for (const q of ["Q-0001", "Q-0050"]) { const r = await call(`/api/receipt?qid=${q}`); if (r.status === 200) clean("receipt", r.json()); }
    const html = (await call("/api/export")).text;
    for (const unit of html.split(/<tr>|<div class="item"|<li>/)) assert.equal(breaks(unit), null, unit.slice(0, 200));
    const featured = JSON.parse(readFileSync(path.join(ROOT, "sample/seed1003/intro.json"), "utf8")).records[0].scan;
    assert.equal((await fetch(`${base}/scans/${featured}`)).status, 200, "the featured 301 form is served");
    assert.equal((await fetch(`${base}/scans/../MANIFEST.json`)).status, 404);
    // Run again
    await call("/api/run?pace=0", { method: "POST" });
    await alive();
  } finally {
    server.kill();
  }
});

test("a reviewer says 'Not the same' at a real plant: the hidden result is counted, once, and labelled as hidden by the real-plant gate", { timeout: 900000 }, async () => {
  const port = PORT + 1;
  const b = `http://127.0.0.1:${port}`;
  let out = "";
  const s = spawn(process.execPath, ["--no-warnings", "--import", "tsx", "app/server.ts"], { cwd: ROOT, env: { ...process.env, PORT: String(port), SAMPLE_MODE: "true", L1_MODEL_OFFLINE: "true", L1_PACE_MS: "0" } });
  s.stdout!.on("data", (x) => (out += x)); s.stderr!.on("data", (x) => (out += x));
  const get = async (p: string, o?: RequestInit) => { const r = await fetch(b + p, o); assert.ok(r.status < 500, `${p}: ${r.status}`); return r; };
  try {
    for (let i = 0; i < 100 && !out.includes(String(port)); i++) await sleep(200);
    await get("/api/run?pace=0", { method: "POST" });
    for (let i = 0; i < 600; i++) { const st = await (await get("/api/state")).json(); if (st.phase === "awaiting_usl") break; await sleep(300); }
    await get("/api/usl/approve", { method: "POST", body: JSON.stringify({ by: "test" }) });
    let st: Record<string, any> = {};
    for (let i = 0; i < 600; i++) { st = await (await get("/api/state")).json(); if (st.phase === "review") break; await sleep(300); }
    const pend = (st.queue as { id: string; status: string; rightId: string }[]).filter((q) => q.status === "pending");
    const real = pend.find((q) => isReal(q.rightId.split(":").pop()));
    assert.ok(real, "a real plant's identity is waiting");
    for (const q of pend) await get("/api/merge", { method: "POST", body: JSON.stringify({ id: q.id, approve: q.id !== real!.id, by: "test" }) });
    st = await (await get("/api/state")).json();
    const hiddenRow = (st.certify as { hidden?: number; plant: string }[]).find((r) => r.hidden);
    assert.ok(st.withheld.count >= 1, "the rejected identity's result is hidden");
    assert.ok(hiddenRow && /hidden by the real-plant gate/.test(hiddenRow.plant), JSON.stringify(st.certify).slice(-300));
    assert.ok(hiddenRow!.plant.includes(`${st.withheld.count} result(s) hidden by the real-plant gate`), `the certify row and the note give the same number: ${JSON.stringify(st.withheld)}`);
    assert.match(st.withheld.note, /hidden by the real-plant gate/);
    const counsel = (st.nextSteps as { key: string; count: number; what: string }[]).find((x) => x.key === "counsel")!;
    assert.match(counsel.what, /of them hidden by the real-plant gate/, "the step says how many of its count are hidden");
    for (const i of st.items as { site?: string; column: string }[]) if (isReal(i.site)) assert.ok(["reported", "reported_differs", "in_log", "in_log_differs", "outside", "pending"].includes(i.column), i.column);
    const html = await (await get("/api/export")).text();
    assert.match(html, /hidden by the real-plant gate/);
  } finally { s.kill(); }
});
