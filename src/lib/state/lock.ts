import fs from "node:fs/promises";
import path from "node:path";
import { LockHeldError } from "../errors.js";

interface LockFile { pid: number; acquiredAt: string }

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
    try {
      const raw = await fs.readFile(this.file, "utf8");
      let prior: LockFile;
      try {
        prior = JSON.parse(raw) as LockFile;
      } catch {
        // Partial write or malformed lockfile — log and take over.
        // This IS a valid recovery path: after a crash, the lockfile may
        // contain junk. But it's also the tell for a concurrent-write race
        // between two acquires — atomic tmp+rename below prevents this
        // from happening in practice going forward.
        process.stderr.write(
          `[cfx-sync][warn] Corrupt lockfile at ${this.file} — overwriting.\n`
        );
        prior = { pid: -1, acquiredAt: "" };
      }
      if (!force && prior.pid > 0 && isPidAlive(prior.pid)) {
        throw new LockHeldError(prior.pid);
      }
      // stale or corrupt — proceed to overwrite
    } catch (e) {
      if (e instanceof LockHeldError) throw e;
      // ENOENT — file absent; acquire fresh
    }
    // Atomic write: tmp + rename. This prevents a concurrent reader from
    // observing a partial JSON payload (which would mis-trip the corrupt
    // fallback and grant two concurrent acquires both the lock).
    const payload: LockFile = { pid: process.pid, acquiredAt: new Date().toISOString() };
    const tmp = this.file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(payload), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  async release(): Promise<void> {
    try { await fs.unlink(this.file); } catch { /* ignore */ }
  }
}
