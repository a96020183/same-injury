// Runtime configuration. Secrets are read from .env (this folder first, then the parent folder) and are never printed,
// logged, or written anywhere. Everything else has a safe default so a judge can run SAMPLE_MODE with no keys at all.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readEnvFile(p: string): Record<string, string> {
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return out;
}

// only this folder's .env; the parent folder's only when asked (L1_PARENT_ENV=1, the build machine), so a clone inside
// another project never picks up that project's settings
const fileEnv = { ...(process.env.L1_PARENT_ENV === "1" ? readEnvFile(path.join(ROOT, "..", ".env")) : {}), ...readEnvFile(path.join(ROOT, ".env")) };
const env = (k: string, d = "") => process.env[k] || fileEnv[k] || d; // empty counts as unset
const flag = (k: string, d: boolean) => { const v = env(k, d ? "true" : "false").toLowerCase(); return v === "1" || v === "true" || v === "yes"; };

export const config = {
  sampleMode: flag("SAMPLE_MODE", true),
  seed: Number(env("L1_SEED", "1003")),
  sampleDir: env("L1_SAMPLE_DIR", "") || path.join(ROOT, "sample", `seed${env("L1_SEED", "1003")}`),
  runsDir: env("L1_RUNS_DIR", path.join(ROOT, "runs", "app")),
  port: Number(env("PORT", "8740")),
  // Zetaris (local Docker). In SAMPLE_MODE the recorded Zetaris responses are replayed; a cache miss falls back to the
  // bundled emulator (same catalog, same CSVs), and every receipt says which backend answered.
  zetaris: {
    url: env("ZETARIS_REST_URL", "http://localhost:8888/api/v1.0"),
    orgId: env("ZETARIS_ORG_ID", "1"),
    apiKey: env("ZETARIS_API_KEY"), // reviewer / administrator: used only for COMPILE USL after a person approves, and for "reveal"
    // the agents' own non-admin user (role L1_AGENT); Zetaris masks employer names and street names for it
    agentKey: env("ZETARIS_AGENT_API_KEY") || (existsSync(path.join(ROOT, "data", "private", "zetaris_agent_key_PRIVATE.txt"))
      ? readFileSync(path.join(ROOT, "data", "private", "zetaris_agent_key_PRIVATE.txt"), "utf8").trim() : ""),
    agentRole: env("L1_AGENT_ROLE", "L1_AGENT"),
    uslNamespace: env("L1_USL_NAMESPACE", "lightning.metastore.l1"),
    uslName: env("L1_USL_NAME", "injury_records"),
  },
  // Nightshift is the only model provider. The Power contract asks for `meterless-scope: user` on chat; with `user`,
  // Nightshift's H-MEM injects earlier answers into every similar prompt (measured 2026-10-24: +307 to +683 prompt
  // tokens, one prior answer from another lane; a fresh app name does not stop it, there is no per-request switch).
  // The default follows the contract (`user`). METERLESS_SCOPE=iso sends a fresh `iso-<uuid>` per request instead; the
  // recorded runs in the repo were made that way (scripts/record_live.sh), so no lane saw another lane's answer.
  nightshift: {
    scope: env("METERLESS_SCOPE", "user") === "iso" ? "iso" as const : "user" as const,
    baseUrl: env("METERLESS_BASE_URL", "http://127.0.0.1:8088/v1"),
    token: env("METERLESS_RUNTIME_TOKEN"),
    app: "l1-same-injury",
    deep: env("L1_MODEL_DEEP", "nvidia/nemotron-3-super-120b-a12b"),
    fast: env("L1_MODEL_FAST", "nvidia/nemotron-3.5-lightning-30b-a3b"),
    vision: env("L1_MODEL_VISION", "meterless/vision"),
    timeoutMs: Number(env("L1_MODEL_TIMEOUT_MS", "240000")),
    retries: Number(env("L1_MODEL_RETRIES", "6")), // Nightshift→NVIDIA fails often (404/410/deadline); retry, then escalate
    visionRetries: Number(env("L1_VISION_RETRIES", "12")), // the vision lane succeeded ~1 in 8 tries on 2026-10-23
    offline: flag("L1_MODEL_OFFLINE", false), // true = never call Nightshift (unit tests, no-key judges)
  },
  paceMs: Number(env("L1_PACE_MS", "0")), // demo pacing for replayed answers (e.g. 150 for screen recording); 0 = as fast as possible
  liveZetaris: flag("L1_LIVE_ZETARIS", false), // SAMPLE_MODE=false implies live; this forces live even in sample mode
};

export const secretValues = (): string[] =>
  [config.zetaris.apiKey, config.zetaris.agentKey, config.nightshift.token, ...Object.entries(fileEnv).filter(([k]) => /KEY|TOKEN|PASSWORD|SECRET/.test(k)).map(([, v]) => v)]
    .filter((v) => v && v.length >= 8);

export function scrub(s: unknown): string {
  let t = typeof s === "string" ? s : JSON.stringify(s);
  for (const v of secretValues()) t = t.split(v).join("<redacted>");
  return t.replace(/(bearer\s+)\S+/gi, "$1<redacted>").replace(/(awsSecretAccessKey\s+")[^"]+/g, "$1<redacted>").replace(/(password\s+")[^"]+/g, "$1<redacted>");
}
