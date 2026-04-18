/**
 * Case-collision detection (Layer 2 of Phase 1.5 preservation).
 *
 * Pure helper that feeds the diff engine (Task 5, row 9). Given a list of
 * relative paths (typically the union of pristine + pack + live trees), finds
 * groups of 2+ distinct paths that lowercase to the same key.
 *
 * Why this matters: case-insensitive filesystems (Windows NTFS default, APFS
 * default, ext4 with `casefold`) silently collapse `Configs/Server.lua` and
 * `configs/server.lua` into one file. A sync that honors both on a
 * case-sensitive filesystem (Linux ext4 default) but then deploys to a
 * case-insensitive one will experience nondeterministic file content. The diff
 * engine needs to flag these before we write anything.
 *
 * Forward-slash normalization is NOT done here — callers must normalize paths
 * at their source (hashTree.ts handles it for filesystem walks). This helper
 * is a pure string-groupby.
 *
 * O(n) over input size; no fs, no logger, no clock.
 */

export interface CollisionGroup {
  /** The lowercased path shared by the colliding entries (the group key). */
  lowerPath: string;
  /** The 2+ distinct original-cased paths that collide. */
  paths: string[];
}

/**
 * Detect case-insensitive path collisions among a flat list of relative paths.
 *
 * @param allPaths Forward-slash-normalized relative paths. Duplicates are
 *                 deduped (exact-duplicate strings do not count as a collision
 *                 — a collision requires 2+ DIFFERENT paths that share a
 *                 lowercase form).
 * @returns Array of CollisionGroup. Empty if no collisions found.
 */
export function detectCaseCollisions(allPaths: string[]): CollisionGroup[] {
  if (allPaths.length < 2) return [];

  // Group distinct paths by their lowercase form. Using a Set inside the map
  // dedupes exact-duplicate inputs so "foo.lua" passed twice does not look
  // like a collision with itself.
  const groups = new Map<string, Set<string>>();
  for (const p of allPaths) {
    const key = p.toLowerCase();
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = new Set<string>();
      groups.set(key, bucket);
    }
    bucket.add(p);
  }

  const out: CollisionGroup[] = [];
  for (const [lowerPath, bucket] of groups) {
    if (bucket.size < 2) continue;
    out.push({ lowerPath, paths: [...bucket] });
  }
  return out;
}
