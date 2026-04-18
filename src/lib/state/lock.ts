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
      const prior = JSON.parse(raw) as LockFile;
      if (!force && isPidAlive(prior.pid)) {
        throw new LockHeldError(prior.pid);
      }
      // stale — proceed to overwrite
    } catch (e) {
      if (e instanceof LockHeldError) throw e;
      // ENOENT or corrupt lockfile — treat as absent
    }
    const payload: LockFile = { pid: process.pid, acquiredAt: new Date().toISOString() };
    await fs.writeFile(this.file, JSON.stringify(payload), { mode: 0o600 });
  }

  async release(): Promise<void> {
    try { await fs.unlink(this.file); } catch { /* ignore */ }
  }
}
