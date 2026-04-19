/**
 * Shared types for the Phase 1.5 preservation module (Layer 2 diff engine).
 *
 * These types are the contract between:
 *   - `diffEngine.computeDeployPlan(...)` — the pure decision function
 *   - `applyPlan(...)` (Task 12) — the filesystem mutator that consumes the plan
 *   - the MCP tool layer — surfaces conflicts/blockers to the caller
 *
 * Everything here is serializable (no classes, no functions) so a plan can be
 * snapshotted for review or replayed for tests.
 */

import type { RenamePair } from "./renameDetection.js";
import type { CollisionGroup } from "./caseDetection.js";

/**
 * One of six decisions the diff engine can emit per path.
 *
 * Mapping to the 10-row matrix in the Layer 2 spec:
 *   - "take-newPack":        rows 1, 2
 *   - "preserve-live":       rows 3, 5
 *   - "take-newPack-rename": row 7
 *   - "drop":                row 6
 *   - "conflict":            rows 4, 8 (needs user resolution)
 *   - "blocker":             rows 9, 10 (refuses to deploy until fixed)
 */
export type DiffDecision =
  | "take-newPack"
  | "preserve-live"
  | "take-newPack-rename"
  | "drop"
  | "conflict"
  | "blocker";

/**
 * User-supplied resolution for a conflict row.
 *
 * Row 4 (modify/modify at same path) accepts:
 *   take-live, take-pack, merge-diff3, staged-for-merge
 *
 * Row 8 (user-modified at old path + vendor renamed) accepts those plus:
 *   take-live-at-new-path, take-live-at-old-path
 *
 * `take-live` and `take-pack` collapse to `preserve-live` / `take-newPack`
 * decisions respectively — the diff engine rewrites the row. The other four
 * resolutions keep `decision: "conflict"` and attach the choice as a
 * `resolution` field; Task 12 (applyPlan) dispatches on that.
 */
export type ResolutionChoice =
  | "take-live"
  | "take-pack"
  | "merge-diff3"
  | "staged-for-merge"
  | "take-live-at-new-path"
  | "take-live-at-old-path";

/**
 * Machine-readable blocker codes. Mirror the preservation error classes in
 * `src/lib/errors.ts` so the MCP tool layer can throw a typed error when a
 * blocker row is present.
 */
export type BlockerCode =
  | "CASE_COLLISION_DETECTED"
  | "ENCRYPTED_TAMPER_DETECTED";

/**
 * One row of the deploy plan. The `path` is repo-relative, forward-slash
 * normalized, with no leading slash (matches `hashTree` output).
 *
 * Context fields are populated conditionally based on `decision`:
 *   - rename:            take-newPack-rename + row-8 conflict
 *   - conflictOptions:   conflict
 *   - resolution:        conflict rows that had a user resolution supplied but
 *                        still need downstream processing (merge-diff3,
 *                        staged-for-merge, take-live-at-*-path)
 *   - blockerCode/Detail: blocker
 *   - liveSha / pristineSha / packSha: populated whenever the respective side
 *                        has a hash for this path, useful for debug and for
 *                        Task 12's merge helpers.
 */
export interface PlanRow {
  path: string;
  decision: DiffDecision;
  rowNumber: number;
  rename?: { oldPath: string; newPath: string };
  conflictOptions?: ResolutionChoice[];
  resolution?: ResolutionChoice;
  blockerCode?: BlockerCode;
  blockerDetail?: string;
  liveSha?: string;
  pristineSha?: string;
  packSha?: string;
}

/**
 * Pack-level validation failure recorded by the unzipper (Task 6) and passed
 * through to the plan so callers see all problems in one place.
 */
export interface ValidationFailure {
  path: string;
  reason: "symlink-refused" | "path-traversal-refused" | string;
}

/**
 * Full output of `computeDeployPlan`. `blockers` and `conflicts` are
 * convenience slices of `rows`, not independent data — mutating them has no
 * effect on `rows`.
 */
export interface DeployPlan {
  rows: PlanRow[];
  blockers: PlanRow[];
  conflicts: PlanRow[];
  packValidationFailures: ValidationFailure[];
}

/**
 * Input bag for the pure `computeDeployPlan` function. No filesystem access
 * — all three hash maps, rename pairs, and collision groups are precomputed
 * by upstream helpers (hashTree, findRenames, detectCaseCollisions).
 */
export interface ComputeDeployPlanInput {
  pristineHashes: Map<string, string>;
  liveHashes: Map<string, string>;
  packHashes: Map<string, string>;
  renamePairs: RenamePair[];
  caseCollisions: CollisionGroup[];
  /**
   * Optional map of repo-relative path → user's resolution choice. When a
   * path is present here AND would otherwise be a conflict row, the engine
   * applies the resolution per `ResolutionChoice` docs.
   */
  conflictResolutions?: Record<string, ResolutionChoice>;
  /**
   * Pack-extraction failures from Task 6 (unzipper). Passed through
   * unchanged; the diff engine does not inspect them.
   */
  packValidationFailures?: ValidationFailure[];
}

// Re-export supporting types so downstream consumers can import everything
// plan-shaped from one module.
export type { RenamePair } from "./renameDetection.js";
export type { CollisionGroup } from "./caseDetection.js";
