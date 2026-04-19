import { describe, it, expect } from "vitest";
import { findRenames } from "../../../src/lib/preservation/renameDetection.js";

/**
 * Helper: build a Map<relPath, sha> from plain object for brevity.
 */
function m(obj: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(obj));
}

describe("findRenames", () => {
  it("detects single-pair rename by sha match", () => {
    const pristine = m({ "old.lua": "aaa" });
    const pack = m({ "new.lua": "aaa" });

    const result = findRenames(pristine, pack);

    expect(result).toEqual([{ oldPath: "old.lua", newPath: "new.lua" }]);
  });

  it("returns no rename (ambiguous) for duplicate-content files", () => {
    // Pristine has 2 files with the same sha, pack has 2 files with the same sha.
    // The pairing is ambiguous (could be swapped), so we emit nothing.
    const pristine = m({
      "a.lua": "aaa",
      "b.lua": "aaa",
    });
    const pack = m({
      "c.lua": "aaa",
      "d.lua": "aaa",
    });

    const result = findRenames(pristine, pack);

    expect(result).toEqual([]);
  });

  it("does not mark identical-path same-sha as rename", () => {
    // Same path + same sha on both sides → file is identical-location, not a rename.
    const pristine = m({ "foo.lua": "aaa" });
    const pack = m({ "foo.lua": "aaa" });

    const result = findRenames(pristine, pack);

    expect(result).toEqual([]);
  });

  it("returns empty array when no hashes overlap", () => {
    const pristine = m({ "a.lua": "aaa" });
    const pack = m({ "b.lua": "bbb" });

    const result = findRenames(pristine, pack);

    expect(result).toEqual([]);
  });

  it("returns empty array for empty inputs", () => {
    expect(findRenames(m({}), m({}))).toEqual([]);
    expect(findRenames(m({ "a.lua": "aaa" }), m({}))).toEqual([]);
    expect(findRenames(m({}), m({ "a.lua": "aaa" }))).toEqual([]);
  });

  it("detects multiple independent renames across distinct shas", () => {
    const pristine = m({
      "old1.lua": "aaa",
      "old2.lua": "bbb",
    });
    const pack = m({
      "new1.lua": "aaa",
      "new2.lua": "bbb",
    });

    const result = findRenames(pristine, pack);
    // Sort for stable comparison; order is an implementation detail.
    const sorted = [...result].sort((a, b) => a.oldPath.localeCompare(b.oldPath));

    expect(sorted).toEqual([
      { oldPath: "old1.lua", newPath: "new1.lua" },
      { oldPath: "old2.lua", newPath: "new2.lua" },
    ]);
  });

  it("skips ambiguous shas but still emits unambiguous ones alongside", () => {
    // sha "aaa" is ambiguous on pristine side (2 paths), skip.
    // sha "bbb" has 1 path each side with different names → rename.
    // sha "ccc" has identical paths → no rename.
    const pristine = m({
      "a1.lua": "aaa",
      "a2.lua": "aaa",
      "old.lua": "bbb",
      "same.lua": "ccc",
    });
    const pack = m({
      "a3.lua": "aaa",
      "new.lua": "bbb",
      "same.lua": "ccc",
    });

    const result = findRenames(pristine, pack);

    expect(result).toEqual([{ oldPath: "old.lua", newPath: "new.lua" }]);
  });

  it("treats sha with one path on pristine but two paths on pack side as ambiguous", () => {
    const pristine = m({ "old.lua": "aaa" });
    const pack = m({
      "new1.lua": "aaa",
      "new2.lua": "aaa",
    });

    const result = findRenames(pristine, pack);

    expect(result).toEqual([]);
  });
});
