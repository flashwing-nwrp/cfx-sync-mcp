import fs from "node:fs/promises";
import path from "node:path";
import { TargetParentMissingError, IoError, ValidationFailedError } from "../errors.js";

export interface DeployOpts {
  stagingRoot: string;       // path from unzipper.root
  targetPath: string;        // final resource dir
  backupDir: string;         // CFX_BACKUP_DIR/<slug>/
  slug: string;
  dryRun: boolean;
  backupRetain: number;
}

export interface DeployResult {
  deployedPath: string;
  backupPath: string | null;
  willMoveFrom?: string;
  willMoveTo?: string;
  willBackupTo?: string | null;
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function moveAtomic(src: string, dst: string): Promise<void> {
  try { await fs.rename(src, dst); } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EXDEV") {
      // cross-filesystem → copy + delete
      await copyRecursive(src, dst);
      await fs.rm(src, { recursive: true, force: true });
    } else throw new IoError(err.message);
  }
}

async function copyRecursive(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isSymbolicLink()) {
      // Defensive: staging should never contain symlinks (unzipper refuses them).
      // Encountering one here means something upstream is broken.
      throw new IoError(`Unexpected symlink in staging: ${s}`);
    }
    if (e.isDirectory()) await copyRecursive(s, d);
    else if (e.isFile()) await fs.copyFile(s, d);
  }
}

async function pruneBackups(slugDir: string, retain: number): Promise<void> {
  if (!(await pathExists(slugDir))) return;
  const entries = (await fs.readdir(slugDir)).sort(); // ISO timestamps sort lexicographically
  while (entries.length > retain) {
    const oldest = entries.shift();
    if (!oldest) break;
    await fs.rm(path.join(slugDir, oldest), { recursive: true, force: true });
  }
}

export async function deploy(opts: DeployOpts): Promise<DeployResult> {
  const { stagingRoot, targetPath, backupDir, slug, dryRun, backupRetain } = opts;

  if (!(await pathExists(path.join(stagingRoot, "fxmanifest.lua")))) {
    throw new ValidationFailedError(`Staging has no fxmanifest.lua at root: ${stagingRoot}`);
  }

  // Pre-swap parent validation (B4)
  const parent = path.dirname(targetPath);
  if (!(await pathExists(parent))) {
    throw new TargetParentMissingError(parent);
  }

  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const slugBackupDir = path.join(backupDir, slug);
  const backupPath = path.join(slugBackupDir, iso);

  const destinationExists = await pathExists(targetPath);

  if (dryRun) {
    return {
      deployedPath: targetPath,
      backupPath: destinationExists ? backupPath : null,
      willMoveFrom: stagingRoot,
      willMoveTo: targetPath,
      willBackupTo: destinationExists ? backupPath : null,
    };
  }

  await fs.mkdir(slugBackupDir, { recursive: true });
  // Prune to retain-1 so the new backup still fits under the limit
  await pruneBackups(slugBackupDir, Math.max(0, backupRetain - 1));

  if (destinationExists) {
    await moveAtomic(targetPath, backupPath);
  }
  await moveAtomic(stagingRoot, targetPath);

  return {
    deployedPath: targetPath,
    backupPath: destinationExists ? backupPath : null,
  };
}
