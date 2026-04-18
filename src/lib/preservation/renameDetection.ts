/**
 * Rename detection (Layer 2 of Phase 1.5 preservation).
 *
 * Pure helper that feeds the diff engine (Task 5). Given two
 * `Map<relPath, sha256>` trees — pristine (what we last synced) and pack (what
 * the vendor just shipped) — finds paths that moved between them by matching
 * on content hash.
 *
 * Conservative by design: ambiguous pairings are dropped, not guessed. A file
 * is a rename only when exactly one pristine path AND exactly one pack path
 * carry the same sha AND the paths differ. Anything else (multi-pristine,
 * multi-pack, or identical path) is treated as not a rename.
 *
 * O(n + m) over input sizes; no fs, no logger, no clock — safe to call in
 * tight loops and unit-test without setup.
 */

export interface RenamePair {
  oldPath: string;
  newPath: string;
}

/**
 * Detect single-pair renames between pristine and pack trees.
 *
 * @param pristineHashes Map of relPath → sha256 for the pristine (last-synced) tree.
 * @param packHashes     Map of relPath → sha256 for the incoming pack tree.
 * @returns Array of { oldPath, newPath } for unambiguous rename pairs.
 */
export function findRenames(
  pristineHashes: Map<string, string>,
  packHashes: Map<string, string>
): RenamePair[] {
  // Build reverse indexes: sha → paths[] for each side. Lazy skip empty side.
  if (pristineHashes.size === 0 || packHashes.size === 0) return [];

  const pristineBySha = groupPathsBySha(pristineHashes);
  const packBySha = groupPathsBySha(packHashes);

  const renames: RenamePair[] = [];

  // Walk the smaller side to save iterations.
  const [smaller, other] =
    pristineBySha.size <= packBySha.size
      ? [pristineBySha, packBySha]
      : [packBySha, pristineBySha];
  const smallerIsPristine = smaller === pristineBySha;

  for (const [sha, smallerPaths] of smaller) {
    const otherPaths = other.get(sha);
    if (!otherPaths) continue;

    // Ambiguous if either side has 2+ paths at this sha — can't pair reliably.
    if (smallerPaths.length !== 1 || otherPaths.length !== 1) continue;

    // Length checks above guarantee index 0 is defined; assert for TS with
    // noUncheckedIndexedAccess.
    const smallerPath = smallerPaths[0]!;
    const otherPath = otherPaths[0]!;
    const [pristinePath, packPath] = smallerIsPristine
      ? [smallerPath, otherPath]
      : [otherPath, smallerPath];

    // Identical path on both sides = file is in the same place, not a rename.
    if (pristinePath === packPath) continue;

    renames.push({ oldPath: pristinePath, newPath: packPath });
  }

  return renames;
}

function groupPathsBySha(hashes: Map<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [relPath, sha] of hashes) {
    const bucket = out.get(sha);
    if (bucket) bucket.push(relPath);
    else out.set(sha, [relPath]);
  }
  return out;
}
