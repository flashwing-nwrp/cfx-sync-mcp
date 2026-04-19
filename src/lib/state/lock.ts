import fs from "node:fs/promises";
import path from "node:path";
import { LockHeldError } from "../errors.js";

interface LockFile { pid: number; acquiredAt: string }

// Bound on claim-release retry spin. In practice the loop terminates in 1-2
// iterations: either we create via `wx` on the first try, or we observe an
// existing holder and decide (live→throw, stale→unlink+retry). The cap
// protects against pathological environments where some other agent is
// constantly (re-)creating the lockfile in between our unlink and our wx.
const MAX_ATTEMPTS = 10;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ESRCH") return false;
    if (err.code === "EPERM") return true; // exists but owned by another user
    return false;
  }
}

export class StateLock {
  private file: string;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, "state.lock");
  }

  async acquire(force = false): Promise<void> {
    const payload: LockFile = { pid: process.pid, acquiredAt: new Date().toISOString() };
    const json = JSON.stringify(payload);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // Fast path: O_EXCL | O_CREAT — atomic create-only at the fs-syscall
      // level. Only one concurrent caller (process OR intra-process coroutine)
      // can win; losers get EEXIST and fall through to the holder-inspection
      // path below. This is what closes the TOCTOU race that plain
      // readFile → check → writeFile had.
      try {
        const handle = await fs.open(this.file, "wx", 0o600);
        try {
          await handle.writeFile(json);
        } finally {
          await handle.close();
        }
        return; // acquired
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "EEXIST") throw err;
        // File exists — inspect the holder to decide whether to take over.
      }

      // Read current holder.
      let prior: LockFile;
      try {
        const raw = await fs.readFile(this.file, "utf8");
        prior = JSON.parse(raw) as LockFile;
      } catch (readErr) {
        const err = readErr as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          // Holder released between our wx-fail and our read. Retry wx.
          continue;
        }
        // Parse failed or other read error — treat as corrupt lockfile.
        // Log + overwrite (pid=-1 forces the stale/corrupt takeover path).
        process.stderr.write(
          `[cfx-sync][warn] Corrupt lockfile at ${this.file} — overwriting.\n`
        );
        prior = { pid: -1, acquiredAt: "" };
      }

      if (!force && prior.pid > 0 && isPidAlive(prior.pid)) {
        throw new LockHeldError(prior.pid);
      }

      // Stale, corrupt, or force=true: unlink and loop. Next iteration's wx
      // will succeed, OR we'll lose a race to another claimant (and resolve
      // via isPidAlive on the next pass).
      try {
        await fs.unlink(this.file);
      } catch (unlinkErr) {
        const err = unlinkErr as NodeJS.ErrnoException;
        // ENOENT = someone else already unlinked; that's fine.
        if (err.code !== "ENOENT") throw err;
      }
    }

    // Degenerate: we spun MAX_ATTEMPTS times and never won. Surface as
    // LockHeldError with null pid — the holder is effectively unknown since
    // it's churning.
    throw new LockHeldError(null);
  }

  async release(): Promise<void> {
    try { await fs.unlink(this.file); } catch { /* ignore */ }
  }
}
