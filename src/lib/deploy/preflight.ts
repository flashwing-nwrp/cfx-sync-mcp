import fs from "node:fs/promises";
import path from "node:path";
import { DiskSpaceLowError, PathTooLongError } from "../errors.js";
import { hashTree } from "flrp-resource-preservation";

export async function checkDiskSpace(anyPathOnFs: string, neededBytes: number): Promise<void> {
  const stat = await fs.statfs(anyPathOnFs);
  // Use bigint to avoid precision loss on huge volumes (bavail > 2^53 / bsize)
  const freeBytesBig = BigInt(stat.bavail) * BigInt(stat.bsize);
  const neededBig = BigInt(Math.ceil(neededBytes));
  if (freeBytesBig < neededBig) {
    // For the error message, clamp to MAX_SAFE_INTEGER for display
    const freeClamped = freeBytesBig > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(freeBytesBig);
    throw new DiskSpaceLowError(neededBytes, freeClamped);
  }
}

/**
 * Windows MAX_PATH default. Can be raised by opting into long-path support
 * (LongPathsEnabled registry key + app manifest). Without that, `fs.rename`
 * and `fs.writeFile` throw raw ENAMETOOLONG/EIO partway through a deploy,
 * leaving the tree in a torn state.
 */
export const WINDOWS_MAX_PATH = 260;

/**
 * Walk the staging tree and throw `PathTooLongError` if any eventual live path
 * would exceed Windows MAX_PATH. No-op on non-Windows.
 *
 * Runs AFTER unzip-to-staging and BEFORE applyPlan/deploy — fail fast with a
 * typed error so the operator sees a clean "move your state dir" hint instead
 * of a raw fs error with partial writes.
 *
 * @param stagingRoot  The unzipped staging dir (`unzip.root`).
 * @param liveTarget   The eventual live deploy target (`entry.target`).
 */
export async function checkPathLengths(
  stagingRoot: string,
  liveTarget: string
): Promise<void> {
  if (process.platform !== "win32") return;

  // hashTree walks the tree and returns forward-slash relative paths, which is
  // exactly what we need to project onto the live target.
  const tree = await hashTree(stagingRoot);
  for (const rel of tree.keys()) {
    // Convert forward-slash rel path to native separators before joining so the
    // projected path matches what fs.rename/writeFile will actually see.
    const native = rel.split("/").join(path.sep);
    const projected = path.join(liveTarget, native);
    if (projected.length > WINDOWS_MAX_PATH) {
      throw new PathTooLongError(projected, projected.length, WINDOWS_MAX_PATH);
    }
  }
}
