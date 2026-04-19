import fsP from "node:fs/promises";
import path from "node:path";
import { hashTree } from "../preservation/hashTree.js";

export interface CapturePristineOpts {
  /** Source dir — the fresh-extracted pack (staging root). */
  stagingRoot: string;
  /** Grant id; used for the per-grant subdir name under `pristineDir`. */
  grantId: number;
  /** Root pristine dir (from config.pristineDir — usually `state/pristine`). */
  pristineDir: string;
  /** The pack's versionId — stored alongside the snapshot for bookkeeping. */
  versionId: number;
}

export interface PristineSnapshot {
  versionId: number;
  /** ISO8601 UTC timestamp with trailing Z. */
  capturedAt: string;
  /** relPath → sha256 hex, as produced by `hashTree()` against the final dir. */
  hashes: Map<string, string>;
}

/**
 * Snapshot a freshly-extracted pack as the "last known pristine upstream"
 * baseline for future diffs.
 *
 * Called from `cfx_deploy_asset` (Task 15) AFTER a successful swap. This lets
 * the next deploy compute: `upstream - pristine = user customizations`.
 *
 * Guarantees:
 *   - Bit-exact recursive copy of `stagingRoot` → `<pristineDir>/<grantId>/`.
 *   - Atomic: writes first to a uniquely-named tmp dir, then moves into place.
 *     A mid-copy failure leaves no partial `<grantId>/` dir and no turd tmp
 *     dirs under `pristineDir`.
 *   - Overwrites any existing `<grantId>/` dir cleanly (old content fully
 *     replaced, no leftover files).
 *   - `pristineDir` is created if missing (with parents).
 *   - `hashes` in the returned snapshot are exactly what `hashTree()` produces
 *     against the final pristine dir.
 *
 * Non-goals (deferred to Task 8 — rotation):
 *   - Resume-from-crash logic. If the process dies between the rm-rf of the old
 *     pristine and the rename of the tmp, the next deploy re-captures; there's
 *     no recovery of the pre-overwrite pristine from this function.
 */
export async function capturePristine(
  opts: CapturePristineOpts
): Promise<PristineSnapshot> {
  const { stagingRoot, grantId, pristineDir, versionId } = opts;

  // Ensure the pristine root exists so rename-into-place has a valid parent.
  await fsP.mkdir(pristineDir, { recursive: true });

  const finalDir = path.join(pristineDir, String(grantId));
  // Unique tmp name avoids collisions with concurrent captures of other
  // grantIds, crashed runs, and (defense-in-depth) a same-pid capture retry.
  const tmpName = `${grantId}.tmp.${process.pid}.${Date.now()}.${Math.floor(
    Math.random() * 1e9
  )}`;
  const tmpDir = path.join(pristineDir, tmpName);

  try {
    // 1. Recursive copy staging → tmp. Node 20+ native; errorOnExist=false so
    //    a truly fresh tmp is safe, dereference=false so we never follow
    //    symlinks (staging shouldn't contain any — unzipper refuses — but
    //    defense-in-depth matches hashTree's symlink policy).
    await fsP.cp(stagingRoot, tmpDir, {
      recursive: true,
      errorOnExist: false,
      force: true,
      dereference: false,
    });

    // 2. If a previous pristine exists for this grantId, tear it down. From
    //    this instant until the rename below, there is no pristine for this
    //    grantId; that's acceptable per Task 7 scope (Task 8 adds crash-resume).
    await fsP.rm(finalDir, { recursive: true, force: true });

    // 3. Atomic rename tmp → final. Same parent dir → same filesystem → real
    //    atomic rename on every supported OS.
    await fsP.rename(tmpDir, finalDir);
  } catch (err) {
    // Best-effort cleanup so we don't pollute pristineDir with tmp turds.
    // `force: true` suppresses ENOENT; any other error from rm is swallowed
    // intentionally — the original `err` is what the caller needs to see.
    try {
      await fsP.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // intentionally ignored
    }
    throw err;
  }

  // 4. Hash the landed pristine dir. Doing this AFTER the rename ensures the
  //    returned hashes match what any future reader of `<pristineDir>/<grantId>/`
  //    will compute — i.e., the hashes are an honest fingerprint of the on-disk
  //    state, not of a transient tmp we've since moved.
  const hashes = await hashTree(finalDir);

  return {
    versionId,
    capturedAt: new Date().toISOString(),
    hashes,
  };
}
