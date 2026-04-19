/**
 * applyPlan — Phase 1.5 Task 12.
 *
 * Given a resolved {@link DeployPlan} (all conflicts have a resolution and no
 * blockers), mutate the `stagingRoot` tree so it represents the final
 * to-be-deployed state. The deployer calls this AFTER overlaying the new
 * pack's contents onto a copy of live (or a pristine scaffold) so that:
 *
 *   - `preserve-live`  → copy live's bytes into staging (user's edit wins)
 *   - `take-newPack`   → staging already has pack content; no-op
 *                        EXCEPT when `packSha` is undefined (pack dropped
 *                        the file) — then delete it from staging.
 *   - `take-newPack-rename` → staging has newPath from pack; remove stale
 *                             oldPath so both don't coexist in live.
 *   - `drop`           → remove from staging if present (usually already absent).
 *   - `conflict` with resolution:
 *       - `staged-for-merge` → write `.live` + `.pack` sidecars under
 *         `<conflictDir>/<grantId>/<path>.{live,pack}` and DELETE the path
 *         from staging so the deployer's rsync skips it (operator resolves
 *         manually by rewriting live and re-running).
 *       - `take-live-at-new-path` (row 8) → write live's oldPath bytes to
 *         newPath in staging; remove oldPath from staging.
 *       - `take-live-at-old-path` (row 8) → write live's oldPath bytes to
 *         oldPath in staging; remove newPath from staging (reject rename).
 *       - `merge-diff3` → NOT IMPLEMENTED yet. Throws with a hint pointing
 *         operators at `staged-for-merge`. Reserved so adding a proper 3-way
 *         merger later doesn't require a migration.
 *   - `blocker` → throws {@link CaseCollisionDetectedError} or
 *                 {@link EncryptedTamperDetectedError} BEFORE any mutation.
 *   - `conflict` without resolution → throws {@link ConflictsUnresolvedError}
 *     BEFORE any mutation, listing all offending paths.
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
      // blockerDetail format from diffEngine: "case collision: A collides
      // with B (lowercased to ...)" — extract the two paths as best we can,
      // but fallback to the row path alone is fine; the error just needs to
      // identify the offender.
      throw new CaseCollisionDetectedError(row.path, extractOtherPath(row));
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
      // packSha defined → no-op (staging already has pack content from the
      // deployer's pack overlay step).
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
      // chose to put their edits at newPath. Staging currently holds pack's
      // newPath content AND (from the deployer's live pre-overlay) the user's
      // oldPath content. Rewrite newPath with live's old-path bytes; delete
      // oldPath from staging.
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
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
  await fs.copyFile(src, tmp);
  await fs.rename(tmp, dst);
}

async function atomicWrite(dst: string, content: string): Promise<void> {
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, dst);
}

/** Best-effort: pull the second offender out of a CASE_COLLISION detail string. */
function extractOtherPath(row: PlanRow): string {
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
