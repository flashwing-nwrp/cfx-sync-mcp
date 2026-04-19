import fsP from "node:fs/promises";
import path from "node:path";
import { hashTree } from "../preservation/hashTree.js";
import type { AssetState } from "../state/state.js";

export type IntegrityStatus = "ok" | "corrupted" | "mid-rotation";

const NUMERIC_DIR_NAME = /^\d+$/;

/**
 * Scan `pristineDir` for `<grantId>/` subdirs whose numeric grantId is NOT in
 * `mappedGrantIds`. Transient rotation artifacts (`.tmp.*`, `.old.*`) are
 * skipped — those are handled by `rotatePristine` self-heal + caller-invoked
 * `resumeOrRollbackRotation`, not GC.
 *
 * Non-numeric directory names (e.g. `README`, `notes`) are ignored — only
 * purely-numeric subdirs are treated as pristine snapshots.
 *
 * If `pristineDir` doesn't exist, returns `[]` (nothing to GC).
 */
export async function detectOrphans(
  mappedGrantIds: number[],
  pristineDir: string
): Promise<number[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsP.readdir(pristineDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw e;
  }

  const mapped = new Set(mappedGrantIds);
  const orphans: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    // Skip transient dirs — those are rotation artifacts, not orphans.
    if (name.includes(".tmp.") || name.includes(".old.")) continue;
    // Only consider purely-numeric names (valid grantId dirs).
    if (!NUMERIC_DIR_NAME.test(name)) continue;
    const id = Number(name);
    if (!Number.isInteger(id)) continue;
    if (!mapped.has(id)) orphans.push(id);
  }
  // Deterministic ordering (ascending) so callers see a stable list.
  orphans.sort((a, b) => a - b);
  return orphans;
}

/**
 * Classify the on-disk pristine snapshot for `grantId` against the state entry.
 *
 * - `"mid-rotation"`: A `<grantId>.tmp.*` or `<grantId>.old.*` dir exists —
 *   rotation was interrupted. Caller should invoke `resumeOrRollbackRotation`
 *   before relying on the snapshot.
 * - `"corrupted"`: `<grantId>/` exists but `hashTree` doesn't match
 *   `stateEntry.pristineHashes` (keys or values differ), OR the dir is missing
 *   while state expects hashes.
 * - `"ok"`: either the dir-and-hashes agree, or BOTH the dir is missing AND
 *   `stateEntry.pristineHashes` is `null` (no baseline captured yet).
 *
 * Byte-by-byte verification — reads every file under `<grantId>/` through
 * `hashTree` and compares to recorded hashes. This is the honest check the
 * diff engine needs; a structural-only match (same keys) could miss content
 * drift from manual tampering or FS corruption.
 */
export async function verifyPristineIntegrity(
  pristineDir: string,
  grantId: number,
  stateEntry: AssetState
): Promise<IntegrityStatus> {
  // Check for transient rotation artifacts first — they override everything.
  const transient = await hasTransientArtifact(pristineDir, grantId);
  if (transient) return "mid-rotation";

  const dir = path.join(pristineDir, String(grantId));
  const dirExists = await pathExists(dir);

  if (!dirExists) {
    // No pristine on disk. "ok" iff state also expects nothing.
    return stateEntry.pristineHashes == null ? "ok" : "corrupted";
  }

  // Dir exists → hash it and compare.
  if (stateEntry.pristineHashes == null) {
    // Disk has data, state doesn't expect any. That's drift → corrupted.
    return "corrupted";
  }

  const onDisk = await hashTree(dir);
  const recorded = stateEntry.pristineHashes;

  if (onDisk.size !== Object.keys(recorded).length) return "corrupted";
  for (const [rel, hex] of onDisk) {
    if (recorded[rel] !== hex) return "corrupted";
  }
  // Also verify no recorded key is missing from disk (size eq + subset ⇒ eq set).
  // The size check above already guarantees that; no additional loop needed.

  return "ok";
}

async function hasTransientArtifact(
  pristineDir: string,
  grantId: number
): Promise<boolean> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fsP.readdir(pristineDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw e;
  }
  const tmpPrefix = `${grantId}.tmp.`;
  const oldPrefix = `${grantId}.old.`;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(tmpPrefix) || entry.name.startsWith(oldPrefix)) {
      return true;
    }
  }
  return false;
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
