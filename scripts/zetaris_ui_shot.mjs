// Screenshots of the Zetaris UI for the governance shot (no secrets printed or saved; screenshots only).
// Drives a headless Chrome over the DevTools protocol: log in, run a SQL statement in the editor, capture.
// Usage: node scripts/zetaris_ui_shot.mjs <who: agent|admin> <out.png> [sql]
//   agent: agent@l1.local, password from data/private/zetaris_agent_password_PRIVATE.txt
//   admin: ZETARIS_USERNAME / ZETARIS_PASSWORD from ../.env
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const [who = "agent", out = "zetaris_ui.png", sql = "SELECT ID, Employer, Address1, City, Zip FROM osha_public.severe_injury_reports WHERE ID = 'SIR-SYN002'"] = process.argv.slice(2);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(readFileSync(path.join(root, "..", ".env"), "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const creds = who === "admin" ? [env.ZETARIS_USERNAME, env.ZETARIS_PASSWORD] : ["agent@l1.local", readFileSync(path.join(root, "data/private/zetaris_agent_password_PRIVATE.txt"), "utf8").trim()];
const chromes = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"];
const chrome = chromes.find(existsSync);
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(chrome, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, "--window-size=1500,950", `--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), "zshot-"))}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((ok) => { const i = ++id; pending.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
try {
  let targets;
  for (let i = 0; i < 40 && !targets; i++) { await sleep(250); try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch {} }
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: "http://localhost:3000/login" }); await sleep(3000);
  const setVal = (sel, v) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; s.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;
  const u = await evalJs(setVal('input[type="email"], input[name="username"], input[name="email"], input[type="text"]', creds[0]));
  const p = await evalJs(setVal('input[type="password"]', creds[1]));
  await evalJs(`(() => { const b = [...document.querySelectorAll("button")].find((b) => /sign in|log in|login/i.test(b.textContent)) || document.querySelector('button[type="submit"]'); b && b.click(); return !!b; })()`);
  await sleep(5000);
  const page = await evalJs("location.pathname + ' | ' + document.body.innerText.slice(0, 600).replace(/\\n+/g, ' / ')");
  console.log("login fields", u, p, "->", page?.slice(0, 300));
  if (process.argv.includes("--editor")) {
    // open the SQL editor and run the statement
    await evalJs(`(() => { const a = document.querySelector('[data-testid="home-card-sql-workspace"]'); a && a.click(); return !!a; })()`);
    await sleep(3000);
    await evalJs(`(() => { const a = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "New Query"); a && a.click(); return !!a; })()`);
    await sleep(4000);
    const click = async (x, y) => { for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }); };
    await click(900, 220); await sleep(400);
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    await send("Input.insertText", { text: sql }); await sleep(600);
    await click(1122, 121); // the run (triangle) button in the editor toolbar
    await sleep(7000);
    const typed = "clicked";
    console.log("editor", typed, (await evalJs("document.body.innerText.slice(0, 800).replace(/\\n+/g, ' / ')"))?.slice(0, 500));
  }
  // other local projects on the same Zetaris (other teams' work) are not part of this screenshot: hide their rows
  console.log("hidden", await evalJs(`(() => { let n = 0, first; for (const el of document.querySelectorAll("span,div,p")) { const t = el.textContent.trim();
    if (el.children.length === 0 && /^(aprime_|exam\d|revisit_|unseen\d)/.test(t)) { let row = el; for (let i = 0; i < 4 && row.parentElement && row.parentElement.textContent.trim() === t; i++) row = row.parentElement;
      if (row.style.display !== "none") { first = first || row; row.style.display = "none"; n++; } } }
    if (first && n) { const d = document.createElement("div"); d.textContent = "(" + n + " other local projects hidden)"; d.style.cssText = "font-size:11px;opacity:.6;padding:6px 0 6px 34px"; first.parentElement.insertBefore(d, first); }
    return n; })()`));
  await sleep(300);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(shot.result.data, "base64"));
  console.log("saved", out);
} finally { proc.kill(); }
