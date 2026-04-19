import fs from "node:fs/promises";
import path from "node:path";
import { NotFoundError, IoError } from "../errors.js";
import type { BackupManifest } from "./deployer.js";

export interface RollbackOpts {
  targetPath: string;
  backupDir: string; // CFX_BACKUP_DIR/<slug>/
  slug: string;
  toTimestamp?: string; // ISO or `<iso with -replaced>` as on-disk
  /**
   * Optional — grantId + pristineDir enables pristine rotation on rollback.
   * When supplied, after restoring the resource we'll also rotate
   * `<pristineDir>/<grantId>/` back to the snapshot recorded in the backup
   * manifest. Omit to skip pristine rotation (e.g. first-time rollback with
   * no prior pristine, or legacy backup with no manifest).
   */
  grantId?: number;
  /** Root pristine dir (usually `state/pristine`). Required iff `grantId` is set. */
  pristineDir?: string;
}

export interface RollbackResult {
  restoredPath: string;
  /** Backup name that was restored (the ISO dir under `<backupDir>/<slug>/`). */
  fromBackup: string;
  /** Where the pre-rollback "current" content was moved for safekeeping. */
  newRollingBackup: string;
  /**
   * Restored pristine state — populated when `grantId` + `pristineDir` were
   * passed AND the backup manifest carried pristine info. Null means rollback
   * did not touch pristine (callers should not update state.pristine*).
   */
  restoredPristine: {
    pristineVersionId: number;
    pristineCapturedAt: string;
    pristineHashes: Record<string, string>;
  } | null;
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

/**
 * Rotate the pristine dir back to a history snapshot. Uses the same
 * trash-then-replace discipline as `rotatePristine` so a crash mid-rollback
 * leaves a recoverable state — but since we don't need atomicity at the
 * rotate-crash-resume level here (rollback is a one-shot human-initiated op),
 * we use a simpler "rm current; cp snapshot → current" sequence.
 *
 * The snapshot under pristine-history is left in place (not moved) so if the
 * operator runs rollback twice to the same backup, both succeed.
 */
async function restorePristineFromSnapshot(
  snapshotPath: string,
  pristineDir: string,
  grantId: number
): Promise<void> {
  const finalDir = path.join(pristineDir, String(grantId));
  // rm the current pristine first. If it doesn't exist, force: true suppresses.
  await fs.rm(finalDir, { recursive: true, force: true });
  await fs.mkdir(pristineDir, { recursive: true });
  await fs.cp(snapshotPath, finalDir, {
    recursive: true,
    errorOnExist: false,
    force: true,
    dereference: false,
  });
}

/**
 * Heuristic: is `backupPath` the new `<iso>/{resource/,manifest.json}` layout,
 * or the legacy `<iso>/` = raw resource layout? Checks for presence of a
 * `manifest.json` at the top level — only the new layout has it.
 */
async function isNewLayout(backupPath: string): Promise<boolean> {
  try {
    await fs.stat(path.join(backupPath, "manifest.json"));
    return true;
  } catch { return false; }
}

export async function rollback(opts: RollbackOpts): Promise<RollbackResult> {
  const { targetPath, backupDir, slug, toTimestamp, grantId, pristineDir } = opts;
  const slugBackups = path.join(backupDir, slug);
  if (!(await pathExists(slugBackups))) {
    throw new NotFoundError(`No backups exist for slug "${slug}".`);
  }
  const entries = (await fs.readdir(slugBackups))
    // Filter out -rollback rolling-backup dirs — those shouldn't be rollback
    // targets themselves (picking one would restore the pre-rollback state).
    .filter((e) => !e.endsWith("-rollback"))
    .sort()
    .reverse(); // newest first
  if (entries.length === 0) throw new NotFoundError(`No backups exist for slug "${slug}".`);

  const chosen = toTimestamp
    ? entries.find((e) => e === toTimestamp) ?? null
    : entries[0];
  if (!chosen) throw new NotFoundError(`No backup matching "${toTimestamp}"`);

  const backupPath = path.join(slugBackups, chosen);
  const rollingIso = new Date().toISOString().replace(/[:.]/g, "-") + "-rollback";
  const rolling = path.join(slugBackups, rollingIso);

  // Detect backup layout + read manifest if new-style.
  const newLayout = await isNewLayout(backupPath);
  let manifest: BackupManifest | null = null;
  if (newLayout) {
    try {
      const raw = await fs.readFile(path.join(backupPath, "manifest.json"), "utf8");
      manifest = JSON.parse(raw) as BackupManifest;
    } catch (e) {
      throw new IoError(`Backup manifest unreadable at ${backupPath}: ${(e as Error).message}`);
    }
  }

  // Source of the backed-up resource content. New layout: `<iso>/resource/`.
  // Legacy layout: `<iso>/` itself was the resource.
  const backupResourceSrc = newLayout ? path.join(backupPath, "resource") : backupPath;

  if (await pathExists(targetPath)) {
    await moveAtomic(targetPath, rolling);
  }
  await moveAtomic(backupResourceSrc, targetPath);

  // In the new layout we need to clean up the now-empty `<iso>/` shell
  // (which still has manifest.json inside). Leave the manifest as a breadcrumb
  // of "this backup was consumed at ..." ? No — clean it up; the rolling
  // backup IS the breadcrumb.
  if (newLayout) {
    await fs.rm(backupPath, { recursive: true, force: true }).catch(() => {
      // Non-critical — residual files here are cosmetic.
    });
  }

  // Pristine rotation: only if caller opted in AND manifest has snapshot info.
  let restoredPristine: RollbackResult["restoredPristine"] = null;
  if (grantId !== undefined && pristineDir !== undefined && manifest) {
    const snapPath = manifest.pristineSnapshotPath;
    const snapVersion = manifest.pristineVersionIdAtBackupTime;
    const snapHashes = manifest.pristineHashesAtBackupTime;
    const snapCapturedAt = manifest.pristineCapturedAtAtBackupTime;

    if (
      snapPath !== null && snapPath !== undefined &&
      snapVersion !== null &&
      snapHashes !== null && snapHashes !== undefined &&
      snapCapturedAt !== null && snapCapturedAt !== undefined
    ) {
      if (!(await pathExists(snapPath))) {
        throw new IoError(
          `Backup manifest references pristine snapshot that no longer exists: ${snapPath}. Pristine-history may have been pruned.`
        );
      }
      await restorePristineFromSnapshot(snapPath, pristineDir, grantId);
      restoredPristine = {
        pristineVersionId: snapVersion,
        pristineCapturedAt: snapCapturedAt,
        pristineHashes: snapHashes,
      };
    }
    // If snapshot fields are null, the backup predates the pristine system →
    // leave current pristine (if any) alone. Caller can detect
    // restoredPristine === null and decide whether that's a concern.
  }

  return { restoredPath: targetPath, fromBackup: chosen, newRollingBackup: rolling, restoredPristine };
}
