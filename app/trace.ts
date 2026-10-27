// Structured trace: every agent step is one event. The UI, the counsel export and the README all read this.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { scrub } from "./config.ts";
import { gateEvent } from "./gate.ts";

export type Agent = "planner" | "discovery" | "linker" | "evaluator" | "verifier" | "research" | "reader" | "skeptic" | "risk" | "final" | "world" | "human" | "system";
export type Kind =
  | "plan" | "replan" | "sql" | "model" | "verdict" | "reject" | "approve" | "retry" | "branch" | "escalate"
  | "proposal" | "merge" | "conclusion" | "blocked" | "phase" | "fallback" | "error" | "info";

export type TraceEvent = {
  seq: number; t: string; run: string; agent: Agent; kind: Kind; summary: string;
  lane?: string; site?: string; withheld?: boolean; attempt?: number; parent?: number; receipts?: string[];
  model?: { lane: string; requested: string; served: string; source: "live" | "replay" | "offline-stub"; latencyMs?: number; tokens?: number };
  detail?: unknown;
};

type Listener = (e: TraceEvent) => void;

export class Trace {
  readonly events: TraceEvent[] = [];
  private listeners = new Set<Listener>();
  private file?: string;
  /** the plant of a lane (set by the Matcher), so the output gate can tell a real plant's step from an invented plant's */
  siteOf: (lane: string) => string | undefined = () => undefined;
  constructor(readonly run: string, dir?: string) {
    if (dir) { mkdirSync(dir, { recursive: true }); this.file = path.join(dir, "trace.jsonl"); }
  }
  emit(e: Omit<TraceEvent, "seq" | "t" | "run">): TraceEvent {
    // every event leaves through the output gate (app/gate.ts): at a real plant only neutral results are shown
    const site = e.lane ? this.siteOf(e.lane) : undefined;
    const ev: TraceEvent = gateEvent({ seq: this.events.length + 1, t: new Date().toISOString(), run: this.run, ...e, ...(site ? { site } : {}) }, this.siteOf);
    this.events.push(ev);
    if (this.file) appendFileSync(this.file, scrub(JSON.stringify(ev)) + "\n");
    for (const l of this.listeners) l(ev);
    return ev;
  }
  on(l: Listener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  byLane(lane: string) { return this.events.filter((e) => e.lane === lane); }
}
