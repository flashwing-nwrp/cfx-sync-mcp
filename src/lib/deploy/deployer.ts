import fs from "node:fs/promises";
import path from "node:path";
import { TargetParentMissingError, IoError, ValidationFailedError } from "../errors.js";
import { writeInFlightMarker, clearInFlightMarker } from "./inFlight.js";

/**
 * Pristine snapshot parameters threaded through a deploy. When supplied, the
 * deploy will also snapshot the CURRENT pristine (the one about to be replaced
 * by the next rotation) into `pristine-history/<grantId>/<versionId>/` and
 * record it in the backup manifest so rollback can restore it atomically
 * alongside the resource.
 *
 * All three must be present to enable pristine snapshotting; any missing
 * field disables it (first-deploy with no prior pristine is the main case).
 */
export interface PristineSnapshotOpts {
  /** Grant id the pristine belongs to. */
  grantId: number;
  /**
   * The CURRENT pristineVersionId (the version about to be replaced). Written
   * into the backup manifest as `pristineVersionIdAtBackupTime`. Null → state
   * has no pristine yet → skip snapshot.
   */
  currentPristineVersionId: number | null;
  /**
   * Path to `state/pristine/` (the root pristine dir). The source dir for the
   * snapshot is `<pristineDir>/<grantId>/`.
   */
  pristineDir: string;
  /** Path to `state/pristine-history/`. Snapshot goes under `<grantId>/<versionId>/`. */
  pristineHistoryDir: string;
  /**
   * Snapshot of current `pristineHashes` captured at backup time. Stored in
   * the manifest so rollback can restore state.pristineHashes without
   * re-hashing the pristine dir. Null → state has no pristine yet.
   */
  currentPristineHashes: Record<string, string> | null;
  /**
   * Snapshot of current `pristineCapturedAt` captured at backup time. Stored
   * in the manifest so rollback can restore state.pristineCapturedAt. Null →
   * state has no pristine yet.
   */
  currentPristineCapturedAt: string | null;
}

export interface DeployOpts {
  stagingRoot: string;       // path from unzipper.root
  targetPath: string;        // final resource dir
  backupDir: string;         // CFX_BACKUP_DIR/<slug>/
  slug: string;
  dryRun: boolean;
  backupRetain: number;
  /** Optional — enables pristine snapshotting into pristine-history. */
  pristine?: PristineSnapshotOpts;
  /**
   * Optional — enables the in-flight deploy marker. When both `stateDir` and
   * `grantId` are provided, deploy() writes `<stateDir>/in-flight/<grantId>.json`
   * immediately before the first filesystem mutation (live→backup rename, or
   * staging→live for first-deploy) and deletes it after the final
   * staging→live rename succeeds. A surviving marker on the next deploy entry
   * is the signal that the prior run was killed mid-swap.
   *
   * Both fields must be present; absence of either disables marker writes
   * (used in tests that want deploy-in-isolation semantics).
   */
  stateDir?: string;
  grantId?: number;
}

export interface DeployResult {
  deployedPath: string;
  /** Path to the backup root dir (`<slug>/<iso>/`) — caller-visible. Backed-up resource lives at `<backupPath>/resource/`. */
  backupPath: string | null;
  /** Path to the pristine snapshot under pristine-history, if one was captured. */
  pristineSnapshotPath: string | null;
  willMoveFrom?: string;
  willMoveTo?: string;
  willBackupTo?: string | null;
}

/**
 * Format of the `manifest.json` written inside each backup's root dir.
 *
 * On rollback we read this to (a) find the resource payload, and (b) restore
 * pristine to the version that matched at backup time. Storing hashes in the
 * manifest (vs. re-hashing after restore) keeps rollback cheap and avoids a
 * hashTree call that would otherwise be needed solely to populate
 * state.pristineHashes.
 */
export interface BackupManifest {
  slug: string;
  grantId: number | null;
  backedUpAt: string;
  /** The pristineVersionId that was current when this backup was created. Null = no pristine baseline yet. */
  pristineVersionIdAtBackupTime: number | null;
  /**
   * Path (absolute) to the snapshotted pristine dir under pristine-history.
   * Null when no prior pristine existed (first deploy).
   */
  pristineSnapshotPath: string | null;
  /**
   * Pristine hashes captured at backup time — used by rollback to restore
   * state.pristineHashes without re-hashing.
   */
  pristineHashesAtBackupTime: Record<string, string> | null;
  /** Pristine captured-at ISO captured at backup time. */
  pristineCapturedAtAtBackupTime: string | null;
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

/**
 * Prune backup dirs down to `retain`, deleting the matching pristine-history
 * snapshots for each pruned backup (GC pairing — spec).
 *
 * Reads each pruned backup's `manifest.json` to find `pristineSnapshotPath`
 * and deletes it too. If the manifest is unreadable (legacy backup dir from
 * a pre-Task-9 install) we skip the history step silently — the worst case
 * is a pristine-history turd that detectOrphans will eventually sweep.
 */
async function pruneBackups(slugDir: string, retain: number): Promise<void> {
  if (!(await pathExists(slugDir))) return;
  const entries = (await fs.readdir(slugDir)).sort(); // ISO timestamps sort lexicographically
  while (entries.length > retain) {
    const oldest = entries.shift();
    if (!oldest) break;
    const bkPath = path.join(slugDir, oldest);

    // Read the manifest (if any) to also prune its pristine-history snapshot.
    try {
      const manRaw = await fs.readFile(path.join(bkPath, "manifest.json"), "utf8");
      const man = JSON.parse(manRaw) as Partial<BackupManifest>;
      if (typeof man.pristineSnapshotPath === "string" && man.pristineSnapshotPath.length > 0) {
        await fs.rm(man.pristineSnapshotPath, { recursive: true, force: true }).catch(() => {
          // Intentionally silent — pristine-history dir may already be gone
          // (concurrent reset, manual cleanup). detectOrphans will sweep later.
        });
      }
    } catch {
      // Manifest missing or unparseable → legacy/corrupt backup. Skip history
      // cleanup; proceed with backup dir removal.
    }

    await fs.rm(bkPath, { recursive: true, force: true });
  }
}

export async function deploy(opts: DeployOpts): Promise<DeployResult> {
  const { stagingRoot, targetPath, backupDir, slug, dryRun, backupRetain, pristine, stateDir, grantId } = opts;

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
  // The backup "root" dir — contains manifest.json + resource/ subdir.
  const backupPath = path.join(slugBackupDir, iso);
  // The actual backed-up resource content lives here. Wrapping it lets the
  // manifest live as a sibling inside the same ISO dir.
  const backupResourcePath = path.join(backupPath, "resource");

  const destinationExists = await pathExists(targetPath);

  if (dryRun) {
    return {
      deployedPath: targetPath,
      backupPath: destinationExists ? backupPath : null,
      pristineSnapshotPath: null,
      willMoveFrom: stagingRoot,
      willMoveTo: targetPath,
      willBackupTo: destinationExists ? backupPath : null,
    };
  }

  await fs.mkdir(slugBackupDir, { recursive: true });
  // Prune to retain-1 so the new backup still fits under the limit
  await pruneBackups(slugBackupDir, Math.max(0, backupRetain - 1));

  // In-flight marker: write IMMEDIATELY before the first mutation so a crash
  // anywhere in the swap window leaves the marker on disk. Cleared after the
  // final staging→live rename. `stateDir` + `grantId` must both be supplied;
  // otherwise marker writes are disabled (test-only path — production calls
  // from deploy_asset.ts always supply them).
  const markerEnabled = stateDir !== undefined && grantId !== undefined;
  if (markerEnabled) {
    await writeInFlightMarker(stateDir!, {
      grantId: grantId!,
      stagingPath: stagingRoot,
      backupPath: destinationExists ? backupPath : null,
      startedAt: new Date().toISOString(),
    });
  }

  let pristineSnapshotPath: string | null = null;

  if (destinationExists) {
    // Create the backup root dir, then move the resource into `resource/`.
    await fs.mkdir(backupPath, { recursive: true });
    await moveAtomic(targetPath, backupResourcePath);

    // If pristine snapshotting is enabled AND there's a prior pristine to
    // capture, copy it into pristine-history BEFORE writing the manifest.
    // Copy (not move) so the current pristine stays intact for the caller's
    // subsequent rotatePristine() call.
    if (pristine && pristine.currentPristineVersionId !== null) {
      const src = path.join(pristine.pristineDir, String(pristine.grantId));
      // Only snapshot if the source actually exists. If state says there's a
      // pristine but the dir is gone, skip silently (caller's integrity check
      // will catch the corruption separately).
      if (await pathExists(src)) {
        const dst = path.join(
          pristine.pristineHistoryDir,
          String(pristine.grantId),
          String(pristine.currentPristineVersionId)
        );
        await fs.mkdir(path.dirname(dst), { recursive: true });
        // If a snapshot for this (grantId, versionId) already exists (e.g. a
        // prior aborted deploy or duplicate rotate-to-same-version), wipe it
        // before copy. cp with force: true overwrites files but doesn't
        // remove files that disappeared from source, so an explicit rm keeps
        // the snapshot bit-exact.
        await fs.rm(dst, { recursive: true, force: true });
        await fs.cp(src, dst, {
          recursive: true,
          errorOnExist: false,
          force: true,
          dereference: false,
        });
        pristineSnapshotPath = dst;
      }
    }

    // Write the manifest AFTER both the resource move and the pristine
    // snapshot copy succeed. Order matters: a manifest pointing at a missing
    // snapshot path would poison rollback.
    const manifest: BackupManifest = {
      slug,
      grantId: pristine?.grantId ?? null,
      backedUpAt: new Date().toISOString(),
      pristineVersionIdAtBackupTime: pristine?.currentPristineVersionId ?? null,
      pristineSnapshotPath,
      pristineHashesAtBackupTime: pristine?.currentPristineHashes ?? null,
      pristineCapturedAtAtBackupTime: pristine?.currentPristineCapturedAt ?? null,
    };
    await fs.writeFile(
      path.join(backupPath, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600 }
    );
  }
  await moveAtomic(stagingRoot, targetPath);

  // Final rename succeeded — clear the in-flight marker. A failure to unlink
  // the marker here would be a cosmetic leak (the NEXT deploy would false-
  // positive as interrupted), so we bubble the error instead of swallowing.
  if (markerEnabled) {
    await clearInFlightMarker(stateDir!, grantId!);
  }

  return {
    deployedPath: targetPath,
    backupPath: destinationExists ? backupPath : null,
    pristineSnapshotPath,
  };
}
