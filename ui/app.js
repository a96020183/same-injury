// Same Injury UI. Plain JS, no build step. Polls the local server while agents run.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const api = (p, o) => fetch(p, o).then((r) => r.json());

let state = { phase: "idle" };
let events = [];
let agentFilter = null;
let laneFilter = null; // "Show this lane in the trace": kept until cleared, so polling does not undo it
let lastSig = "";
let flash = new Set();
let discOpen = false;
let introData = null;
let lastPhase = "idle";
const reviewer = new Map(); // proposal id -> reviewer view
const COL = {
  reported: "Reported — OSHA has it", reported_differs: "Reported — written differently", not_required: "May not need a report", not_found: "No matching report found in this sample (composite company)",
  outside: "State Plan state — its own records, outside OSHA's federal file", pending: "Waiting for your review", review: "Needs a person", in_log: "In the log",
  in_log_differs: "In the log, written differently", not_in_log: "Not found in this company's log sample",
};
const ORDER_LOG = ["pending", "reported_differs", "reported", "not_found", "not_required", "outside", "review"];
const ORDER_OSHA = ["pending", "not_in_log", "in_log_differs", "in_log", "review"];
const ROLE = { incident_log: "injury log", site_list: "site list", yearly_summary: "yearly summary", osha_reports: "OSHA reports", dol_inspections: "DOL inspections",
  dol_links: "DOL links", letters: "letters", reference: "reference", other: "not injury records", reading: "reading…" };
const PIPE = [["discovery", "Discovery"], ["evaluator", "Evaluator"], ["verifier", "Verifier"], ["planner", "Planner"], ["reader", "Reader (VL)"], ["linker", "Linker"],
  ["research", "Research"], ["skeptic", "Skeptic"], ["world", "World Model"], ["risk", "Wording guard"], ["final", "Final"], ["human", "You"]];

const HYP = { written_differently: () => "Same injury, written differently", different_injury: () => "A different injury",
  wrong_site: (d) => (d === "log" ? "A nearby OSHA report is about another site" : "The report is about another site"),
  state_plan: (d) => (d === "log" ? "Reported to the State Plan, not in OSHA's federal file" : "The plant reports to a State Plan"),
  excluded: (d) => (d === "log" ? "A 1904.39(b) reporting exclusion applies (counsel to confirm)" : "Not recordable in this log (counsel to confirm)"),
  not_found: (d) => (d === "log" ? "No report in OSHA's federal file" : "The plant log has no line for it") };

// ---------------------------------------------------------------- intro
async function intro() {
  const d = await api("/api/intro");
  if (!d) return;
  introData = d;
  $("#headline").textContent = d.headline;
  if (d.impact) $("#impact").innerHTML = `<b>${esc(d.impact.value)}</b> ${esc(d.impact.text)} <span class="isrc">${esc(d.impact.source)}</span>`;
  $("#records").innerHTML = d.records.map((r) => {
    if (r.unknown) return `<div class="rec unknown"><div class="who">${esc(r.who)}</div><div class="plain">${esc(r.plain)}</div><div class="q">?</div><div class="txt">${esc(r.text)}</div></div>`;
    const txt = esc(r.text).replace(esc(r.mark), `<mark>${esc(r.mark)}</mark>`);
    return `<div class="rec"><div class="who">${esc(r.who)}</div><div class="plain">${esc(r.plain)}</div>
      <div class="id">${esc(r.id)}</div>${(r.subIds || []).map((s) => `<div class="sub">${esc(s)}</div>`).join("")}
      <div class="date">${esc(r.date)}</div><div class="txt">${txt}</div>${r.scan ? `<img class="thumb" src="/scans/${esc(r.scan)}" alt="scanned OSHA 301 form">` : ""}</div>`;
  }).join("");
  $("#idnote").textContent = d.note;
  if (d.compositeNote) $("#headline").insertAdjacentHTML("afterend", `<div class="syn">${esc(d.compositeNote)}</div>`);
  $("#systems").innerHTML = d.systems.map((s) => `<div class="sys"><div class="g">${s.group === "S" ? "synthetic test system" : "plant group " + esc(s.group)}</div><div class="k">${esc(s.kind)}</div><div class="w">${esc(s.what)}</div></div>`).join("");
  $("#composite").textContent = d.composite;
  if (d.governance) $("#gov").innerHTML = `<p>${esc(d.governance.one)}</p>`;
  $("#extNote").textContent = d.externalNote || "";
  $("#external").innerHTML = d.external.map((x) => `<div><div class="v">${esc(x.value)}</div><div class="k">${esc(x.label)}</div><div class="s">${esc(x.sub)}</div></div>`).join("");
}

// ---------------------------------------------------------------- views
function show(id) { for (const v of ["intro", "discovery", "results"]) $("#" + v).classList.toggle("hidden", !(Array.isArray(id) ? id.includes(v) : id === v)); }
let keyOnly = true;
// the moments a reviewer should see first: rejections, re-plans, approvals, escalations, the Skeptic, a person's decisions
const isKey = (e) => ["reject", "replan", "approve", "escalate", "merge", "fallback", "error"].includes(e.kind) || e.agent === "skeptic" || (e.agent === "evaluator" && e.kind === "verdict" && !/explanations weighed/.test(e.summary)) || (e.agent === "linker" && e.kind === "verdict" && / → (link|evaluate)/.test(e.summary));
function traceStats() {
  const n = (f) => events.filter(f).length;
  const sk = state.skeptic;
  return [["model calls", n((e) => e.kind === "model")], ["evaluator rejections", n((e) => e.kind === "reject" && e.agent === "evaluator")], ["verifier rejections", n((e) => e.kind === "reject" && e.agent === "verifier")], ["plan revisions", n((e) => e.kind === "replan")],
    ["escalations", n((e) => e.kind === "escalate")], ["fallbacks", n((e) => e.kind === "fallback")], ["skeptic mismatches", sk ? sk.mismatched.length : "—"]];
}

function renderHeader() {
  $("#mode").textContent = state.sqlMode === "live" ? "Data: live Zetaris" : "Data: sample · recorded Zetaris answers";
  const calls = state.models?.calls ?? [];
  const short = (s) => (s === "offline-stub" ? "offline stub" : s.replace(/^nvidia\/(nemotron-)?/, "").replace(/-a\d+b$/, ""));
  const byLane = ["fast", "deep", "vision"].map((l) => [l, calls.filter((c) => c.lane === l)]).filter(([, c]) => c.length)
    .map(([l, c]) => `${l} → ${[...new Set(c.map((x) => short(x.served)))].join("/")} ×${c.reduce((s, x) => s + x.n, 0)}`);
  $("#models").textContent = byLane.length ? "Nemotron: " + byLane.join(" · ") : "Models: Nemotron via Nightshift";
  $("#traceCount").textContent = events.length ? `· ${events.length}` : "";
}

function renderStatus() {
  const bar = $("#statusbar");
  const p = state.phase;
  const live = ["discovering", "compiling", "matching"].includes(p);
  bar.classList.toggle("hidden", p === "idle");
  const last = events.at(-1);
  const active = live ? last?.agent : p === "awaiting_usl" || (p === "review" && (state.queue || []).some((q) => q.status === "pending")) ? "human" : null;
  $("#pipe").innerHTML = PIPE.map(([k, label]) => `<span class="st ${k === active ? "on" : ""} ${events.some((e) => e.agent === k) ? "seen" : ""}">${esc(label)}</span>`).join("");
  const b = state.busy;
  const secs = b ? Math.round(b.ms / 1000) : 0;
  const wait = !b ? "" : b.kind === "model" ? `Waiting for Nemotron (${b.lane} lane${b.replay ? ", recorded" : ""}): ${b.what.replace(/^[a-z]+\./, "").replace(/\./g, " ")}${secs ? ` · ${secs} s` : ""}`
    : secs >= 1 ? `Zetaris query (${b.agent}): ${b.what} · ${secs} s` : "";
  $("#barApprove").classList.toggle("hidden", p !== "awaiting_usl");
  $("#now").textContent = live && wait ? wait : live ? `${last?.agent ?? ""}${last?.lane ? " · " + last.lane : ""} — ${last?.summary ?? "starting…"}`
    : p === "awaiting_usl" ? `Waiting for you: ${(state.discovery?.tables || []).filter((t) => t.role === "incident_log").length} injury logs found. Approve the unified model.` : p === "review" ? ((state.queue || []).some((q) => q.status === "pending") ? "Waiting for you: decide the identities." : "Done. Export for counsel.") : p === "error" ? "Stopped: " + (state.error || "") : "";
}

/** while Discovery runs, rebuild what it has found so far from the trace */
function partialDiscovery() {
  const tri = [...events].reverse().find((e) => e.agent === "discovery" && e.kind === "branch" && Array.isArray(e.detail));
  const sources = (tri?.detail || []).map((s) => ({ name: s.source, kept: s.kept, why: s.why }));
  const tables = new Map();
  for (const e of events) {
    const m = e.agent === "discovery" && e.kind === "sql" && e.summary.match(/^([\w.]+): (\d+) columns\.$/);
    if (m) tables.set(m[1], { fq: m[1], role: "reading", why: `${m[2]} columns, three sample rows read; waiting for the model` });
    if (e.agent === "discovery" && e.kind === "verdict" && Array.isArray(e.detail)) for (const t of e.detail) tables.set(t.table, { fq: t.table, role: t.role, why: t.why, map: t.map });
  }
  return sources.length ? { sources, tables: [...tables.values()] } : null;
}

function renderDiscovery() {
  const d = state.discovery || (state.phase === "discovering" ? partialDiscovery() : null);
  const p = state.phase;
  const running = p === "discovering" || p === "compiling";
  const last = [...events].reverse().find((e) => ["discovery", "evaluator", "verifier", "planner"].includes(e.agent));
  $("#discStatus").innerHTML = running ? `<span class="dot"></span>${esc(last?.summary ?? "Reading the catalog…")}` : p === "awaiting_usl" ? "Waiting for your approval" : d ? "Done" : "";
  if (!d) { $("#sources").innerHTML = ""; $("#tables").innerHTML = ""; $("#uslBox").classList.add("hidden"); return; }
  $("#sources").innerHTML = [...d.sources].sort((a, b) => Number(b.kept) - Number(a.kept) || a.name.localeCompare(b.name)).map((s) => `<span class="src ${s.kept ? "" : "skip"}" title="${esc(s.why)}">${esc(s.name)}</span>`).join("");
  const fixes = new Map(events.filter((e) => e.agent === "planner" && e.kind === "replan" && e.summary.startsWith("Revised")).map((e) => [e.summary.match(/^Revised ([\w.]+):/)?.[1], e.summary]));
  const rejects = new Map(events.filter((e) => e.agent === "verifier" && e.kind === "reject" && !e.lane).map((e) => [e.summary.match(/in ([\w.]+) don't/)?.[1] ?? e.summary.match(/on ([\w.]+):/)?.[1], e.summary]));
  const order = { reading: -1, incident_log: 0, site_list: 1, yearly_summary: 2, osha_reports: 3, dol_inspections: 4, dol_links: 5, letters: 6, reference: 7, other: 8 };
  $("#tables").innerHTML = [...d.tables].sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.fq.localeCompare(b.fq)).map((t) => {
    const m = t.map || {};
    const fix = fixes.get(t.fq);
    const fmt = fix ? `<s>${esc(fix.match(/format (\S+) →/)?.[1])}</s> ${esc(m.date_format)}` : esc(m.date_format || "");
    const inText = m.date_regex || (m.narrative && m.date === m.narrative);
    const map = t.role === "incident_log" ? `<dl class="map"><dt>site</dt><dd>${esc(m.site)}</dd><dt>date</dt><dd>${inText ? "inside " + esc(m.date) : esc(m.date)}</dd>
      <dt>format</dt><dd>${fmt}</dd><dt>body part</dt><dd>${m.body_part && m.body_part !== m.narrative ? esc(m.body_part) : inText ? "inside the text (paper form)" : "—"}</dd>
      <dt>narrative</dt><dd>${esc(m.narrative)}${m.injury && m.injury !== m.narrative ? " + " + esc(m.injury) : ""}</dd></dl>` : "";
    const rej = rejects.get(t.fq);
    return `<div class="tbl ${esc(t.role)}"><div class="name">${esc(t.fq)}</div><span class="role">${esc(ROLE[t.role] ?? t.role)}</span>${map}
      ${rej ? `<div class="fix">Verifier: ${esc(rej)}</div>` : ""}${t.role !== "incident_log" ? `<div class="why">${esc(t.why)}</div>` : ""}</div>`;
  }).join("");
  if (d.usl && state.discovery) {
    $("#uslBox").classList.remove("hidden");
    $("#uslCode").textContent = [d.usl.compile, d.usl.activateSite, d.usl.activateIncident].join("\n\n");
    $("#uslBtn").disabled = p !== "awaiting_usl";
    $("#uslBtn").textContent = p === "awaiting_usl" ? "Approve and compile" : p === "compiling" ? "Compiling…" : "Compiled";
  }
}

function itemCard(i) {
  const diff = (i.detail || []).filter((x) => /^Written differently|^Differs/.test(x));
  return `<button class="item ${esc(i.column)} ${flash.has(i.lane) ? "flash" : ""}" data-lane="${esc(i.lane)}">
    ${i.synthetic ? `<span class="syn">${i.syntheticKind === "composite" ? "Composite modeled on a public pattern" : "SYNTHETIC test record"}</span>` : ""}<div class="l1"><span class="site">${esc(i.plantName || i.site || "—")}</span><span class="date">${esc(i.date)}</span></div>
    <div class="h">${esc(i.headline)}</div>${diff.map((x) => `<div class="diff">${esc(x)}</div>`).join("")}</button>`;
}

/** the opening pair, once the agents have linked it */
function renderFeatured() {
  const f = introData?.featured; const el = $("#featured");
  if (!f || !state.lanes) { el.classList.add("hidden"); return; }
  const l = state.lanes.find((x) => x.dir === "log" && x.site === f.site && x.caseId === f.case);
  const it = l && (state.items || []).find((i) => i.lane === l.id);
  if (!l || !it) { el.classList.add("hidden"); return; }
  const dol = l.dol && l.dol.found ? l.dol : l.mapDol ? { inspection: l.mapDol.inspection, opened: l.mapDol.opened, viaMap: true } : null;
  el.classList.remove("hidden");
  el.innerHTML = `<div class="label">The opening pair, as the agents left it</div>
    <div class="trio"><div><span class="t">Plant log</span><b>${esc(f.site)} · case ${esc(f.case)}</b>${l.form301 ? `<span class="s">form read by ${esc(l.form301.read_by.replace(/^nvidia\//, ""))}</span>` : ""}</div>
    <div><span class="t">Phone report</span><b>${esc(it.reportId ?? "not linked")}</b><span class="s">${esc(COL[it.column])}</span></div>
    <div><span class="t">Inspection record</span><b>${dol ? esc(dol.inspection) : "—"}</b><span class="s">${dol ? `${dol.viaMap ? "joined in by the federated candidate-map query" : "found by Research"} · opened ${esc(dol.opened)}${dol.at_our_plant_address ? " · at this plant's address" : ""}` : "not looked up"}</span></div></div>
    <button class="ghost" data-lane="${esc(l.id)}">Open ${esc(l.id)}</button>`;
}

async function loadReviewer(id) {
  if (reviewer.has(id)) return;
  reviewer.set(id, null);
  try {
    const r = await fetch("/api/reviewer?id=" + encodeURIComponent(id));
    const v = r.ok ? await r.json() : null;
    if (v && v.agent) reviewer.set(id, v); else reviewer.delete(id); // a stale id (an earlier run) shows nothing, not an error
  } catch { reviewer.delete(id); }
  renderResults();
}

function renderResults() {
  const items = state.items || [];
  const p = state.phase;
  const pend = (state.queue || []).filter((q) => q.status === "pending");
  $("#resStatus").innerHTML = p === "matching" || p === "compiling" ? `<span class="dot"></span>${esc([...events].reverse().find((e) => e.lane)?.summary ?? "Working…")}`
    : p === "review" ? (pend.length ? `${pend.length} identit${pend.length === 1 ? "y" : "ies"} need you` : "Every identity decided") : "";
  for (const [dir, el, order] of [["log", "#colLog", ORDER_LOG], ["osha", "#colOsha", ORDER_OSHA]]) {
    const own = items.filter((i) => i.dir === dir);
    $(el).innerHTML = order.filter((c) => own.some((i) => i.column === c)).map((c) =>
      `<div class="group"><div class="group-t"><span>${esc(COL[c])}</span><span class="c">${own.filter((i) => i.column === c).length}</span></div>${own.filter((i) => i.column === c).map(itemCard).join("")}</div>`).join("")
      || `<p class="fine">${p === "review" ? "Nothing in this direction." : ""}</p>`;
  }
  const q = $("#queue");
  q.classList.toggle("hidden", !pend.length);
  for (const x of pend) loadReviewer(x.id);
  q.innerHTML = pend.length ? `<h3>Same employer? You decide</h3><p class="fine">Same SQL, two Zetaris identities: the agents' role sees masks, your reviewer role sees names. Nothing merges until you say so.</p>` +
    pend.map((x) => {
      const v = reviewer.get(x.id);
      const a = v?.agent ?? {}, r = v?.reviewer ?? {}, pl = v?.plant ?? {};
      return `<div class="prop"><div class="side"><div class="t">OSHA report ${esc(v?.reportId ?? "")}</div>
          <div class="pair"><span class="who">agents see</span><span class="mono">${esc(a.Employer ?? x.leftName)}</span></div>
          <div class="pair"><span class="who">you see</span><span class="n">${esc(r.Employer ?? "…")}</span></div>
          <div class="a">${esc(r.Address1 ?? addr(x.left))}${r.City ? ", " + esc(r.City) + " " + esc(r.Zip) : ""}</div></div>
        <div class="eq">=</div>
        <div class="side"><div class="t">Our plant ${esc(x.rightId.split(":").pop())}</div>
          <div class="pair"><span class="who">you see</span><span class="n">${esc(pl.legal_name ?? x.rightName)}</span></div>
          <div class="a">${esc(pl.street ?? "")}${pl.city ? ", " + esc(pl.city) + " " + esc(pl.state) + " " + esc(pl.zip) : ""}</div></div>
        <div class="btns"><button class="primary" data-approve="${esc(x.id)}">Same</button><button class="ghost" data-reject="${esc(x.id)}">Not the same</button></div>
        <div class="ev">Evidence: ${esc(x.reason)}${v ? ` · <button class="qid" data-qid="${esc(v.receipts[0])}">${esc(v.receipts[0])}</button><button class="qid" data-qid="${esc(v.receipts[1])}">${esc(v.receipts[1])} admin</button>` : ""}</div></div>`;
    }).join("") : "";
  const sk = state.skeptic;
  $("#skepticLine").textContent = sk ? `Skeptic: ${sk.rerun} citations re-run · ${sk.match} match${sk.backend === "replay" ? " (replayed from the recording)" : ""}` : "";
  const lanes = state.lanes || [];
  const decided = lanes.filter((l) => l.state !== "open").length;
  $("#ticker").classList.toggle("hidden", !(p === "matching" && lanes.length));
  if (p === "matching" && lanes.length) {
    const STATE = { open: "working", linked: "linked", not_covered: "State Plan", not_ours: "not ours", no_match: "no match", needs_review: "needs a person", excluded: "excluded", withheld: "counted only" };
    $("#ticker").innerHTML = `<div class="t-head">${decided} of ${lanes.length} lanes decided</div>` +
      lanes.map((l) => `<span class="lane-chip ${esc(l.state)}" title="${esc(l.title)}">${esc(l.id)} <i>${esc(STATE[l.state] ?? l.state)}</i></span>`).join("");
  }
  $("#actions").classList.toggle("hidden", !(p === "review" && items.length && !pend.length));
  const cs = state.certify || [];
  $("#certify").classList.toggle("hidden", !(p === "review" && items.length));
  $("#certify").innerHTML = `<h3>Before you certify the 300A</h3>` + (cs.length ? `<table><tr><th>Plant</th><th>Add to the log</th><th>Written differently</th><th>For counsel</th><th>State Plan records</th><th>Waiting for you</th><th>Counts vs 300A</th></tr>` +
    cs.map((r) => r.hidden ? `<tr><td colspan="7" class="fine">${esc(r.plant)}</td></tr>` : `<tr><td>${esc(r.plant)} <span class="fine">${esc(r.site)}</span>${r.synthetic ? ' <span class="syn">SYNTHETIC plant</span>' : ""}</td><td>${r.add || ""}</td><td>${r.review || ""}</td><td>${r.counsel || ""}</td><td>${r.statePlan || ""}</td><td>${r.pending || ""}</td><td>${esc(r.totals || "")}</td></tr>`).join("") + "</table>"
    : `<p class="fine">Nothing to add, review or send to counsel.</p>`) + (state.withheld?.count ? `<p class="fine">${esc(state.withheld.note)}</p>` : "");
  const ns = state.nextSteps || [];
  $("#next").classList.toggle("hidden", !(p === "review" && ns.length));
  $("#next").innerHTML = `<h3>Next steps</h3><ol>` + ns.map((s) => `<li><div class="t">${esc(s.title)}${s.count ? ` <span class="c">${s.count}</span>` : ""}</div>
    <div class="w">${esc(s.what)}</div><div class="fine">Who: ${esc(s.who)} · When: ${esc(s.when)}${s.cite ? ` · ${esc(s.cite)}` : ""}</div></li>`).join("") + `</ol><p class="fine">Deadlines quote 29 CFR 1904. A checklist, not legal advice.</p>`;
  renderFeatured();
}
const addr = (a) => (a ? [a.street, a.city, a.state, a.zip].filter(Boolean).join(", ") : "");

function render() {
  renderHeader();
  const p = state.phase;
  $("#againBtn").classList.toggle("hidden", !["review", "error"].includes(p)); // a second run without restarting the server
  if (p === "idle") show("intro");
  else if (["discovering", "awaiting_usl"].includes(p)) show("discovery");
  else show(["discovery", "results"]);
  if (p !== lastPhase && (lastPhase === "idle" || p === "discovering")) window.scrollTo({ top: 0 });
  if (p !== lastPhase && lastPhase === "compiling") $("#results").scrollIntoView({ behavior: "smooth" });
  lastPhase = p;
  const done = !["idle", "discovering", "awaiting_usl"].includes(p);
  $("#discovery").classList.toggle("compact", done && !discOpen);
  $("#discToggle").classList.toggle("hidden", !done);
  $("#discToggle").textContent = discOpen ? "Hide tables" : "Show tables and field maps";
  renderDiscovery();
  renderResults();
  renderTrace();
  renderStatus();
  if (p === "error") $("#discStatus").textContent = "Stopped: " + (state.error || "error");
}

// ---------------------------------------------------------------- trace
const AGENTS = ["planner", "discovery", "reader", "linker", "evaluator", "verifier", "research", "skeptic", "world", "human", "risk", "final"];
function renderTrace() {
  $("#agentFilter").innerHTML = ["all", ...AGENTS].map((a) => `<button data-agent="${a}" class="${(agentFilter ?? "all") === a ? "on" : ""}">${a}</button>`).join("")
    + (laneFilter ? `<button data-clearlane="1" class="on" title="Show every lane">lane ${esc(laneFilter)} ×</button>` : "");
  $("#traceStats").innerHTML = traceStats().map(([k, v]) => `<span><b>${v}</b> ${k}</span>`).join("");
  $("#keyOnly").classList.toggle("on", keyOnly); $("#allEv").classList.toggle("on", !keyOnly);
  const list = events.filter((e) => (!agentFilter || e.agent === agentFilter) && (!laneFilter || e.lane === laneFilter) && (!keyOnly || isKey(e)));
  $("#events").innerHTML = list.slice(-400).map((e) => `<li><span class="ag ${esc(e.agent)}">${esc(e.agent.slice(0, 2))}</span><div>
    <div class="k">${esc(e.agent)} · ${esc(e.kind)}${e.attempt ? " · try " + e.attempt : ""}${e.lane ? `<span class="lane">${esc(e.lane)}</span>` : ""}</div>
    <div>${esc(e.summary)}</div>
    ${e.model ? `<div class="m">${esc(e.model.lane)} lane · asked ${esc(e.model.requested)} · answered by ${esc(e.model.served)} · ${esc(e.model.source)}</div>` : ""}
    ${(e.receipts || []).length ? `<div>${e.receipts.map((q) => `<button class="qid" data-qid="${esc(q)}">${esc(q)}</button>`).join("")}</div>` : ""}</div></li>`).join("");
  const el = $("#events"); el.scrollTop = el.scrollHeight;
}

async function receipt(qid, replay) {
  const r = await api("/api/receipt?qid=" + encodeURIComponent(qid) + (replay ? "&replay=" + replay : ""));
  $("#modalBody").innerHTML = r.error && !r.qid ? esc(r.error) : `<h3>${esc(r.qid)} · ${esc(r.purpose)}</h3>
    <dl class="kv" style="margin-top:14px"><dt>agent</dt><dd>${esc(r.agent)}</dd><dt>identity</dt><dd>${esc(r.as)}</dd><dt>answered by</dt><dd>${esc(r.backend)}</dd>
    <dt>sources</dt><dd>${esc((r.sources || []).join(", ") || "catalog")}</dd>
    <dt>rows</dt><dd>${r.rows}</dd><dt>result hash</dt><dd><code>${esc(r.resultSha)}</code></dd><dt>time</dt><dd>${esc(r.at)} · ${r.ms} ms</dd>${r.error ? `<dt>note</dt><dd>${esc(r.error)}</dd>` : ""}</dl>
    <pre>${esc(r.sql)}</pre>`;
  $("#modal").classList.remove("hidden");
}

function drawer(laneId) {
  const i = (state.items || []).find((x) => x.lane === laneId);
  const l = (state.lanes || []).find((x) => x.id === laneId);
  if (!i) return;
  const f = l?.form301;
  $("#drawerBody").innerHTML = `<div class="fine">${esc(i.lane)} · ${i.dir === "log" ? "Plant log → OSHA" : "OSHA → plant log"}</div>
    ${i.synthetic ? `<div class="syn">${i.syntheticKind === "composite" ? "Composite modeled on a public pattern — state, date and job changed; not a published record" : "SYNTHETIC test record — marked in the sample data, not a published record"}</div>` : ""}<h4>${esc(i.plantName || i.site)}</h4><div class="fine">${esc(i.site)} · ${esc(i.date)}</div>
    <div class="sec"><h3>${esc(COL[i.column])}</h3><p style="font:400 18px/1.4 var(--serif);margin:8px 0">${esc(i.headline)}</p>${(i.detail || []).map((d) => `<div class="fine" style="color:var(--graphite)">${esc(d)}</div>`).join("")}</div>
    ${i.reportId || i.logKey ? `<div class="sec"><dl class="kv">${i.reportId ? `<dt>OSHA report</dt><dd><code>${esc(i.reportId)}</code></dd>` : ""}${i.logKey ? `<dt>Log line</dt><dd><code>${esc(i.logKey)}</code></dd>` : ""}
      ${l?.dol?.found ? `<dt>DOL inspection</dt><dd><code>${esc(l.dol.inspection)}</code> opened ${esc(l.dol.opened)}${l.dol.at_our_plant_address ? " · at this plant's address" : ""}</dd>` : ""}</dl></div>` : ""}
    ${f ? `<div class="sec"><h3>Paper form, read by Nemotron VL</h3><div class="formrow"><a href="/scans/301_${esc(l.site)}_case${esc(l.caseId)}.jpg" target="_blank"><img class="scan" src="/scans/301_${esc(l.site)}_case${esc(l.caseId)}.jpg" alt="scanned OSHA 301 form"></a>
      <dl class="kv"><dt>read by</dt><dd>${esc(f.read_by)} · ${esc(f.source)}</dd>
      <dt>case</dt><dd>${esc(f.case_no)}</dd><dt>date · time</dt><dd>${esc(f.injury_date)} ${esc(f.time_of_event)}</dd><dt>job</dt><dd>${esc(f.job_title)}</dd>
      <dt>injury</dt><dd>${esc((f.body_part && /\b(left|right)\b/i.test(f.body_part) ? [f.body_part] : [f.side, f.body_part]).filter(Boolean).join(" "))} — ${esc(f.injury)}</dd>
      <dt>typed log</dt><dd>${f.agrees_with_typed_log ? "agrees" : esc((f.differences || []).join("; "))}</dd></dl></div></div>` : ""}
    ${(i.verifier || []).length ? `<div class="sec"><h3>Verifier</h3>${i.verifier.map((x) => `<div class="verdict">${esc(x.objection)}<span class="vsrc">round ${x.round} · Evaluator said ${esc(x.verdict)}</span></div>`).join("")}</div>` : ""}
    ${(l?.verdicts || []).length ? `<div class="sec"><h3>Evaluator</h3>${l.verdicts.map((v) => `<div class="verdict ${v.verdict === "same" ? "same" : ""}">${esc(v.reason)}<span class="vsrc">round ${v.round} · ${esc(v.verdict)} · ${esc(v.source)}</span></div>`).join("")}</div>` : ""}
    ${(i.hypotheses || []).length ? `<div class="sec"><h3>Explanations weighed</h3><ul class="hyps">${i.hypotheses.map((h) => `<li class="${esc(h.status)}"><span class="st">${esc(h.status.replace(/_/g, " "))}</span> ${esc(HYP[h.h] ? HYP[h.h](i.dir) : h.h)} <span class="fine">— ${esc(h.why)}</span>${h.qids.map((q) => `<button class="qid" data-qid="${esc(q)}">${esc(q)}</button>`).join("")}</li>`).join("")}</ul></div>` : ""}
    <div class="sec"><h3>Where the agents searched</h3><ol class="path">${i.searched.map((s) => `<li>${esc(s.label)}${s.found != null ? `<span class="n">${s.found} found</span>` : ""}${s.qid ? `<button class="qid" data-qid="${esc(s.qid)}">${esc(s.qid)}</button>` : ""}</li>`).join("")}</ol></div>
    <div class="sec"><button class="ghost" data-lanetrace="${esc(i.lane)}">Show this lane in the trace</button></div>`;
  $("#drawer").classList.remove("hidden");
}

// ---------------------------------------------------------------- unseen company
async function unseenPoll(start) {
  const u = await api("/api/unseen", start ? { method: "POST" } : undefined);
  const el = $("#unseenOut");
  if (u.phase === "running") {
    el.innerHTML = `<ol class="u-ev">${(u.events || []).map((e) => `<li><b>${esc(e.agent)}</b> ${esc(e.summary)}</li>`).join("")}</ol>`;
    setTimeout(() => unseenPoll(false), 500); return;
  }
  if (u.phase === "error") { el.innerHTML = `<p class="fine">Stopped: ${esc(u.error)}</p>`; $("#unseenBtn").disabled = false; return; }
  if (u.phase !== "done") return;
  $("#unseenBtn").disabled = false;
  const r = u.result, c = r.counts || {};
  const ok = (a, b) => (a && a === b ? "ok" : "no");
  const inc = r.rows.filter((x) => x.truth === "incident" || x.role === "incident");
  const replay = r.models.every((m) => m.startsWith("replay")), stub = r.stub;
  el.innerHTML = `<div class="u-score"><div><b>${c.logsFound}/${c.logs}</b><span>injury logs found${c.logsPicked > c.logsFound ? `, ${c.logsPicked - c.logsFound} wrong picks` : ", no wrong picks"}</span></div>
    <div><b>${c.fieldsRight}/${c.fields}</b><span>fields mapped right (date, body part, narrative, site)</span></div>
    <div><b>${r.rows.length}</b><span>tables read, ${r.rows.filter((x) => x.truth !== "incident").length} of them not injury logs</span></div></div>
    <table class="u-tab"><tr><th>Injury log (answer key)</th><th>date</th><th>body part</th><th>narrative</th><th>site</th></tr>${inc.map((x) => `<tr class="${x.role === x.truth ? "" : "miss"}"><td><code>${esc(x.fq)}</code>${x.role !== x.truth ? ` <span class="fine">${x.role === "incident" ? "not an injury log" : "missed"}</span>` : ""}</td>${["date", "body_part", "narrative", "site"].map((k) => `<td class="${ok(x.map?.[k], x.truthMap?.[k])}">${esc(x.map?.[k] ?? "—")}</td>`).join("")}</tr>`).join("")}</table>
    <p class="fine">${stub ? "Models: offline stub (no recording, no token): a rule baseline, not an agent score." : replay ? `Replayed from a recorded live run: ${r.queries} queries to Zetaris as the company's own role, ${r.calls} Nemotron calls through Nightshift.` : `Live: ${r.queries} Zetaris queries, ${r.calls} Nemotron calls.`} Scored against the generator's answer key (sample/${esc(u.folder)}/answers.json).</p>`;
}

async function unseen2Poll(start) {
  const u = await api("/api/unseen2", start ? { method: "POST" } : undefined);
  const el = $("#unseen2Out");
  if (u.phase === "running") { el.innerHTML = `<p class="fine">Replaying the recorded live run…</p>`; setTimeout(() => unseen2Poll(false), 700); return; }
  $("#unseen2Btn").disabled = false;
  if (u.phase !== "done") { el.innerHTML = u.error ? `<p class="fine">${esc(u.error)}</p>` : ""; return; }
  const r = u.result, c = r.counts;
  const flips = r.verifierLanes.filter((l) => l.path.some((e) => e.agent === "verifier" && e.kind === "reject"));
  el.innerHTML = `<div class="u-score"><div><b>${r.items.length}</b><span>conclusions</span></div><div><b>${c.evaluatorRejects} / ${c.verifierRejects}</b><span>Evaluator / Verifier rejections</span></div><div><b>${c.escalations}</b><span>sent to a person</span></div></div>` +
    flips.map((l) => `<div class="flip"><div class="label">${esc(l.lane)} · ${esc(l.site)} → ${esc(l.state.replace(/_/g, " "))}${l.synthetic ? ` · ${esc(l.synthetic)}` : ""}</div><ol>${l.path.map((e) => `<li class="${esc(e.kind)}"><b>${esc(e.agent)}</b> ${esc(e.kind)} — ${esc(e.summary)}${(e.receipts || []).length ? `<div>${e.receipts.map((q) => `<button class="qid" data-qid="${esc(q)}" data-replay="unseen2">${esc(q)}</button>`).join("")}</div>` : ""}</li>`).join("")}</ol></div>`).join("") +
    `<p class="fine">Replayed from the live run (${r.modelCalls} Nemotron calls through Nightshift; Zetaris queries as the company's own role). A composite of public records; its negative cases are invented records in invented plants (Site-SYN…).</p>`;
}

// ---------------------------------------------------------------- polling + actions
let timer;
async function poll() {
  const [s, ev] = await Promise.all([api("/api/state"), api("/api/trace?since=" + (events.at(-1)?.seq ?? 0))]);
  if (s.id && state.id && s.id !== state.id) { events = []; reviewer.clear(); }
  state = s; events.push(...ev);
  // re-render only when something changed: a rebuilt DOM every 2.5 s loses clicks and scroll position
  const sig = JSON.stringify(s) + "|" + events.length;
  if (sig !== lastSig) { lastSig = sig; render(); }
  clearTimeout(timer);
  timer = setTimeout(poll, ["discovering", "compiling", "matching"].includes(s.phase) ? 350 : 2500);
}

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, a");
  if (!t) return;
  if (t.id === "unseen2Btn") { t.disabled = true; unseen2Poll(true); return; }
  if (t.id === "unseenBtn") { t.disabled = true; $("#unseenOut").innerHTML = `<p class="fine">Reading the catalog…</p>`; unseenPoll(true); return; }
  if (t.id === "againBtn") { t.disabled = true; events = []; laneFilter = null; lastSig = ""; $("#uslBtn").disabled = false; $("#barApprove").disabled = false; await api("/api/run?pace=" + $("#pace").value, { method: "POST" }); t.disabled = false; window.scrollTo({ top: 0 }); poll(); return; }
  if (t.id === "startBtn") { t.disabled = true; events = []; await api("/api/run?pace=" + $("#pace").value, { method: "POST" }); poll(); }
  else if (t.id === "uslBtn" || t.id === "barApprove") { $("#uslBtn").disabled = true; t.disabled = true; await api("/api/usl/approve", { method: "POST", body: JSON.stringify({ by: "EHS records lead (Zetaris admin)" }) }); poll(); }
  else if (t.dataset.approve || t.dataset.reject) {
    t.closest(".prop").querySelectorAll("button").forEach((b) => (b.disabled = true));
    const r = await api("/api/merge", { method: "POST", body: JSON.stringify({ id: t.dataset.approve || t.dataset.reject, approve: !!t.dataset.approve, by: "EHS records lead" }) });
    flash = new Set((r.changed || []).map((c) => c.lane));
    await poll();
    setTimeout(() => { flash.clear(); lastSig = ""; render(); }, 2400);
  }
  else if (t.classList.contains("item") || (t.dataset.lane && !t.dataset.lanetrace)) drawer(t.dataset.lane);
  else if (t.dataset.qid) receipt(t.dataset.qid, t.dataset.replay);
  else if (t.dataset.clearlane) { laneFilter = null; renderTrace(); }
  else if (t.dataset.agent) { agentFilter = t.dataset.agent === "all" ? null : t.dataset.agent; renderTrace(); }
  else if (t.dataset.lanetrace) { agentFilter = null; keyOnly = false; laneFilter = t.dataset.lanetrace; $("#trace").classList.remove("hidden"); $("#drawer").classList.add("hidden"); renderTrace(); }
  else if (t.id === "discToggle") { discOpen = !discOpen; lastSig = ""; render(); }
  else if (t.id === "traceBtn") { laneFilter = null; renderTrace(); $("#trace").classList.toggle("hidden"); }
  else if (t.id === "keyOnly" || t.id === "allEv") { keyOnly = t.id === "keyOnly"; renderTrace(); }
  else if (t.id === "scoreBtn") $("#proof").scrollIntoView({ behavior: "smooth" });
  else if (t.id === "traceClose") $("#trace").classList.add("hidden");
  else if (t.id === "drawerClose") $("#drawer").classList.add("hidden");
  else if (t.id === "modalClose") $("#modal").classList.add("hidden");
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { $("#modal").classList.add("hidden"); $("#drawer").classList.add("hidden"); $("#trace").classList.add("hidden"); } });

// deep links for demos and screenshots: #trace, #lane=L6
let deep = location.hash;
intro().catch(() => {}).finally(async () => {
  await poll();
  if (/trace/.test(deep)) $("#trace").classList.remove("hidden");
  const m = deep.match(/lane=(\w+)/); if (m) drawer(m[1]);
});
