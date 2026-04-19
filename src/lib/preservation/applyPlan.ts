/**
 * applyPlan — Phase 1.5 Task 12.
 *
 * Given a resolved {@link DeployPlan} (all conflicts have a resolution and no
 * blockers), mutate the `stagingRoot` tree so it represents the final
 * to-be-deployed state.
 *
 * Model — what's in `stagingRoot` when this function runs:
 *   The caller (cfx_deploy_asset) hands us a `stagingRoot` that contains
 *   PACK-ONLY content — the raw extract of the incoming zip, freshly unzipped.
 *   Live is NOT pre-overlaid. This function is what USES the DeployPlan to
 *   merge pack bytes with live bytes, producing the final staging tree that
 *   the deployer will then atomically swap into place.
 *
 * Per-row behavior (staging starts with pack-only content; `liveRoot` is read-only):
 *
 *   - `preserve-live`  → copy live's bytes into staging at this path. Covers
 *                        row 3 (user edit, pack unchanged) and row 5 (live-only
 *                        orphan file pack doesn't know about). User's version
 *                        wins — their edits survive the deploy.
 *   - `take-newPack`   → no-op when `packSha` is defined (staging already has
 *                        the pack's content for this path from unzip).
 *                        When `packSha` is undefined (pack DROPPED the file;
 *                        see types.ts PlanRow JSDoc), delete the path from
 *                        staging. This is the row-2 "pack dropped unchanged
 *                        file" branch — we honor vendor removal.
 *   - `take-newPack-rename` (row 7) → staging already has the pack's newPath;
 *                        nothing to do for that side. If the plan's renamed
 *                        oldPath was also shipped by pack (shouldn't happen
 *                        under rename semantics, but defensive), drop it so
 *                        both copies don't land in live.
 *   - `drop` (row 6)   → remove from staging if somehow present (usually a
 *                        no-op: if pristine dropped it and pack dropped it,
 *                        staging never had it from the unzip).
 *   - `conflict` with resolution:
 *       - `staged-for-merge` → write `.live` + `.pack` sidecars under
 *         `<conflictDir>/<grantId>/<path>.{live,pack}` and DELETE the path
 *         from staging so the final swap leaves live's version in place.
 *         The operator resolves by rewriting live and re-running deploy.
 *       - `take-live-at-new-path` (row 8) → copy live's oldPath bytes to
 *         newPath in staging (overwriting the pack's newPath content); then
 *         delete oldPath from staging.
 *       - `take-live-at-old-path` (row 8) → copy live's oldPath bytes to
 *         oldPath in staging; delete newPath from staging (reject pack's rename).
 *       - `merge-diff3` → NOT IMPLEMENTED yet. Throws with a hint pointing
 *         operators at `staged-for-merge`. Reserved so adding a proper 3-way
 *         merger later doesn't require a migration.
 *   - `blocker` → throws {@link CaseCollisionDetectedError} or
 *                 {@link EncryptedTamperDetectedError} BEFORE any mutation.
 *   - `conflict` without resolution → throws {@link ConflictsUnresolvedError}
 *     BEFORE any mutation, listing all offending paths.
 *
 * Why this shape: the plan rows are canonical — the diff engine already
 * figured out what each path needs to become. Staging being pack-only on
 * entry means `take-newPack` is the cheap default (no copy), and all the
 * live-side work (preserve-live, take-live-at-*-path) is explicit. The
 * alternative (pre-overlay live onto staging, then apply the plan) would
 * make `take-newPack` the expensive path and do unnecessary I/O for every
 * unchanged file.
 *
 * Contract: this function is "atomic at the row level" — each row's filesystem
 * transitions are applied one at a time with no rollback if a later row fails.
 * Blocker/conflict pre-checks ensure we NEVER mutate before validating the
 * whole plan, but mid-flight I/O errors (disk full, EACCES) can leave staging
 * partially transformed. Callers must treat a thrown error as "staging is
 * untrusted, rebuild it".
 *
 * All paths in `plan.rows[*].path` and `.rename.{oldPath,newPath}` are
 * forward-slash, repo-relative, no leading slash — matching `hashTree` output.
 * We use `path.join(liveRoot, ...)` which handles platform separators
 * correctly.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  ConflictsUnresolvedError,
  CaseCollisionDetectedError,
  EncryptedTamperDetectedError,
  IoError,
} from "../errors.js";
import type { DeployPlan, PlanRow } from "./types.js";

export interface ApplyPlanOpts {
  plan: DeployPlan;
  /** Absolute path to the live resource dir. Read-only. */
  liveRoot: string;
  /** Absolute path to the staging tree (will be mutated). */
  stagingRoot: string;
  /**
   * Absolute path to the conflict-sidecars root. `staged-for-merge` rows
   * write into `<conflictDir>/<grantId>/<path>.{live,pack}`.
   */
  conflictDir: string;
  /**
   * Identifier used to namespace conflict sidecars by grant. String for
   * fallback/manual paths, number for portal grant IDs.
   */
  grantId: number | string;
}

export async function applyPlan(opts: ApplyPlanOpts): Promise<void> {
  const { plan, liveRoot, stagingRoot, conflictDir, grantId } = opts;

  // ---- Step 1: short-circuit on blockers BEFORE any mutation. --------------
  for (const row of plan.rows) {
    if (row.decision !== "blocker") continue;
    if (row.blockerCode === "CASE_COLLISION_DETECTED") {
      // Prefer the structured `collision` field (set by diffEngine). Fall
      // back to a best-effort regex parse of `blockerDetail` only for
      // hand-built plans (tests, external callers) that don't populate it.
      throw new CaseCollisionDetectedError(row.path, otherCollidingPath(row));
    }
    if (row.blockerCode === "ENCRYPTED_TAMPER_DETECTED") {
      throw new EncryptedTamperDetectedError(row.path);
    }
    // Unknown blocker code — surface as IO error rather than silently skipping.
    throw new IoError(
      `applyPlan: unknown blocker code ${row.blockerCode ?? "<none>"} at ${row.path}`
    );
  }

  // ---- Step 2: short-circuit on unresolved conflicts BEFORE any mutation. --
  const unresolved = plan.rows
    .filter((r) => r.decision === "conflict" && r.resolution === undefined)
    .map((r) => r.path);
  if (unresolved.length > 0) {
    throw new ConflictsUnresolvedError(unresolved);
  }

  // ---- Step 3: apply rows. Order matters only to avoid intra-plan races on
  // the same path, but diffEngine emits each path at most once so row order
  // is immaterial. We iterate in the plan's sort order (ascending by path).
  for (const row of plan.rows) {
    await applyRow(row, liveRoot, stagingRoot, conflictDir, grantId);
  }
}

// ---------------------------------------------------------------------------
// row dispatch
// ---------------------------------------------------------------------------

async function applyRow(
  row: PlanRow,
  liveRoot: string,
  stagingRoot: string,
  conflictDir: string,
  grantId: number | string
): Promise<void> {
  switch (row.decision) {
    case "preserve-live":
      await copyLiveToStaging(row.path, liveRoot, stagingRoot);
      return;

    case "take-newPack":
      // `packSha === undefined` is the deletion signal from diffEngine
      // (see types.ts PlanRow JSDoc and diffEngine classifyRow row-2 drop).
      if (row.packSha === undefined) {
        await removeFromStaging(row.path, stagingRoot);
      }
      // packSha defined → no-op (staging already has the pack's content at
      // this path from the unzip — staging is pack-only on entry; see the
      // module JSDoc "Model" section).
      return;

    case "take-newPack-rename": {
      // Staging has newPath (from pack) already; just drop the stale oldPath.
      const oldPath = row.rename?.oldPath;
      if (oldPath !== undefined && oldPath !== row.path) {
        await removeFromStaging(oldPath, stagingRoot);
      }
      return;
    }

    case "drop":
      await removeFromStaging(row.path, stagingRoot);
      return;

    case "conflict":
      await applyConflictRow(row, liveRoot, stagingRoot, conflictDir, grantId);
      return;

    case "blocker":
      // Already rejected in step 1; unreachable.
      throw new IoError(
        `applyPlan: blocker row reached applyRow dispatch (path=${row.path}) — should have short-circuited`
      );

    default: {
      // Exhaustiveness check: if a new decision is added without a case here,
      // TypeScript will complain at compile time.
      const _exhaustive: never = row.decision;
      throw new IoError(
        `applyPlan: unknown decision ${String(_exhaustive)} at ${row.path}`
      );
    }
  }
}

async function applyConflictRow(
  row: PlanRow,
  liveRoot: string,
  stagingRoot: string,
  conflictDir: string,
  grantId: number | string
): Promise<void> {
  // Pre-condition guaranteed by step 2: row.resolution !== undefined.
  const res = row.resolution;
  switch (res) {
    case "staged-for-merge":
      await stageForMerge(row, liveRoot, stagingRoot, conflictDir, grantId);
      return;

    case "take-live-at-new-path": {
      // Row 8: pack renamed oldPath→newPath; user edited oldPath. Operator
      // chose to put their edits at newPath. Staging holds pack's newPath
      // content (from the unzip). Copy live's oldPath bytes OVER staging's
      // newPath (overriding the pack), then ensure oldPath is absent from
      // staging (usually already is — pack moved it, so the unzip never put
      // it there — but be defensive).
      const oldPath = row.rename?.oldPath;
      const newPath = row.rename?.newPath ?? row.path;
      if (oldPath === undefined) {
        throw new IoError(
          `applyPlan: take-live-at-new-path row missing rename.oldPath at ${row.path}`
        );
      }
      await copyLiveToStagingAt(oldPath, newPath, liveRoot, stagingRoot);
      if (oldPath !== newPath) {
        await removeFromStaging(oldPath, stagingRoot);
      }
      return;
    }

    case "take-live-at-old-path": {
      // Row 8: user rejects the rename, keeps their edits at the old path.
      // Delete newPath from staging; ensure oldPath has live's bytes.
      const oldPath = row.rename?.oldPath;
      const newPath = row.rename?.newPath ?? row.path;
      if (oldPath === undefined) {
        throw new IoError(
          `applyPlan: take-live-at-old-path row missing rename.oldPath at ${row.path}`
        );
      }
      await copyLiveToStaging(oldPath, liveRoot, stagingRoot);
      if (oldPath !== newPath) {
        await removeFromStaging(newPath, stagingRoot);
      }
      return;
    }

    case "merge-diff3":
      // Reserved name: the 3-way diff merger isn't implemented yet. We keep
      // the slot so operators can't fall into `staged-for-merge` as a
      // permanent crutch once this lands. For now point them at the working
      // alternative.
      throw new IoError(
        `applyPlan: merge-diff3 is not implemented yet (path=${row.path}). Re-resolve this conflict as staged-for-merge and edit the .live/.pack sidecars manually.`
      );

    case "take-live":
    case "take-pack":
      // diffEngine rewrites these to preserve-live / take-newPack before
      // emitting. If we see them here, the caller constructed the plan by
      // hand with a bug. Surface clearly.
      throw new IoError(
        `applyPlan: conflict row with collapsed resolution (${res}) reached applyPlan — diffEngine should have rewritten decision at ${row.path}`
      );

    case undefined:
      // Should be unreachable (step 2 checked this), but keep defensive.
      throw new ConflictsUnresolvedError([row.path]);

    default: {
      const _exhaustive: never = res;
      throw new IoError(
        `applyPlan: unknown conflict resolution ${String(_exhaustive)} at ${row.path}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// filesystem primitives
// ---------------------------------------------------------------------------

/** Copy `liveRoot/<rel>` → `stagingRoot/<rel>`. Creates parent dirs. */
async function copyLiveToStaging(
  rel: string,
  liveRoot: string,
  stagingRoot: string
): Promise<void> {
  return copyLiveToStagingAt(rel, rel, liveRoot, stagingRoot);
}

/** Copy `liveRoot/<srcRel>` → `stagingRoot/<dstRel>`. Creates parent dirs. */
async function copyLiveToStagingAt(
  srcRel: string,
  dstRel: string,
  liveRoot: string,
  stagingRoot: string
): Promise<void> {
  const src = path.join(liveRoot, toPlatformPath(srcRel));
  const dst = path.join(stagingRoot, toPlatformPath(dstRel));
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
}

/** Remove `stagingRoot/<rel>` if present. Missing is not an error. */
async function removeFromStaging(
  rel: string,
  stagingRoot: string
): Promise<void> {
  const abs = path.join(stagingRoot, toPlatformPath(rel));
  try {
    await fs.rm(abs, { force: true });
  } catch (err) {
    // fs.rm with force:true swallows ENOENT; anything else is a real error.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
}

/**
 * staged-for-merge: write `.live` + `.pack` sidecars to
 * `<conflictDir>/<grantId>/<path>.{live,pack}` and delete the path from
 * staging so the deployer's rsync skips it.
 *
 * Writes use write-then-rename for atomicity: a crash between the two
 * sidecars won't leave a half-written `.live` that shadows the real content.
 */
async function stageForMerge(
  row: PlanRow,
  liveRoot: string,
  stagingRoot: string,
  conflictDir: string,
  grantId: number | string
): Promise<void> {
  const grantDir = path.join(conflictDir, String(grantId));
  const livePath = path.join(liveRoot, toPlatformPath(row.path));
  const stagingPath = path.join(stagingRoot, toPlatformPath(row.path));
  const sidecarBase = path.join(grantDir, toPlatformPath(row.path));
  const liveSidecar = `${sidecarBase}.live`;
  const packSidecar = `${sidecarBase}.pack`;

  await fs.mkdir(path.dirname(sidecarBase), { recursive: true });

  // Copy live content (if present) to .live sidecar. Atomic: tmp + rename.
  if (await fileExists(livePath)) {
    await atomicCopy(livePath, liveSidecar);
  } else {
    // No live copy (edge case: row 4 requires liveSha but filesystem lost it).
    // Write an empty sidecar with a marker comment so operators see it.
    await atomicWrite(liveSidecar, "");
  }

  // Copy staging content (the pack's version) to .pack sidecar.
  if (await fileExists(stagingPath)) {
    await atomicCopy(stagingPath, packSidecar);
  } else {
    await atomicWrite(packSidecar, "");
  }

  // Drop the file from staging so deploy doesn't overwrite live with half a merge.
  await removeFromStaging(row.path, stagingRoot);
}

// ---------------------------------------------------------------------------
// utilities
// ---------------------------------------------------------------------------

async function fileExists(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function atomicCopy(src: string, dst: string): Promise<void> {
  const tmp = tmpName(dst);
  try {
    await fs.copyFile(src, tmp);
    await fs.rename(tmp, dst);
  } catch (err) {
    // Clean up the tmp file so orphans don't accumulate under the conflict
    // dir. Rename failure can come from EACCES / ENOSPC / EXDEV / parent-dir
    // disappearing mid-flight. Swallow cleanup errors — the original is what
    // the caller needs to see.
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function atomicWrite(dst: string, content: string): Promise<void> {
  const tmp = tmpName(dst);
  try {
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, dst);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Unique tmp filename for atomic write-then-rename. Includes a random
 * suffix so two fast-succeeding writes to the same dst can't collide.
 */
function tmpName(dst: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${dst}.tmp-${process.pid}-${Date.now()}-${rand}`;
}

/**
 * Resolve the "other path" for CaseCollisionDetectedError construction.
 *
 * Prefers the structured `row.collision` field (populated by diffEngine).
 * Falls back to regex-parsing `row.blockerDetail` only when the structured
 * field is absent — this keeps hand-built plans (e.g. fixtures in tests
 * predating the structured field) from crashing, while the production path
 * never touches the regex.
 */
function otherCollidingPath(row: PlanRow): string {
  if (row.collision?.paths && row.collision.paths.length > 0) {
    const other = row.collision.paths.find((p) => p !== row.path);
    if (other !== undefined) return other;
    // Single-path group (degenerate) — fall through to detail fallback.
  }
  return extractOtherPathFromDetail(row);
}

/** Legacy fallback: pull the second offender out of a CASE_COLLISION detail string. */
function extractOtherPathFromDetail(row: PlanRow): string {
  const d = row.blockerDetail ?? "";
  // diffEngine emits: "case collision: A collides with B, C (lowercased ...)"
  const m = d.match(/collides with ([^(]+?)(?:\s*\(lowercased|$)/);
  if (!m) return "";
  // Take just the first path if there are multiple.
  const first = m[1]?.split(",")[0]?.trim() ?? "";
  return first;
}

/** Forward-slash rel paths are safe on all platforms for path.join, but
 * normalize defensively so tests on Windows exercise the same code as Linux. */
function toPlatformPath(rel: string): string {
  return rel.split("/").join(path.sep);
}
