// Model calls. Nightshift (Meterless) is the only provider. Rules:
//   - header meterless-scope: `user` by default, as the Power contract says. Under `user` Nightshift's H-MEM injects
//     earlier answers into similar prompts (see config.ts and README); METERLESS_SCOPE=iso sends a fresh iso-<uuid> per
//     request, which is how the recorded runs were made.
//   - at most one request in flight (the NVIDIA quota is shared with two sibling projects)
//   - the served model id is recorded for every call; reasoning text (<think>…</think>) is stripped before use
//   - SAMPLE_MODE replays recorded responses; on a miss with no token (or L1_MODEL_OFFLINE=true) the agent's own
//     deterministic stub answers and the trace marks it "offline-stub" — it is never presented as Nemotron output.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config, scrub } from "./config.ts";

export type Lane = "deep" | "fast" | "vision";
export type Msg = { role: "system" | "user" | "assistant"; content: string | unknown[] };
export type ModelReply = { text: string; served: string; requested: string; lane: Lane; source: "live" | "replay" | "offline-stub"; latencyMs: number; tokens?: number };

export class ModelUnavailable extends Error {}

const canonical = (v: unknown): string =>
  v === null || typeof v !== "object" ? JSON.stringify(v) ?? "null"
    : Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]"
    : "{" + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}";
export const callKey = (lane: Lane, messages: Msg[]) => createHash("sha256").update(lane + "|" + canonical(messages)).digest("hex").slice(0, 24);

export function stripReasoning(t: string): string {
  if (!t) return "";
  let s = t.replace(/<think>[\s\S]*?<\/think>/g, "");
  if (s.includes("</think>")) s = s.slice(s.lastIndexOf("</think>") + 8);
  return s.trim();
}

/** first JSON object/array in a model reply (tolerates ```json fences and prose around it) */
export function extractJson<T = unknown>(t: string): T | undefined {
  const s = stripReasoning(t).replace(/```(?:json)?/g, "");
  const openers = ["{", "["].filter((o) => s.includes(o)).sort((a, b) => s.indexOf(a) - s.indexOf(b));
  for (const open of openers) {
    const i = s.indexOf(open);
    const close = open === "{" ? "}" : "]";
    for (let j = s.lastIndexOf(close); j > i; j = s.lastIndexOf(close, j - 1)) {
      try { return JSON.parse(s.slice(i, j + 1)) as T; } catch { /* keep shrinking */ }
    }
  }
  return undefined;
}

/** Assemble an OpenAI-style SSE stream: content deltas only (reasoning deltas dropped); served model from the chunks. */
export async function readStream(res: Response): Promise<{ text: string; served?: string }> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("event-stream")) { // a provider that ignored stream:true
    const out = JSON.parse(await res.text());
    return { text: out.choices?.[0]?.message?.content ?? "", served: out.model };
  }
  let text = "", served: string | undefined, buf = "";
  const dec = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return { text, served };
      let j: { error?: unknown; model?: string; meterless?: { routed_model?: string }; choices?: { delta?: { content?: string } }[] };
      try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new Error("stream error: " + JSON.stringify(j.error).slice(0, 200));
      served = j.meterless?.routed_model ?? j.model ?? served;
      text += j.choices?.[0]?.delta?.content ?? "";
    }
  }
  return { text, served };
}

/** Nightshift routes a request whose last user message is long (over ~1,100 characters) to a path that never answers
 *  (404 "Function not found" after 45 s; see NIGHTSHIFT_長提示做法.md). Same content, different place: every text
 *  message goes into one system message, the user message is one short instruction. Image messages are left as they are. */
export const NIGHTSHIFT_ASK = "Answer now: follow the instructions above for the input given there. Reply in the format the instructions ask for.";
export function packForNightshift(messages: Msg[]): Msg[] {
  if (messages.some((m) => typeof m.content !== "string")) return messages;
  const sys = messages.filter((m) => m.role === "system").map((m) => m.content as string);
  const rest = messages.filter((m) => m.role !== "system").map((m) => (m.role === "user" ? "INPUT:\n" : "PREVIOUS ANSWER:\n") + (m.content as string));
  return [{ role: "system", content: [...sys, ...rest].join("\n\n") }, { role: "user", content: NIGHTSHIFT_ASK }];
}

let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = chain.then(fn, fn); chain = p.catch(() => undefined); return p; };

export class Models {
  private cassette = new Map<string, { text: string; served: string; tokens?: number }>();
  private file: string;
  readonly calls: ModelReply[] = [];
  /** the call waiting for an answer right now, for the progress line in the UI */
  inflight?: { lane: Lane; tag: string; since: number; replay: boolean };
  /** the plant of an agent lane (L6, R29), recorded next to each answer so the output gate's scan can check it (app/gate.ts) */
  siteOf: (lane: string) => string | undefined = () => undefined;
  constructor(private opts: { record?: boolean; runDir?: string; dir?: string } = {}) {
    this.file = path.join(opts.dir ?? config.sampleDir, "model_cassette.jsonl");
    if (existsSync(this.file))
      for (const l of readFileSync(this.file, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l); this.cassette.set(r.key, r); }
  }

  modelFor(lane: Lane) { return lane === "deep" ? config.nightshift.deep : lane === "fast" ? config.nightshift.fast : config.nightshift.vision; }

  private async live(lane: Lane, messages: Msg[], maxTokens: number, retries = config.nightshift.retries): Promise<{ text: string; served: string; tokens?: number; latencyMs: number }> {
    const requested = this.modelFor(lane);
    let last = "";
    for (let attempt = 0; attempt < retries; attempt++) {
      const t0 = Date.now();
      try {
        // streaming + tier split off: Nightshift gives the upstream 45 s to send headers; streaming answers start at once,
        // so long reasoning replies are not cut off and re-routed to retired models (404 / 410).
        const req = new Request(config.nightshift.baseUrl.replace(/\/$/, "") + "/chat/completions", {
          method: "POST",
          headers: { Authorization: "Bearer " + config.nightshift.token, "Content-Type": "application/json",
            "meterless-app": config.nightshift.app, "meterless-scope": config.nightshift.scope === "user" ? "user" : "iso-" + randomUUID(), "meterless-tier-split": "off" },
          body: JSON.stringify({ model: requested, messages: packForNightshift(messages), max_tokens: maxTokens, temperature: 0, stream: true }),
          signal: AbortSignal.timeout(config.nightshift.timeoutMs),
        });
        const res = await fetch(req);
        // the headers this request actually carried, read back from the Request object fetch sent (token masked), and the
        // response's status and headers: the evidence of which meterless-scope went out (README, Sponsor technology)
        if (this.opts.runDir) {
          mkdirSync(this.opts.runDir, { recursive: true });
          appendFileSync(path.join(this.opts.runDir, "http_log.jsonl"), scrub(JSON.stringify({ at: new Date().toISOString(), lane, attempt, url: req.url.replace(/^https?:\/\/[^/]+/, "<nightshift>"),
            request_headers: Object.fromEntries([...req.headers].map(([k, v]) => [k, k === "authorization" ? "(token masked)" : v])), status: res.status,
            response_headers: Object.fromEntries([...res.headers].filter(([k]) => !/cookie|authorization/i.test(k))) })) + "\n");
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        const { text, served } = await readStream(res);
        if (!text.trim()) throw new Error("empty reply");
        // streaming has no usage block: tokens estimated as characters / 4 (prompt + reply)
        const est = Math.round((JSON.stringify(messages).length + text.length) / 4);
        return { text: stripReasoning(text), served: served ?? "unknown", tokens: est, latencyMs: Date.now() - t0 };
      } catch (e) {
        last = scrub(String((e as Error).message ?? e));
        const wait = [15_000, 30_000, 60_000, 120_000, 180_000][Math.min(attempt, 4)];
        if (attempt < retries - 1) await new Promise((r) => setTimeout(r, lane === "vision" ? Math.min(wait, 30_000) : wait));
      }
    }
    throw new ModelUnavailable(`Nightshift unavailable after ${retries} tries: ${last}`);
  }

  /** stub: the agent's deterministic fallback for offline runs (tests, judges without a token). */
  async chat(lane: Lane, messages: Msg[], o: { tag: string; maxTokens?: number; retries?: number; stub: () => string }): Promise<ModelReply> {
    const key = callKey(lane, messages);
    const requested = this.modelFor(lane);
    const hit = this.cassette.get(key);
    let reply: ModelReply;
    const canLive = !config.nightshift.offline && !!config.nightshift.token;
    if (hit && (config.sampleMode || config.nightshift.offline)) {
      this.inflight = { lane, tag: o.tag, since: Date.now(), replay: true };
      if (config.paceMs) await new Promise((r) => setTimeout(r, config.paceMs * 6));
      this.inflight = undefined;
      reply = { text: hit.text, served: hit.served, requested, lane, source: "replay", latencyMs: 0, tokens: hit.tokens };
    } else if (!canLive) {
      reply = { text: o.stub(), served: "offline-stub", requested, lane, source: "offline-stub", latencyMs: 0 };
    } else {
      this.inflight = { lane, tag: o.tag, since: Date.now(), replay: false };
      const r = await serial(() => this.live(lane, messages, o.maxTokens ?? 6000, o.retries)).finally(() => { this.inflight = undefined; });
      reply = { ...r, requested, lane, source: "live" };
      if (this.opts.record) {
        const agentLane = o.tag.match(/\.([LR]\d+)(\.|$)/)?.[1] ?? o.tag.match(/(Site-[A-Z0-9]{4})/)?.[1];
        const site = agentLane?.startsWith("Site-") ? agentLane : agentLane ? this.siteOf(agentLane) : undefined;
        appendFileSync(this.file, JSON.stringify({ key, tag: o.tag, ...(site ? { site } : {}), lane, requested, served: r.served, tokens: r.tokens, text: r.text, at: new Date().toISOString() }) + "\n");
        this.cassette.set(key, { text: r.text, served: r.served, tokens: r.tokens });
      }
    }
    this.calls.push(reply);
    if (this.opts.runDir) {
      mkdirSync(this.opts.runDir, { recursive: true });
      appendFileSync(path.join(this.opts.runDir, "model_calls.jsonl"),
        scrub(JSON.stringify({ tag: o.tag, key, lane, requested, served: reply.served, source: reply.source, latencyMs: reply.latencyMs, tokens: reply.tokens,
          // which meterless-scope a live call was sent with (the product's default is the contract's `user`)
          ...(reply.source === "live" ? { scope: config.nightshift.scope === "user" ? "user" : "iso-<uuid>" } : {}) })) + "\n");
    }
    return reply;
  }
}
