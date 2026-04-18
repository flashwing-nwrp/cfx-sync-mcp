import fs from "node:fs/promises";
import path from "node:path";
import { NotFoundError, IoError } from "../errors.js";

export interface RollbackOpts {
  targetPath: string;
  backupDir: string; // CFX_BACKUP_DIR/<slug>/
  slug: string;
  toTimestamp?: string; // ISO or `<iso with -replaced>` as on-disk
}

export interface RollbackResult {
  restoredPath: string;
  fromBackup: string;
  newRollingBackup: string; // where the "current" went before restore
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function moveAtomic(src: string, dst: string): Promise<void> {
  try { await fs.rename(src, dst); } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EXDEV") {
      throw new IoError("Cross-filesystem rollback is not supported.");
    } else throw new IoError(err.message);
  }
}

export async function rollback(opts: RollbackOpts): Promise<RollbackResult> {
  const { targetPath, backupDir, slug, toTimestamp } = opts;
  const slugBackups = path.join(backupDir, slug);
  if (!(await pathExists(slugBackups))) {
    throw new NotFoundError(`No backups exist for slug "${slug}".`);
  }
  const entries = (await fs.readdir(slugBackups)).sort().reverse(); // newest first
  if (entries.length === 0) throw new NotFoundError(`No backups exist for slug "${slug}".`);

  const chosen = toTimestamp
    ? entries.find((e) => e === toTimestamp) ?? null
    : entries[0];
  if (!chosen) throw new NotFoundError(`No backup matching "${toTimestamp}"`);

  const backupPath = path.join(slugBackups, chosen);
  const rollingIso = new Date().toISOString().replace(/[:.]/g, "-") + "-rollback";
  const rolling = path.join(slugBackups, rollingIso);

  if (await pathExists(targetPath)) {
    await moveAtomic(targetPath, rolling);
  }
  await moveAtomic(backupPath, targetPath);

  return { restoredPath: targetPath, fromBackup: chosen, newRollingBackup: rolling };
}
