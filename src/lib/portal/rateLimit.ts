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
    const parsed = Date.parse(input.lastPolledAt);
    if (Number.isNaN(parsed)) {
      // Corrupted lastPolledAt — fail CLOSED (back off, force re-sync via force:true).
      return { decision: "STALE", ageMs: null };
    }
    const ageMs = this.clock() - parsed;
    // Negative age (lastPolledAt in the future — clock skew) is correctly
    // treated as STALE by `ageMs < this.ttlMs` since any negative is < ttlMs.
    if (ageMs < this.ttlMs) return { decision: "STALE", ageMs };
    return { decision: "FRESH", ageMs };
  }
}
