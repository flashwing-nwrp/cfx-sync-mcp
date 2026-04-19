import { describe, it, expect } from "vitest";
import {
  PATTERNS,
  getAllPatterns,
} from "../../../../src/lib/updates/patterns/index.js";

describe("patterns barrel — PATTERNS registry", () => {
  it("exports exactly 4 patterns (codesign, prompt, quasarstore, ulc)", () => {
    expect(PATTERNS.length).toBe(4);
  });

  it("contains all 4 expected pattern ids", () => {
    const ids = PATTERNS.map((p) => p.id);
    expect(ids).toContain("codesign-v1");
    expect(ids).toContain("prompt-v1");
    expect(ids).toContain("quasarstore-v1");
    expect(ids).toContain("ulc-v1");
  });

  it("ids are listed in stable alphabetical order", () => {
    const ids = PATTERNS.map((p) => p.id);
    expect(ids).toEqual([
      "codesign-v1",
      "prompt-v1",
      "quasarstore-v1",
      "ulc-v1",
    ]);
  });

  it("first id is codesign-v1, last id is ulc-v1 (alphabetical lock)", () => {
    expect(PATTERNS[0]?.id).toBe("codesign-v1");
    expect(PATTERNS[PATTERNS.length - 1]?.id).toBe("ulc-v1");
  });

  it("every registered entry satisfies the NoticePattern shape", () => {
    for (const p of PATTERNS) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.description).toBe("string");
      expect(Array.isArray(p.trustedDomains)).toBe(true);
      expect(typeof p.blockMatch).toBe("function");
      expect(typeof p.canonicalSlug).toBe("function");
    }
  });

  it("pattern ids are unique (no accidental duplicate registration)", () => {
    const ids = PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("patterns barrel — getAllPatterns()", () => {
  it("returns the same array as PATTERNS", () => {
    expect(getAllPatterns()).toBe(PATTERNS);
  });

  it("returned array length matches PATTERNS.length", () => {
    expect(getAllPatterns().length).toBe(PATTERNS.length);
  });
});
