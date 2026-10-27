// Measures Nightshift's H-MEM injection for meterless-scope: user vs iso-<uuid>, one request at a time.
// Reads METERLESS_BASE_URL / METERLESS_RUNTIME_TOKEN from the parent .env; never prints them.
import { readFileSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const env = Object.fromEntries(readFileSync(process.argv[2], "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const base = env.METERLESS_BASE_URL.replace(/\/$/, ""), token = env.METERLESS_RUNTIME_TOKEN;
const out = process.argv[3];
const system = `You are the Evaluator in an injury-records self-audit run under counsel. Decide whether an OSHA severe-injury report and a company log entry describe the same injury. Employer names are masked, so the place rests on the address. Reply JSON only: {"verdict":"same"|"different"|"insufficient","reason":"<= 25 words"}.
Company log: plant Site-SYN1, house number 9100, TESTVILLE IL 00910, date 2024-10-02, body part: left index fingertip, narrative: partial amputation, left index fingertip, slicer, clearing a jam.
OSHA report SIR-SYN001: employer masked, 9102 Turbine Way, TESTVILLE IL 00910, 2024-10-03, amputation flag 1, Finger or thumb tip(s), narrative: amputation, fingertip, slicer, clearing a jam. No referral number.`;
const user = "Decide now.";
const system2 = system.replace("Site-SYN1", "Site-SYN3").replace("9100", "9101").replace("TESTVILLE IL 00910", "OTHERTON IL 00911").replace("2024-10-02", "2024-09-09").replace("left index fingertip", "right middle fingertip").replace("SIR-SYN001", "SIR-SYN009").replace("9102 Turbine Way", "9103 Harbor Rd").replace("2024-10-03", "2024-09-09").replace("slicer", "band saw");
async function one(label, scope, extra = {}, sys = system) {
  const t0 = Date.now();
  const res = await fetch(base + "/chat/completions", { method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "meterless-app": process.argv[4] || "l1-same-injury", "meterless-scope": scope, "meterless-tier-split": "off" },
    body: JSON.stringify({ model: "nvidia/nemotron-3-ultra-550b-a55b", messages: [{ role: "system", content: sys }, { role: "user", content: user }], max_tokens: 3000, temperature: 0, stream: false, ...extra }),
    signal: AbortSignal.timeout(300000) });
  const j = await res.json().catch(() => ({}));
  const m = j.meterless || {};
  const r = { label, scope: scope.startsWith("iso-") ? "iso-<uuid>" : scope, status: res.status, ms: Date.now() - t0, prompt_tokens: j.usage?.prompt_tokens, completion_tokens: j.usage?.completion_tokens,
    est_prompt_tokens: Math.round((sys.length + user.length) / 4), hmem: m.receipt?.hmem ?? null, routed: m.routed_model, from_cache: m.from_cache, error: j.error ? String(j.error.message ?? j.error).slice(0, 160) : undefined };
  console.log(JSON.stringify(r));
  appendFileSync(out, JSON.stringify({ at: new Date().toISOString(), ...r }) + "\n");
}
const plan = process.argv[5] || "user,iso";
for (const p of plan.split(",")) {
  if (p === "user") await one("scope=user", "user");
  if (p === "iso") await one("scope=iso", "iso-" + randomUUID());
  if (p === "user2") await one("scope=user, second similar prompt", "user", {}, system2);
  if (p === "iso2") await one("scope=iso, second similar prompt", "iso-" + randomUUID(), {}, system2);
  if (p === "user-tools") await one("scope=user + tools:[]", "user", { tools: [] });
}
