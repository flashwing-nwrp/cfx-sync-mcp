import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { cachePath, pruneCache, verifyCacheFile } from "../../../src/lib/download/cache.js";

describe("cache", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "cfx-cache-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("cachePath returns <dir>/<grantId>-<versionId>.zip", () => {
    expect(cachePath(dir, 111, 222)).toBe(path.join(dir, "111-222.zip"));
  });

  it("verifyCacheFile computes SHA-256 of cached zip", async () => {
    const p = path.join(dir, "x.zip");
    writeFileSync(p, "hello");
    const { sha256, bytes } = await verifyCacheFile(p);
    // sha256("hello") precomputed
    expect(sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(bytes).toBe(5);
  });

  it("pruneCache deletes entries not in keepSet", async () => {
    writeFileSync(path.join(dir, "1-1.zip"), "a");
    writeFileSync(path.join(dir, "2-2.zip"), "b");
    writeFileSync(path.join(dir, "3-3.zip"), "c");
    await pruneCache(dir, new Set(["1-1.zip"]));
    expect(existsSync(path.join(dir, "1-1.zip"))).toBe(true);
    expect(existsSync(path.join(dir, "2-2.zip"))).toBe(false);
    expect(existsSync(path.join(dir, "3-3.zip"))).toBe(false);
  });
});
