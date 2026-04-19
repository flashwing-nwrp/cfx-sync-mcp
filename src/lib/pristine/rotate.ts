import fsP from "node:fs/promises";
import path from "node:path";
import { hashTree } from "../preservation/hashTree.js";
import type { AssetState } from "../state/state.js";

export interface RotatePristineOpts {
  grantId: number;
  /** Freshly extracted pack dir (source). */
  newStagingRoot: string;
  /** Prior state — has pristineVersionId, pristineHashes (maybe null on first capture). */
  stateEntry: AssetState;
  /** Root pristine dir (from config.pristineDir — usually `state/pristine`). */
  pristineDir: string;
  /** The new pack's versionId. */
  newVersionId: number;
}

export interface RotationResult {
  grantId: number;
  /** Prior pristineVersionId (may be null on first capture). */
  rotatedFrom: number | null;
  /** The new versionId — matches `newVersionId` input. */
  rotatedTo: number;
  /** relPath → sha256 hex, from hashTree of the new pristine dir. */
  newPristineHashes: Map<string, string>;
  /** ISO8601 UTC timestamp with trailing Z. */
  capturedAt: string;
}

/**
 * Atomically rotate the pristine snapshot for `grantId` to the contents of
 * `newStagingRoot`, with crash-safe trash-then-replace semantics.
 *
 * Sequence (on a disk that starts clean):
 *
 *   1. Copy `newStagingRoot` → `<pristineDir>/<grantId>.tmp.<...>` (recursive).
 *   2. If `<pristineDir>/<grantId>/` exists, rename it → `<...>/<grantId>.old.<iso>/`.
 *      (This is the "trash" step — prior pristine is preserved until step 4.)
 *   3. Rename the tmp dir → `<pristineDir>/<grantId>/` (atomic intra-FS swap).
 *   4. rm-rf the trash. Non-critical: a crash here leaves a .old turd that the
 *      next `rotatePristine` / `resumeOrRollbackRotation` will clean up.
 *
 * Crash-recovery: before starting, we invoke `resumeOrRollbackRotation` to
 * clean leftover `.tmp.*` / `.old.*` from any prior crashed run. That keeps
 * the rotate callable as a single idempotent primitive — callers don't have
 * to remember to recover first.
 *
 * Atomicity guarantees:
 *   - There is always at least one complete snapshot on disk between steps
 *     2 and 3 (either `.old` or `<grantId>`), except for the brief rename
 *     window which is atomic at the FS level.
 *   - A mid-copy failure (step 1) leaves only the tmp turd — the prior
 *     pristine is untouched. Subsequent calls clean the turd.
 *   - A crash between step 2 and step 3 leaves `<grantId>` missing but
 *     `<grantId>.old.<iso>` present; `resumeOrRollbackRotation` rolls it back.
 *   - A crash between step 3 and step 4 leaves both `<grantId>` (new) and
 *     `<grantId>.old.<iso>` (prior) present; `resumeOrRollbackRotation`
 *     completes the rotation by removing the trash.
 */
export async function rotatePristine(
  opts: RotatePristineOpts
): Promise<RotationResult> {
  const { grantId, newStagingRoot, stateEntry, pristineDir, newVersionId } = opts;

  await fsP.mkdir(pristineDir, { recursive: true });

  // Self-heal from any prior crashed rotate before starting. This makes
  // rotatePristine safe to call even after an unclean shutdown.
  await resumeOrRollbackRotation(grantId, pristineDir);

  const finalDir = path.join(pristineDir, String(grantId));
  const tmpName = tmpDirName(grantId);
  const tmpDir = path.join(pristineDir, tmpName);
  const trashName = trashDirName(grantId);
  const trashDir = path.join(pristineDir, trashName);

  let trashCreated = false;

  try {
    // 1. Copy staging → tmp. Node 20+ native recursive cp. `dereference: false`
    //    matches hashTree's symlink policy (skip) — defense-in-depth; staging
    //    is produced by our unzipper which rejects symlinks.
    await fsP.cp(newStagingRoot, tmpDir, {
      recursive: true,
      errorOnExist: false,
      force: true,
      dereference: false,
    });

    // 2. Move prior pristine to trash, if it exists. On first rotate this is
    //    a no-op (ENOENT → swallow).
    const hadPrior = await pathExists(finalDir);
    if (hadPrior) {
      await fsP.rename(finalDir, trashDir);
      trashCreated = true;
    }

    // 3. Swap tmp → final. Atomic intra-FS rename.
    await fsP.rename(tmpDir, finalDir);
  } catch (err) {
    // Best-effort cleanup. If we created the trash but failed before the
    // final rename, roll the trash BACK to <grantId>/ so the prior pristine
    // survives.
    try {
      await fsP.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // intentionally ignored
    }
    if (trashCreated) {
      try {
        // Only roll back if final is missing/empty — if somehow both exist,
        // prefer final (the new one) and drop trash.
        const finalOk = await pathHasEntries(finalDir);
        if (!finalOk) {
          await fsP.rm(finalDir, { recursive: true, force: true }).catch(() => {});
          await fsP.rename(trashDir, finalDir);
        } else {
          await fsP.rm(trashDir, { recursive: true, force: true }).catch(() => {});
        }
      } catch {
        // Intentionally ignored — surface the original `err` to caller.
      }
    }
    throw err;
  }

  // 4. Delete trash last. Non-critical: if this fails, next rotate cleans it.
  if (trashCreated) {
    await fsP.rm(trashDir, { recursive: true, force: true }).catch(() => {
      // Intentionally ignored — .old turd will be swept by next rotate.
    });
  }

  const hashes = await hashTree(finalDir);

  return {
    grantId,
    rotatedFrom: stateEntry.pristineVersionId,
    rotatedTo: newVersionId,
    newPristineHashes: hashes,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Recover from an interrupted `rotatePristine` run for `grantId`.
 *
 * Scans `pristineDir` for `<grantId>.tmp.*` and `<grantId>.old.*` artifacts
 * and reconciles against the state of `<grantId>/`:
 *
 *   - Trash (`.old.*`) present + `<grantId>/` complete (non-empty)
 *     → rotation finished step 3 but crashed before step 4. Delete the trash.
 *     Outcome: `"resumed"`.
 *   - Trash present + `<grantId>/` missing or empty
 *     → rotation crashed between step 2 and step 3. Move trash back into
 *     place. Caller should re-run `rotatePristine`.
 *     Outcome: `"rolled-back"`.
 *   - No trash (just a `.tmp.*` turd from a mid-copy crash, or nothing)
 *     → clean up the turd; nothing to roll back.
 *     Outcome: `"resumed"`.
 *
 * If multiple `.old.*` dirs exist for the same grantId (shouldn't happen under
 * normal operation — indicates two crashes back-to-back), the newest one (by
 * name — they carry an ISO8601 timestamp) is chosen as "the trash"; older
 * ones are deleted.
 */
export async function resumeOrRollbackRotation(
  grantId: number,
  pristineDir: string
): Promise<"resumed" | "rolled-back"> {
  const exists = await pathExists(pristineDir);
  if (!exists) return "resumed";

  const entries = await fsP.readdir(pristineDir, { withFileTypes: true });
  const tmpPrefix = `${grantId}.tmp.`;
  const oldPrefix = `${grantId}.old.`;

  const tmps: string[] = [];
  const olds: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(tmpPrefix)) tmps.push(entry.name);
    else if (entry.name.startsWith(oldPrefix)) olds.push(entry.name);
  }

  // Always nuke .tmp.* — those are mid-copy turds, never a recovery source.
  for (const name of tmps) {
    await fsP.rm(path.join(pristineDir, name), { recursive: true, force: true }).catch(() => {});
  }

  if (olds.length === 0) {
    return "resumed"; // nothing to reconcile
  }

  // Pick the newest .old.<iso> as the recovery source.
  olds.sort(); // ISO8601 sorts lexicographically by time
  const newestOld = olds[olds.length - 1]!;
  const trashDir = path.join(pristineDir, newestOld);
  // Drop any older trash siblings — they're from even earlier crashes.
  for (const name of olds.slice(0, -1)) {
    await fsP.rm(path.join(pristineDir, name), { recursive: true, force: true }).catch(() => {});
  }

  const finalDir = path.join(pristineDir, String(grantId));
  const finalOk = await pathHasEntries(finalDir);

  if (finalOk) {
    // New pristine is in place — rotation finished. Delete trash.
    await fsP.rm(trashDir, { recursive: true, force: true }).catch(() => {});
    return "resumed";
  }

  // New pristine missing/empty — roll back to trash.
  await fsP.rm(finalDir, { recursive: true, force: true }).catch(() => {});
  await fsP.rename(trashDir, finalDir);
  return "rolled-back";
}

function tmpDirName(grantId: number): string {
  return `${grantId}.tmp.${process.pid}.${Date.now()}.${Math.floor(
    Math.random() * 1e9
  )}`;
}

function trashDirName(grantId: number): string {
  // ISO with colons/dots stripped — Windows rejects colons in filenames.
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  return `${grantId}.old.${iso}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsP.stat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw e;
  }
}

/**
 * True iff `p` exists and is a non-empty directory. Used to tell a
 * "rotation finished" final dir from a "crashed mid-rename" empty shell.
 */
async function pathHasEntries(p: string): Promise<boolean> {
  try {
    const entries = await fsP.readdir(p);
    return entries.length > 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw e;
  }
}
