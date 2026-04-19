/**
 * Diff engine — Layer 2 of Phase 1.5 preservation.
 *
 * Pure function `computeDeployPlan` that walks pristine/live/pack hash trees
 * and emits a 10-row decision matrix per path. No filesystem access, no
 * logger, no clock — deterministic, fast, trivially unit-testable.
 *
 * The matrix (see types.ts `DiffDecision` for the short names):
 *
 *   #  live vs pristine         newPack vs pristine          rename?  case?  decision
 *   1  unchanged                unchanged (same path)        no       no     take-newPack  (no-op)
 *   2  unchanged                changed   (same path)        no       no     take-newPack
 *   3  changed (user-modified)  unchanged (same path)        no       no     preserve-live
 *   4  changed                  changed   (same path)        no       no     conflict
 *   5  live-only (orphan)       n/a                          no       no     preserve-live
 *   6  n/a                      pristine-only (removed)      no       n/a    drop
 *   7  unchanged at old path    rename detected              yes      no     take-newPack-rename
 *   8  changed at old path      rename detected              yes      no     conflict (6 opts)
 *   9  any                      any                          no       yes    blocker CASE_COLLISION_DETECTED
 *  10  sha(live) != sha(pristine) on encrypted path          n/a      n/a    blocker ENCRYPTED_TAMPER_DETECTED
 *
 * Row 9 and row 10 short-circuit into blocker entries — they do NOT replace
 * other rows, they are emitted alongside so the caller can see the full
 * picture. Row 10 only requires live+pristine to disagree on an encrypted
 * path; a new encrypted file from the pack is NOT a tamper (it's just a
 * take-newPack row).
 *
 * Complexity: O(N) where N = |pristineHashes| + |liveHashes| + |packHashes|.
 * 10k entries each side comfortably under 200ms on Node 20.
 */

import type { CollisionGroup } from "./caseDetection.js";
import type {
  ComputeDeployPlanInput,
  DeployPlan,
  PlanRow,
  ResolutionChoice,
  BlockerCode,
} from "./types.js";

/** Row 4 conflict resolution options (same-path modify/modify). */
const ROW_4_OPTIONS: ResolutionChoice[] = [
  "take-live",
  "take-pack",
  "merge-diff3",
  "staged-for-merge",
];

/** Row 8 conflict resolution options (rename + user modified at old path). */
const ROW_8_OPTIONS: ResolutionChoice[] = [
  "take-live",
  "take-pack",
  "merge-diff3",
  "staged-for-merge",
  "take-live-at-new-path",
  "take-live-at-old-path",
];

/**
 * Encrypted-path detector. Matches:
 *   - anything ending in `.fxap` (FiveM escrow asset pack), case-insensitive
 *   - anything under an `encrypted/` directory at any depth, case-insensitive
 */
const ENCRYPTED_PATH_RE = /\.fxap$|(^|\/)encrypted\//i;

export function isEncryptedPath(relPath: string): boolean {
  return ENCRYPTED_PATH_RE.test(relPath);
}

/**
 * Compute a deterministic deploy plan from three hash trees + rename pairs +
 * case collisions. See module doc for the full matrix.
 */
export function computeDeployPlan(input: ComputeDeployPlanInput): DeployPlan {
  const {
    pristineHashes,
    liveHashes,
    packHashes,
    renamePairs,
    caseCollisions,
    conflictResolutions = {},
    packValidationFailures = [],
  } = input;

  const rows: PlanRow[] = [];

  // -- Row 9: case collisions (short-circuit blocker rows) --------------------
  // Emit one blocker row per colliding path so Task 12 and the MCP tool layer
  // see every offender. These still land in `rows` so the caller's "one row
  // per path" assumption holds; downstream may choose to drop other rows for
  // these paths but the diff engine itself surfaces everything.
  const collisionPaths = collectCollisionPaths(caseCollisions);
  for (const p of collisionPaths) {
    rows.push(
      buildBlockerRow(p, "CASE_COLLISION_DETECTED", blockerDetailForCollision(p, caseCollisions), {
        pristineHashes,
        liveHashes,
        packHashes,
      })
    );
  }

  // Paths already claimed by rename pairs (row 7 / 8) — exclude them from the
  // per-path matrix below to avoid double-counting.
  const renameOldPaths = new Set<string>();
  const renameNewPaths = new Set<string>();
  for (const { oldPath, newPath } of renamePairs) {
    renameOldPaths.add(oldPath);
    renameNewPaths.add(newPath);
  }

  // -- Rows 7 & 8: rename handling -------------------------------------------
  for (const pair of renamePairs) {
    const { oldPath, newPath } = pair;

    // Skip renames whose paths collide on case — the blocker takes precedence.
    if (collisionPaths.has(oldPath) || collisionPaths.has(newPath)) continue;

    const pristineOldSha = pristineHashes.get(oldPath);
    const packNewSha = packHashes.get(newPath);
    const liveOldSha = liveHashes.get(oldPath);

    // Rename semantics require pristine[old] and pack[new] to share sha — the
    // detector enforces this, but guard defensively in case of caller misuse.
    if (pristineOldSha === undefined || packNewSha === undefined) continue;
    if (pristineOldSha !== packNewSha) continue;

    // Row 10 check on either old or new path — tamper trumps rename.
    if (isEncryptedPath(oldPath) || isEncryptedPath(newPath)) {
      if (liveOldSha !== undefined && liveOldSha !== pristineOldSha) {
        rows.push(
          buildBlockerRow(
            oldPath,
            "ENCRYPTED_TAMPER_DETECTED",
            `live sha ${short(liveOldSha)} != pristine sha ${short(pristineOldSha)} at encrypted path`,
            { pristineHashes, liveHashes, packHashes }
          )
        );
        continue;
      }
    }

    // Row 7: user didn't touch old path (either absent or matches pristine).
    //   - liveOldSha === undefined: the old file is already gone from live;
    //     treat as unmodified w.r.t. pristine (vendor's move is unopposed).
    //   - liveOldSha === pristineOldSha: unchanged.
    // Row 8: user modified the old path (liveOldSha differs from pristine).
    const liveUnchanged = liveOldSha === undefined || liveOldSha === pristineOldSha;
    if (liveUnchanged) {
      rows.push({
        path: newPath,
        decision: "take-newPack-rename",
        rowNumber: 7,
        rename: { oldPath, newPath },
        pristineSha: pristineOldSha,
        packSha: packNewSha,
        ...(liveOldSha !== undefined ? { liveSha: liveOldSha } : {}),
      });
    } else {
      // Row 8 conflict — 6 resolution options.
      const resolved = applyResolution(
        {
          path: newPath,
          decision: "conflict",
          rowNumber: 8,
          rename: { oldPath, newPath },
          conflictOptions: ROW_8_OPTIONS,
          pristineSha: pristineOldSha,
          packSha: packNewSha,
          liveSha: liveOldSha,
        },
        conflictResolutions[newPath]
      );
      rows.push(resolved);
    }
  }

  // -- Rows 1-6 + row 10: per-path matrix over union of all three maps -------
  const allPaths = collectAllPaths(pristineHashes, liveHashes, packHashes);

  for (const p of allPaths) {
    // Already handled above.
    if (collisionPaths.has(p)) continue;
    if (renameOldPaths.has(p) || renameNewPaths.has(p)) continue;

    const pristineSha = pristineHashes.get(p);
    const liveSha = liveHashes.get(p);
    const packSha = packHashes.get(p);

    // Row 10: encrypted tamper takes precedence over any row 1-6 decision.
    // Condition: live exists AND pristine exists AND they differ on an
    // encrypted path. A brand-new encrypted file from the pack (pristine
    // absent) is not tamper — that's row 2.
    if (
      isEncryptedPath(p) &&
      pristineSha !== undefined &&
      liveSha !== undefined &&
      liveSha !== pristineSha
    ) {
      rows.push(
        buildBlockerRow(
          p,
          "ENCRYPTED_TAMPER_DETECTED",
          `live sha ${short(liveSha)} != pristine sha ${short(pristineSha)} at encrypted path`,
          { pristineHashes, liveHashes, packHashes }
        )
      );
      continue;
    }

    rows.push(classifyRow(p, pristineSha, liveSha, packSha, conflictResolutions[p]));
  }

  // Deterministic output ordering: sort by path ASCII-ascending. Ties are
  // impossible since each path appears at most once per non-blocker branch
  // and blockers use the same path key.
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const blockers = rows.filter((r) => r.decision === "blocker");
  const conflicts = rows.filter((r) => r.decision === "conflict");

  return {
    rows,
    blockers,
    conflicts,
    packValidationFailures,
  };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Classify a single path into one of rows 1-6 given the three-way sha state.
 * Does NOT handle renames (row 7/8), case collisions (row 9), or encrypted
 * tamper (row 10) — those are filtered out by the caller.
 *
 * @param resolution Optional user resolution — when the path would otherwise
 *                   be a row-4 conflict, applies the user's choice.
 */
function classifyRow(
  path: string,
  pristineSha: string | undefined,
  liveSha: string | undefined,
  packSha: string | undefined,
  resolution: ResolutionChoice | undefined
): PlanRow {
  // Row 6: in pristine, not in live, not in pack — vendor dropped it, user
  // already doesn't have it either. Safe drop.
  if (pristineSha !== undefined && liveSha === undefined && packSha === undefined) {
    return {
      path,
      decision: "drop",
      rowNumber: 6,
      pristineSha,
    };
  }

  // Row 5: in live only (no pristine match). User-added orphan — preserve it.
  // Also covers "pack dropped it but user still has their modified copy"
  // which is morally row 5 (the file is effectively user-owned now).
  if (liveSha !== undefined && pristineSha === undefined) {
    return {
      path,
      decision: "preserve-live",
      rowNumber: 5,
      liveSha,
      ...(packSha !== undefined ? { packSha } : {}),
    };
  }

  // Net-new file from pack that user doesn't have and pristine didn't have
  // either. Matrix doesn't have an explicit row for this but it's a clean
  // take-newPack (row 2 analogue — "pack changed from nothing to something").
  if (packSha !== undefined && pristineSha === undefined && liveSha === undefined) {
    return {
      path,
      decision: "take-newPack",
      rowNumber: 2,
      packSha,
    };
  }

  // Pack drops a file user still has unchanged: live === pristine, pack absent.
  // Honor vendor's removal — row 6 style drop (but user has the file, which
  // takes-newPack semantics means "remove it"). Treat as row 2 (take-newPack)
  // with packSha undefined signalling deletion to applyPlan.
  if (
    liveSha !== undefined &&
    pristineSha !== undefined &&
    liveSha === pristineSha &&
    packSha === undefined
  ) {
    return {
      path,
      decision: "take-newPack",
      rowNumber: 2,
      liveSha,
      pristineSha,
    };
  }

  // All remaining cases have live !== undefined AND pristine !== undefined
  // AND pack !== undefined (three-way state) OR are the rare combinations
  // below. Compute the two axes.
  const liveUnchanged = liveSha !== undefined && liveSha === pristineSha;
  const packUnchanged = packSha !== undefined && packSha === pristineSha;
  const packChanged = packSha !== undefined && packSha !== pristineSha;
  const liveChanged =
    liveSha !== undefined && pristineSha !== undefined && liveSha !== pristineSha;

  // Row 1: unchanged/unchanged — no-op take-newPack.
  if (liveUnchanged && packUnchanged) {
    return {
      path,
      decision: "take-newPack",
      rowNumber: 1,
      pristineSha,
      liveSha,
      packSha,
    };
  }

  // Row 2: live unchanged, pack changed — adopt pack.
  if (liveUnchanged && packChanged) {
    return {
      path,
      decision: "take-newPack",
      rowNumber: 2,
      pristineSha,
      liveSha,
      packSha,
    };
  }

  // Row 3: live changed, pack unchanged — preserve user's edits.
  if (liveChanged && packUnchanged) {
    return {
      path,
      decision: "preserve-live",
      rowNumber: 3,
      pristineSha,
      liveSha,
      packSha,
    };
  }

  // Row 4: live changed AND pack changed (differently from each other, or the
  // same — if both changed to identical content it's still a conflict because
  // we can't prove intent).
  if (liveChanged && packChanged) {
    return applyResolution(
      {
        path,
        decision: "conflict",
        rowNumber: 4,
        conflictOptions: ROW_4_OPTIONS,
        pristineSha,
        liveSha,
        packSha,
      },
      resolution
    );
  }

  // Residual oddities (pack added while live absent but pristine has a
  // different sha — impossible given renames were filtered out; user deleted
  // a file the pack is re-adding). Treat as take-newPack: vendor re-introduces.
  if (packSha !== undefined && liveSha === undefined && pristineSha !== undefined) {
    return {
      path,
      decision: "take-newPack",
      rowNumber: 2,
      pristineSha,
      packSha,
    };
  }

  // Final fallback — should be unreachable. Emit a conservative preserve-live
  // to avoid destroying user data.
  return {
    path,
    decision: "preserve-live",
    rowNumber: 5,
    ...(pristineSha !== undefined ? { pristineSha } : {}),
    ...(liveSha !== undefined ? { liveSha } : {}),
    ...(packSha !== undefined ? { packSha } : {}),
  };
}

/**
 * Apply an optional user resolution to a conflict row:
 *   - take-live  → rewrite to preserve-live decision (no resolution attached)
 *   - take-pack  → rewrite to take-newPack decision (no resolution attached)
 *   - other 4    → keep conflict decision, attach .resolution for Task 12
 *   - undefined  → keep conflict decision untouched (caller must resolve)
 */
function applyResolution(
  row: PlanRow,
  resolution: ResolutionChoice | undefined
): PlanRow {
  if (resolution === undefined) return row;

  // Validate the resolution against the row's options. If not valid, ignore
  // (the caller supplied garbage — we surface the conflict untouched).
  if (!row.conflictOptions?.includes(resolution)) return row;

  if (resolution === "take-live") {
    return {
      ...row,
      decision: "preserve-live",
      conflictOptions: undefined,
    };
  }
  if (resolution === "take-pack") {
    return {
      ...row,
      decision: "take-newPack",
      conflictOptions: undefined,
    };
  }

  // merge-diff3, staged-for-merge, take-live-at-new-path, take-live-at-old-path
  // all stay as conflicts but carry the user's choice for applyPlan to act on.
  return {
    ...row,
    resolution,
  };
}

function buildBlockerRow(
  path: string,
  code: BlockerCode,
  detail: string,
  hashes: {
    pristineHashes: Map<string, string>;
    liveHashes: Map<string, string>;
    packHashes: Map<string, string>;
  }
): PlanRow {
  const pristineSha = hashes.pristineHashes.get(path);
  const liveSha = hashes.liveHashes.get(path);
  const packSha = hashes.packHashes.get(path);
  const rowNumber = code === "CASE_COLLISION_DETECTED" ? 9 : 10;
  return {
    path,
    decision: "blocker",
    rowNumber,
    blockerCode: code,
    blockerDetail: detail,
    ...(pristineSha !== undefined ? { pristineSha } : {}),
    ...(liveSha !== undefined ? { liveSha } : {}),
    ...(packSha !== undefined ? { packSha } : {}),
  };
}

function collectCollisionPaths(groups: CollisionGroup[]): Set<string> {
  const out = new Set<string>();
  for (const g of groups) {
    for (const p of g.paths) out.add(p);
  }
  return out;
}

function blockerDetailForCollision(
  path: string,
  groups: CollisionGroup[]
): string {
  const group = groups.find((g) => g.paths.includes(path));
  if (!group) return `case collision on ${path}`;
  const others = group.paths.filter((p) => p !== path);
  return `case collision: ${path} collides with ${others.join(", ")} (lowercased to ${group.lowerPath})`;
}

function collectAllPaths(
  pristine: Map<string, string>,
  live: Map<string, string>,
  pack: Map<string, string>
): Set<string> {
  // Union of keys. Set insertion is O(1) amortized, final size ≤ sum of inputs.
  const out = new Set<string>();
  for (const k of pristine.keys()) out.add(k);
  for (const k of live.keys()) out.add(k);
  for (const k of pack.keys()) out.add(k);
  return out;
}

function short(sha: string): string {
  return sha.slice(0, 8);
}

// Re-export helper so tests (and Task 12) can share the same encrypted-path
// predicate without importing the regex directly.
export { ENCRYPTED_PATH_RE };
