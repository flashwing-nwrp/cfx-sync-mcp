import { describe, it, expect } from "vitest";
import { compareLoose } from "../../../src/lib/updates/semverCompare.js";
import type { SemverComparison } from "../../../src/lib/updates/semverCompare.js";

describe("compareLoose", () => {
  // ---------------------------------------------------------------------------
  // Core 10 edge cases from spec § Semver comparison helper
  // ---------------------------------------------------------------------------

  it("v-prefix on local side is stripped — behind", () => {
    const result: SemverComparison = compareLoose("v1.8.0", "1.9.0");
    expect(result).toBe("behind");
  });

  it("v-prefix on announced side is stripped — ULC fork: local ahead", () => {
    const result: SemverComparison = compareLoose("1.9.0", "v1.8.0");
    expect(result).toBe("ahead");
  });

  it("pre-release tag on local — 2.1.15-b vs 2.1.16 is behind", () => {
    const result: SemverComparison = compareLoose("2.1.15-b", "2.1.16");
    expect(result).toBe("behind");
  });

  it("pre-release tag — 1.0.0-beta vs 1.0.0 is equal (deliberate loose deviation)", () => {
    // Documented deviation from semver 2.0.0: pre-release tags are stripped
    // during coerce, so 1.0.0-beta coerces to 1.0.0 and compares equal.
    const result: SemverComparison = compareLoose("1.0.0-beta", "1.0.0");
    expect(result).toBe("equal");
  });

  it("2-part version normalized to 3-part — 1.0 vs 1.0.0 is equal", () => {
    const result: SemverComparison = compareLoose("1.0", "1.0.0");
    expect(result).toBe("equal");
  });

  it("4-part version is incomparable — 1.0.0.1 vs 1.0.0", () => {
    // coerce() would silently drop the 4th part; we guard before calling coerce
    const result: SemverComparison = compareLoose("1.0.0.1", "1.0.0");
    expect(result).toBe("incomparable");
  });

  it("date-style major.minor.patch — 2025.01.15 vs 2025.02.01 is behind", () => {
    const result: SemverComparison = compareLoose("2025.01.15", "2025.02.01");
    expect(result).toBe("behind");
  });

  it("monotone counter with non-numeric prefix r42 is incomparable", () => {
    const result: SemverComparison = compareLoose("r42", "r43");
    expect(result).toBe("incomparable");
  });

  it("fully non-numeric string abc is incomparable", () => {
    const result: SemverComparison = compareLoose("abc", "1.0.0");
    expect(result).toBe("incomparable");
  });

  it("empty string is incomparable", () => {
    const result: SemverComparison = compareLoose("", "1.0.0");
    expect(result).toBe("incomparable");
  });

  // ---------------------------------------------------------------------------
  // Additional parity / guard tests
  // ---------------------------------------------------------------------------

  it("equal versions without v-prefix", () => {
    expect(compareLoose("2.3.1", "2.3.1")).toBe("equal");
  });

  it("local clearly ahead without v-prefix", () => {
    expect(compareLoose("3.0.0", "2.9.9")).toBe("ahead");
  });

  it("V (uppercase) prefix is also stripped", () => {
    expect(compareLoose("V1.0.0", "1.0.0")).toBe("equal");
  });

  it("4-part version on announced side is incomparable", () => {
    expect(compareLoose("1.0.0", "1.0.0.1")).toBe("incomparable");
  });

  it("empty announced side is incomparable", () => {
    expect(compareLoose("1.0.0", "")).toBe("incomparable");
  });

  it("null-like (undefined coerced to string) handling — non-numeric stays incomparable", () => {
    // Guards should not throw; they should return incomparable
    expect(compareLoose("undefined", "1.0.0")).toBe("incomparable");
    expect(compareLoose("null", "1.0.0")).toBe("incomparable");
  });

  it("r-prefix on only one side makes that side incomparable", () => {
    expect(compareLoose("r42", "1.0.0")).toBe("incomparable");
    expect(compareLoose("1.0.0", "r43")).toBe("incomparable");
  });

  it("pre-release build metadata — 2.1.15-rc1 vs 2.1.15 is equal (loose policy)", () => {
    expect(compareLoose("2.1.15-rc1", "2.1.15")).toBe("equal");
  });

  it("v-prefix on both sides — still compares correctly", () => {
    expect(compareLoose("v2.0.0", "v1.9.9")).toBe("ahead");
  });
});
