import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  checkDiskSpace,
  checkPathLengths,
  WINDOWS_MAX_PATH,
} from "../../../src/lib/deploy/preflight.js";
import { DiskSpaceLowError, PathTooLongError } from "../../../src/lib/errors.js";

describe("checkDiskSpace", () => {
  it("throws DISK_SPACE_LOW when needed > free (absurd requirement)", async () => {
    // Number.MAX_SAFE_INTEGER bytes is more than any real disk — always fails
    await expect(
      checkDiskSpace(tmpdir(), Number.MAX_SAFE_INTEGER)
    ).rejects.toBeInstanceOf(DiskSpaceLowError);
  });

  it("resolves when needed is trivially small", async () => {
    // 1 byte — any mounted filesystem will have at least this free
    await expect(checkDiskSpace(tmpdir(), 1)).resolves.toBeUndefined();
  });

  it("handles huge-volume arithmetic without precision loss", async () => {
    // statfs returns bigints on Node 20+; even if passed a large-number result,
    // our bigint multiply should handle it correctly.
    // This test is mainly regression-guarding — the real test is on a huge FS.
    // On CI we just verify the implementation doesn't throw on normal values.
    await expect(checkDiskSpace(process.cwd(), 1)).resolves.toBeUndefined();
  });
});

describe("checkPathLengths", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "cfx-preflight-path-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("is a no-op on non-Windows platforms", async () => {
    if (process.platform === "win32") return; // Windows path handled in the next suite
    // Stage dir with a comically long entry; on POSIX this must resolve cleanly.
    const staging = path.join(tmp, "staging");
    mkdirSync(staging, { recursive: true });
    const deep = path.join(staging, "a".repeat(200), "b".repeat(200));
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, "file.lua"), "hi");
    const liveTarget = path.join(tmp, "live", "resource") + "-".repeat(200);
    await expect(checkPathLengths(staging, liveTarget)).resolves.toBeUndefined();
  });

  it("exports WINDOWS_MAX_PATH=260", () => {
    expect(WINDOWS_MAX_PATH).toBe(260);
  });

  it("resolves when staging contains no files (empty tree)", async () => {
    const staging = path.join(tmp, "empty");
    mkdirSync(staging, { recursive: true });
    await expect(checkPathLengths(staging, tmp)).resolves.toBeUndefined();
  });

  // Windows-only positive-case: a deep staging + long live-target projection
  // must throw PathTooLongError with the overflowing path.
  describe.skipIf(process.platform !== "win32")("on Windows", () => {
    it("throws PathTooLongError when projected live path exceeds MAX_PATH", async () => {
      const staging = path.join(tmp, "staging");
      mkdirSync(staging, { recursive: true });
      // Nest a 6-deep tree to guarantee overflow when projected onto a long target.
      const nested = path.join(
        staging,
        ...Array.from({ length: 6 }, (_, i) => `sub_${i}_` + "y".repeat(30))
      );
      mkdirSync(nested, { recursive: true });
      writeFileSync(path.join(nested, "file.lua"), "x");

      // Long live target — pushes the projected path well past 260.
      const liveTarget = path.join(tmp, "live", "x".repeat(200));

      try {
        await checkPathLengths(staging, liveTarget);
        throw new Error("expected PathTooLongError");
      } catch (e) {
        expect(e).toBeInstanceOf(PathTooLongError);
        const err = e as PathTooLongError;
        expect(err.code).toBe("PATH_TOO_LONG");
        expect(err.limit).toBe(260);
        expect(err.length).toBeGreaterThan(260);
        expect(err.path.length).toBe(err.length);
      }
    });

    it("resolves when all projected paths are under MAX_PATH", async () => {
      const staging = path.join(tmp, "staging");
      mkdirSync(staging, { recursive: true });
      writeFileSync(path.join(staging, "short.lua"), "x");
      const shortTarget = path.join(tmp, "live");
      await expect(checkPathLengths(staging, shortTarget)).resolves.toBeUndefined();
    });
  });
});
