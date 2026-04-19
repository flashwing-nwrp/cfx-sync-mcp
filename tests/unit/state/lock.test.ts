import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { StateLock } from "../../../src/lib/state/lock.js";
import { LockHeldError } from "../../../src/lib/errors.js";

describe("StateLock", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "cfx-lock-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("acquires successfully when no lock exists", async () => {
    const l = new StateLock(dir);
    await l.acquire();
    await l.release();
  });

  it("throws LockHeldError when lockfile has live PID", async () => {
    writeFileSync(path.join(dir, "state.lock"), JSON.stringify({ pid: process.pid }));
    const l = new StateLock(dir);
    await expect(l.acquire()).rejects.toBeInstanceOf(LockHeldError);
  });

  it("takes over a stale lockfile (non-running PID)", async () => {
    // PID 999999 is almost certainly not running
    writeFileSync(path.join(dir, "state.lock"), JSON.stringify({ pid: 999999 }));
    const l = new StateLock(dir);
    await l.acquire();
    await l.release();
  });

  it("release() removes the lockfile", async () => {
    const l = new StateLock(dir);
    await l.acquire();
    await l.release();
    const fs = await import("node:fs");
    expect(fs.existsSync(path.join(dir, "state.lock"))).toBe(false);
  });

  it("force=true overrides live-PID block", async () => {
    writeFileSync(path.join(dir, "state.lock"), JSON.stringify({ pid: process.pid }));
    const l = new StateLock(dir);
    await l.acquire(true);
    await l.release();
  });

  it("treats corrupt lockfile as absent + warns", async () => {
    writeFileSync(path.join(dir, "state.lock"), "not valid json at all");
    const l = new StateLock(dir);
    await l.acquire();
    await l.release();
  });

  it("acquire is atomic (no .tmp leftover)", async () => {
    const l = new StateLock(dir);
    await l.acquire();
    const fs = await import("node:fs");
    expect(fs.existsSync(path.join(dir, "state.lock.tmp"))).toBe(false);
    await l.release();
  });

  it("two concurrent in-process acquires — exactly one wins (TOCTOU race)", async () => {
    // Regression test for gap #4: previously, the read-check-then-write flow
    // let two Promise.all'd acquires BOTH succeed because both observed the
    // (absent) lockfile before either wrote it. With O_EXCL (`wx`), the fs
    // syscall arbitrates — only one caller creates the file, the other sees
    // EEXIST and (since the holder PID is our own, always alive) throws
    // LockHeldError.
    const l1 = new StateLock(dir);
    const l2 = new StateLock(dir);
    const results = await Promise.allSettled([l1.acquire(), l2.acquire()]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      LockHeldError
    );

    // Winner releases; now the loser could re-acquire cleanly.
    await l1.release();
    await l2.release(); // idempotent no-op if l2 never acquired
  });
});
