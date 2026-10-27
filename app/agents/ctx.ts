import type { SqlTool } from "../zetaris.ts";
import type { Models, ModelReply } from "../llm.ts";
import { extractJson } from "../llm.ts";
import type { Trace, Agent } from "../trace.ts";
import type { L1World } from "../world.ts";
import type { config } from "../config.ts";

export type Ctx = {
  sql: SqlTool; models: Models; trace: Trace; world: L1World; cfg: typeof config.zetaris;
  noteModel: (agent: Agent, r: ModelReply, what: string, lane?: string) => void;
};

export function makeNoteModel(trace: Trace) {
  return (agent: Agent, r: ModelReply, what: string, lane?: string) =>
    trace.emit({ agent, kind: "model", lane, summary: `${what} — ${r.source === "offline-stub" ? "offline stub (no model)" : r.served}`,
      model: { lane: r.lane, requested: r.requested, served: r.served, source: r.source, latencyMs: r.latencyMs, tokens: r.tokens } });
}

/** Parse a model reply; if it is not JSON, use the agent's deterministic fallback and say so in the trace. */
export function parseReply<T>(ctx: Ctx, r: ModelReply, stub: () => string, agent: Agent, what: string, lane?: string): T {
  const v = extractJson<T>(r.text);
  // the reply must have the shape the agent asked for (the stub's shape): a stray "[]" from a cut-off reply is not a decision
  const wantArray = Array.isArray(JSON.parse(stub()));
  if (v !== undefined && v !== null && typeof v === "object" && Array.isArray(v) === wantArray) return v;
  ctx.trace.emit({ agent, kind: "fallback", lane, summary: `${what}: ${r.served} reply was not JSON; deterministic fallback used.`, detail: { replyStart: r.text.slice(0, 200) } });
  return JSON.parse(stub()) as T;
}
