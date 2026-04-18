import { describe, it, expect, beforeEach } from "vitest";
import { RateLimitGate } from "../../../src/lib/portal/rateLimit.js";

describe("RateLimitGate", () => {
  let nowMs: number;
  const clock = () => nowMs;

  beforeEach(() => {
    nowMs = Date.now();
  });

  it("returns FRESH when no prior poll exists", () => {
    const gate = new RateLimitGate({ ttlMs: 3_600_000, clock });
    const r = gate.evaluate({ callerId: "local", lastPolledAt: null, force: false });
    expect(r.decision).toBe("FRESH");
  });

  it("returns STALE when last poll was within TTL and force=false", () => {
    const gate = new RateLimitGate({ ttlMs: 3_600_000, clock });
    const recent = new Date(nowMs - 60_000).toISOString();
    const r = gate.evaluate({ callerId: "local", lastPolledAt: recent, force: false });
    expect(r.decision).toBe("STALE");
    expect(r.ageMs).toBeGreaterThanOrEqual(60_000);
  });

  it("returns FRESH when last poll was within TTL but force=true", () => {
    const gate = new RateLimitGate({ ttlMs: 3_600_000, clock });
    const recent = new Date(nowMs - 60_000).toISOString();
    const r = gate.evaluate({ callerId: "local", lastPolledAt: recent, force: true });
    expect(r.decision).toBe("FRESH");
  });

  it("returns FRESH when last poll was older than TTL", () => {
    const gate = new RateLimitGate({ ttlMs: 3_600_000, clock });
    const old = new Date(nowMs - 7_200_000).toISOString();
    const r = gate.evaluate({ callerId: "local", lastPolledAt: old, force: false });
    expect(r.decision).toBe("FRESH");
  });

  it("returns STALE for malformed lastPolledAt (fail closed)", () => {
    const gate = new RateLimitGate({ ttlMs: 3_600_000, clock });
    const r = gate.evaluate({ callerId: "local", lastPolledAt: "not-a-date", force: false });
    expect(r.decision).toBe("STALE");
    expect(r.ageMs).toBe(null);
  });

  it("returns STALE for future lastPolledAt (clock skew)", () => {
    const gate = new RateLimitGate({ ttlMs: 3_600_000, clock });
    const future = new Date(nowMs + 60_000).toISOString();
    const r = gate.evaluate({ callerId: "local", lastPolledAt: future, force: false });
    expect(r.decision).toBe("STALE");
  });
});
