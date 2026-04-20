import { describe, it, expect } from "vitest";
import { applyAuthorPrefixBoost, type BoostableCandidate } from "../../../src/lib/discovery/prefixBoost.js";

describe("applyAuthorPrefixBoost", () => {
  const cands: BoostableCandidate[] = [
    { target: "[maps]/brofx_church",       tier: 4, confidence: 0.82 },
    { target: "[maps]/brofx_mansion_10_v2", tier: 4, confidence: 0.78 },
    { target: "[maps]/unrelated_mlo",      tier: 4, confidence: 0.71 },
  ];

  it("moves prefix-matching alternatives ahead within the same tier", () => {
    const out = applyAuthorPrefixBoost(cands, "BroFX");
    expect(out[0].target).toContain("brofx_mansion_10_v2");
    expect(out[0].authorPrefixBoosted).toBe(true);
    expect(out[1].target).toContain("brofx_church");
    expect(out[1].authorPrefixBoosted).toBe(true);
    expect(out[2].target).toContain("unrelated_mlo");
    expect(out[2].authorPrefixBoosted).toBe(false);
  });

  it("leaves ordering untouched for unknown authors", () => {
    const out = applyAuthorPrefixBoost(cands, "UnknownAuthor");
    expect(out.map((c) => c.target)).toEqual(cands.map((c) => c.target));
    expect(out.every((c) => c.authorPrefixBoosted === false)).toBe(true);
  });

  it("does not cross tier boundaries", () => {
    const mixed: BoostableCandidate[] = [
      { target: "[x]/non_brofx_tier1", tier: 1, confidence: 1.0 },
      { target: "[maps]/brofx_thing",  tier: 4, confidence: 0.8 },
    ];
    const out = applyAuthorPrefixBoost(mixed, "BroFX");
    // Tier 1 still ranks before tier 4 even though brofx_ matches.
    expect(out[0].tier).toBe(1);
    expect(out[1].tier).toBe(4);
  });

  it("handles null/undefined author gracefully", () => {
    const out = applyAuthorPrefixBoost(cands, null);
    expect(out.every((c) => c.authorPrefixBoosted === false)).toBe(true);
  });

  it("basename match is case-insensitive", () => {
    const upper: BoostableCandidate[] = [
      { target: "[X]/BROFX_mansion", tier: 4, confidence: 0.9 },
      { target: "[x]/other",         tier: 4, confidence: 0.8 },
    ];
    const out = applyAuthorPrefixBoost(upper, "BroFX");
    expect(out[0].target).toContain("BROFX_mansion");
    expect(out[0].authorPrefixBoosted).toBe(true);
  });
});
