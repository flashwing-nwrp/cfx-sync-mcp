export type GateDecision = "FRESH" | "STALE";

export interface GateInput {
  callerId: string;      // "local" in Phase 1; Phase 2 uses per-admin ids
  lastPolledAt: string | null;
  force: boolean;
}

export interface GateResult {
  decision: GateDecision;
  ageMs: number | null;
}

export interface RateLimitOpts {
  ttlMs: number;
  clock?: () => number;
}

export class RateLimitGate {
  private ttlMs: number;
  private clock: () => number;

  constructor(opts: RateLimitOpts) {
    this.ttlMs = opts.ttlMs;
    this.clock = opts.clock ?? Date.now;
  }

  evaluate(input: GateInput): GateResult {
    if (input.force) return { decision: "FRESH", ageMs: null };
    if (!input.lastPolledAt) return { decision: "FRESH", ageMs: null };
    const ageMs = this.clock() - Date.parse(input.lastPolledAt);
    if (ageMs < this.ttlMs) return { decision: "STALE", ageMs };
    return { decision: "FRESH", ageMs };
  }
}
