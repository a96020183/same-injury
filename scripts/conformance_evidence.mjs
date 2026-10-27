// Re-runs the official World Model conformance suite (vendor/meterless, via scripts/run_conformance.mjs) and keeps its
// output as evidence under version control: docs/evidence/world_model_conformance.{txt,json}. Local paths are masked;
// the output carries no key. README's Meterless line is written from the JSON (scripts/readme_numbers.ts).
//   node scripts/conformance_evidence.mjs        (needs vendor/meterless, which is not in the repository)
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const r = spawnSync(process.execPath, [path.join(root, "scripts", "run_conformance.mjs")], { cwd: root, encoding: "utf8" });
const commit = spawnSync("git", ["-C", path.join(root, "vendor", "meterless"), "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim() || "unknown";
const mask = (s) => s.split(root.split(path.sep).join("/")).join("<repo>").split(root).join("<repo>").replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s]+/g, "<home>");
const out = mask(`${r.stdout ?? ""}${r.stderr ?? ""}`).trim();
const checks = [...out.matchAll(/^\s*(PASS|FAIL)\s+(\S+)\s+(.*)$/gm)].map((m) => ({ id: m[2], result: m[1], what: m[3] }));
const total = out.match(/(\d+)\/(\d+) checks passed/);
const at = new Date().toISOString();
const summary = { run_at_utc: at, suite: "Meterless World Model conformance (vendor/meterless/engines/world-model/conformance/runner.ts)", vendor_commit: commit,
  implementation: "engine/world-model/index.ts", node: process.version, exit_code: r.status, passed: total ? Number(total[1]) : checks.filter((c) => c.result === "PASS").length,
  total: total ? Number(total[2]) : checks.length, checks };
mkdirSync(path.join(root, "docs", "evidence"), { recursive: true });
writeFileSync(path.join(root, "docs", "evidence", "world_model_conformance.json"), JSON.stringify(summary, null, 1) + "\n");
writeFileSync(path.join(root, "docs", "evidence", "world_model_conformance.txt"),
  `# npm run conformance, re-run ${at} (vendor/meterless ${commit}, Node ${process.version}); local paths masked\n\n${out}\n`);
console.log(`${summary.passed}/${summary.total} checks passed · exit ${r.status} · docs/evidence/world_model_conformance.{txt,json}`);
process.exit(r.status ?? 1);
