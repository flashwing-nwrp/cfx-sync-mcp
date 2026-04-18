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
});
