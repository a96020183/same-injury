// Run the official conformance runner (vendor/meterless, commit 1742dec) against L1's own World Model implementation.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const impl = path.join(root, "engine", "world-model", "index.ts").split(path.sep).join("/");
const tsx = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const r = spawnSync(tsx, ["runner.ts"], { cwd: path.join(root, "vendor/meterless/engines/world-model/conformance"),
  env: { ...process.env, WORLD_MODEL_IMPL: impl }, stdio: "inherit", shell: process.platform === "win32" });
process.exit(r.status ?? 1);
