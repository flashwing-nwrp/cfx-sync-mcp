import { describe, it, expect } from "vitest";
import { AUTHOR_PREFIXES, prefixesForAuthor } from "../../../src/lib/discovery/authorPrefixes.js";

describe("authorPrefixes", () => {
  it("returns prefix list for known authors (case-insensitive)", () => {
    expect(prefixesForAuthor("BroFX")).toEqual(["brofx_"]);
    expect(prefixesForAuthor("brofx")).toEqual(["brofx_"]);
    expect(prefixesForAuthor("BROFX")).toEqual(["brofx_"]);
  });

  it("returns empty array for unknown authors", () => {
    expect(prefixesForAuthor("SomeRandoAuthor")).toEqual([]);
  });

  it("handles multi-prefix authors", () => {
    expect(prefixesForAuthor("ULC").sort()).toEqual(["dawnstar_", "ulc_"].sort());
    expect(prefixesForAuthor("quasarstore").sort()).toEqual(["qs-", "qs_"].sort());
  });

  it("includes LondonStudios and AL-Developments", () => {
    expect(prefixesForAuthor("LondonStudios").length).toBeGreaterThan(0);
    expect(prefixesForAuthor("AL-Developments").length).toBeGreaterThan(0);
  });

  it("returns empty for null/undefined/empty-string authors", () => {
    expect(prefixesForAuthor(null)).toEqual([]);
    expect(prefixesForAuthor(undefined)).toEqual([]);
    expect(prefixesForAuthor("")).toEqual([]);
  });
});
