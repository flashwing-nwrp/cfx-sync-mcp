/**
 * cfx_deploy_asset — Phase 1.5 central integration.
 *
 * Orchestrates three layers of the deploy pipeline:
 *
 *   1. Legacy swap (Phase 1 behavior)      — `CFX_SYNC_PRESERVE=0` or first
 *      deploy with no pristine baseline. Unzip → deploy() → (maybe) capture
 *      pristine for next run.
 *
 *   2. Layer 1 preservePaths hints         — surfaced from mapping to the
 *      caller as `preservePathsHints`. Informational; Layer 2 is authoritative.
 *
 *   3. Layer 2 diff engine                 — pristine-aware. Hash live + pack
 *      + pristine; compute rename pairs, case collisions, full DeployPlan;
 *      apply plan to staging; deploy; rotate pristine.
 *
 * The three paths share one lock, one unzip, one mapping/state load — the
 * branching happens after the plan is computed (or skipped).
 *
 * Atomicity ordering is intentional:
 *   - deploy() is the only step that touches live. If it throws, pristine is
 *     NOT rotated/captured — next run retries against the same old pristine.
 *   - state.save() is the LAST write. A crash between deploy() and save() is
 *     recoverable because pristine rotate is idempotent (rotate.ts self-heals
 *     on next run) and the backup manifest records what WAS the pristine.
 */

import type { z } from "zod";
import fsP from "node:fs/promises";
import path from "node:path";
import type {
  DeployAssetInput,
  DeployAssetOutput,
  DeployPlanSchema,
  PlanRowSchema,
  ValidationFailureSchema,
} from "../schemas/index.js";
import { loadConfig, getPristinePaths, type Config } from "../../lib/config.js";
import { State, type AssetState } from "../../lib/state/state.js";
import { Mapping, type MappingEntry } from "../../lib/state/mapping.js";
import { StateLock } from "../../lib/state/lock.js";
import { unzipToStaging } from "../../lib/deploy/unzipper.js";
import { deploy } from "../../lib/deploy/deployer.js";
import { hashTree } from "../../lib/preservation/hashTree.js";
import { findRenames } from "../../lib/preservation/renameDetection.js";
import { detectCaseCollisions } from "../../lib/preservation/caseDetection.js";
import { computeDeployPlan } from "../../lib/preservation/diffEngine.js";
import { applyPlan } from "../../lib/preservation/applyPlan.js";
import { capturePristine } from "../../lib/pristine/capture.js";
import { rotatePristine } from "../../lib/pristine/rotate.js";
import {
  MappingUnapprovedError,
  NotFoundError,
  ConflictsUnresolvedError,
  CaseCollisionDetectedError,
  EncryptedTamperDetectedError,
} from "../../lib/errors.js";
import type { DeployPlan, PlanRow, ValidationFailure, ResolutionChoice } from "../../lib/preservation/types.js";

type Input = z.infer<typeof DeployAssetInput>;
type Output = z.infer<typeof DeployAssetOutput>;

export async function cfx_deploy_asset(input: Input): Promise<Output> {
  const cfg = loadConfig();
  const paths = getPristinePaths(cfg);
  const lock = new StateLock(cfg.stateDir);
  await lock.acquire();
  try {
    // -- Step 1: load state + mapping --------------------------------------
    const state = new State(cfg.stateDir);
    await state.load();
    const mapping = new Mapping(cfg.stateDir);
    await mapping.load();
    if (!mapping.isApproved()) throw new MappingUnapprovedError();

    const entry = mapping.get(input.grantId);
    if (!entry) throw new NotFoundError(`grantId ${input.grantId} not in mapping`);

    const stateEntry = state.get(input.grantId);
    if (!stateEntry) {
      throw new NotFoundError(
        `No cached pack for grantId ${input.grantId}. Run cfx_download_asset first.`
      );
    }

    // dryRun defaults: unchanged from Phase 1 — first-time deploy (no
    // deployedAt) auto-dryRun-first so operators can preview.
    const dryRun = input.dryRun ?? !stateEntry.deployedAt;

    // -- Step 2: unzip pack to staging (needed by every path) --------------
    const unzip = await unzipToStaging(
      stateEntry.cachedZipPath,
      cfg.stagingDir,
      path.basename(entry.target)
    );

    // -- Step 3: decide which path to take ---------------------------------
    //   legacy:       preservation off OR no way to do Layer 2
    //   first-deploy: preservation on, pristine absent — capture after deploy
    //   layer-2:      preservation on, pristine present — full diff flow
    const hasPristine = stateEntry.pristineHashes !== null;
    const mode: "legacy" | "first-deploy" | "layer-2" = !cfg.preserveEnabled
      ? "legacy"
      : hasPristine
        ? "layer-2"
        : "first-deploy";

    try {
      if (mode === "legacy") {
        return await runLegacy({ cfg, paths, entry, stateEntry, unzip, state, dryRun });
      }
      if (mode === "first-deploy") {
        return await runFirstDeploy({
          cfg, paths, entry, stateEntry, unzip, state, dryRun,
        });
      }
      return await runLayer2({
        cfg, paths, entry, stateEntry, unzip, state, dryRun,
        conflictResolutions: input.conflictResolutions,
      });
    } catch (err) {
      // Clean up the staging extract-* dir on any error so staging doesn't
      // accumulate orphans. Never swallow the original error.
      await fsP.rm(unzip.root, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  } finally {
    await lock.release();
  }
}

// ---------------------------------------------------------------------------
// Orchestration paths
// ---------------------------------------------------------------------------

interface PathCtx {
  cfg: Config;
  paths: ReturnType<typeof getPristinePaths>;
  entry: MappingEntry;
  stateEntry: AssetState;
  unzip: { root: string; validationFailures: ValidationFailure[] };
  state: State;
  dryRun: boolean;
}

/**
 * Legacy Phase-1 plain-swap path. Used when CFX_SYNC_PRESERVE=0.
 * Skips pristine capture entirely — the operator has opted out of Layer 2.
 */
async function runLegacy(ctx: PathCtx): Promise<Output> {
  const { cfg, entry, stateEntry, unzip, state, dryRun } = ctx;

  const result = await deploy({
    stagingRoot: unzip.root,
    targetPath: entry.target,
    backupDir: cfg.backupDir,
    slug: entry.slug,
    dryRun,
    backupRetain: cfg.backupRetain,
    // No pristine opts — we're not tracking pristine in this mode.
  });

  if (!dryRun) {
    state.upsert({
      ...stateEntry,
      deployedPath: result.deployedPath,
      deployedAt: new Date().toISOString(),
      backups: result.backupPath
        ? [result.backupPath, ...stateEntry.backups].slice(0, cfg.backupRetain)
        : stateEntry.backups,
    });
    await state.save();
  }

  return {
    slug: entry.slug,
    deployedPath: result.deployedPath,
    backupPath: result.backupPath,
    suggestedServerCfg: null,
    suggestedRestartCommand: `restart ${entry.slug}`,
    dryRun,
    plan: null,
    preservePathsHints: preservePathsHintsFromMapping(entry),
    packValidationFailures: unzip.validationFailures,
    preservationMode: "legacy",
    pristineCaptured: false,
  };
}

/**
 * First deploy under Layer 2. No pristine exists yet, so there's nothing to
 * diff against — perform the plain swap, then capture pristine from the
 * deployed live dir so the NEXT deploy can run the full diff flow.
 *
 * If the capture fails after a successful deploy, we surface the error but
 * state.deployedAt is NOT updated — rerunning will re-capture. This keeps
 * state consistent: either everything succeeded, or state reflects the
 * pre-deploy world.
 *
 * Trade-off: if deploy succeeds but capture fails, the filesystem has the new
 * resource but state thinks nothing changed. Next deploy will back up the new
 * resource as "the prior live" and redeploy the same pack. The extra backup is
 * harmless; the alternative (save state before capture) would leave a live
 * without a pristine on the next run, which is worse.
 */
async function runFirstDeploy(ctx: PathCtx): Promise<Output> {
  const { cfg, paths, entry, stateEntry, unzip, state, dryRun } = ctx;

  // dryRun on first-deploy returns the same shape as legacy dryRun but with
  // a note that Layer 2 will activate on the next deploy.
  const result = await deploy({
    stagingRoot: unzip.root,
    targetPath: entry.target,
    backupDir: cfg.backupDir,
    slug: entry.slug,
    dryRun,
    backupRetain: cfg.backupRetain,
    // Pristine opts included so the backup manifest schema is consistent, but
    // currentPristineVersionId=null tells deploy() "no prior pristine to snapshot".
    pristine: {
      grantId: stateEntry.grantId,
      currentPristineVersionId: null,
      pristineDir: paths.pristineDir,
      pristineHistoryDir: paths.pristineHistoryDir,
      currentPristineHashes: null,
      currentPristineCapturedAt: null,
    },
  });

  if (dryRun) {
    return {
      slug: entry.slug,
      deployedPath: result.deployedPath,
      backupPath: result.backupPath,
      suggestedServerCfg: null,
      suggestedRestartCommand: `restart ${entry.slug}`,
      dryRun: true,
      plan: null,
      preservePathsHints: preservePathsHintsFromMapping(entry),
      packValidationFailures: unzip.validationFailures,
      preservationMode: "first-deploy",
      pristineCaptured: false,
    };
  }

  // Real deploy just succeeded. Capture pristine from the deployed live dir so
  // the next run can do a real diff. Use the deployed path as the source —
  // staging got moved into live by deploy(), so `unzip.root` is gone.
  const snapshot = await capturePristine({
    stagingRoot: result.deployedPath,
    grantId: stateEntry.grantId,
    pristineDir: paths.pristineDir,
    versionId: stateEntry.versionId,
  });

  state.upsert({
    ...stateEntry,
    deployedPath: result.deployedPath,
    deployedAt: new Date().toISOString(),
    backups: result.backupPath
      ? [result.backupPath, ...stateEntry.backups].slice(0, cfg.backupRetain)
      : stateEntry.backups,
    pristineVersionId: snapshot.versionId,
    pristineCapturedAt: snapshot.capturedAt,
    pristineHashes: mapToRecord(snapshot.hashes),
  });
  await state.save();

  return {
    slug: entry.slug,
    deployedPath: result.deployedPath,
    backupPath: result.backupPath,
    suggestedServerCfg: null,
    suggestedRestartCommand: `restart ${entry.slug}`,
    dryRun: false,
    plan: null,
    preservePathsHints: preservePathsHintsFromMapping(entry),
    packValidationFailures: unzip.validationFailures,
    preservationMode: "first-deploy",
    pristineCaptured: true,
  };
}

/**
 * Full Layer 2 preservation path. Hashes live + pack, merges with stored
 * pristine hashes, computes plan, applies to staging, deploys, rotates pristine.
 */
async function runLayer2(
  ctx: PathCtx & { conflictResolutions?: Record<string, ResolutionChoice> }
): Promise<Output> {
  const { cfg, paths, entry, stateEntry, unzip, state, dryRun, conflictResolutions } = ctx;

  if (stateEntry.pristineHashes === null) {
    // Defense-in-depth — caller guarantees pristineHashes !== null here, but
    // a race where it becomes null would fall back to first-deploy.
    return runFirstDeploy(ctx);
  }

  // -- Hash live + pack --------------------------------------------------
  const pristineHashes = recordToMap(stateEntry.pristineHashes);
  const [liveHashes, packHashes] = await Promise.all([
    hashTreeIfExists(entry.target),
    hashTree(unzip.root),
  ]);

  // -- Rename + case collision detection ---------------------------------
  const renamePairs = findRenames(pristineHashes, packHashes);
  const allPaths = collectUnion(pristineHashes, liveHashes, packHashes);
  const caseCollisions = detectCaseCollisions(allPaths);

  // -- Compute plan ------------------------------------------------------
  const plan = computeDeployPlan({
    pristineHashes,
    liveHashes,
    packHashes,
    renamePairs,
    caseCollisions,
    conflictResolutions,
    packValidationFailures: unzip.validationFailures,
  });

  // -- Dry run: return plan, don't mutate --------------------------------
  if (dryRun) {
    return {
      slug: entry.slug,
      deployedPath: entry.target,
      backupPath: null,
      suggestedServerCfg: null,
      suggestedRestartCommand: `restart ${entry.slug}`,
      dryRun: true,
      plan: serializePlan(plan),
      preservePathsHints: preservePathsHintsFromMapping(entry),
      packValidationFailures: unzip.validationFailures,
      preservationMode: "layer-2",
      pristineCaptured: false,
    };
  }

  // -- Real apply: surface blockers + unresolved conflicts early ---------
  // Pre-throw blockers before staging mutation so the operator sees the
  // typed error without a half-applied plan. applyPlan also re-throws
  // blockers (iterating plan.rows, which is canonical) — this pre-check
  // is UX, not correctness. If diffEngine ever emits a blocker into
  // plan.rows but forgets to mirror it into plan.blockers, applyPlan still
  // catches it.
  //
  // Same reasoning for unresolved conflicts: applyPlan throws
  // ConflictsUnresolvedError over plan.rows; we throw the same thing over
  // plan.conflicts here so the caller can add conflictResolutions on the
  // next call without watching applyPlan start mutating first.
  //
  // Order: blockers before conflicts so a case-collision that also has
  // unresolved conflicts throws the blocker (the worse error wins).
  for (const row of plan.blockers) {
    if (row.blockerCode === "CASE_COLLISION_DETECTED") {
      const other = row.collision?.paths.find((p) => p !== row.path) ?? "";
      throw new CaseCollisionDetectedError(row.path, other);
    }
    if (row.blockerCode === "ENCRYPTED_TAMPER_DETECTED") {
      throw new EncryptedTamperDetectedError(row.path);
    }
  }
  const unresolved = plan.conflicts
    .filter((r) => r.resolution === undefined)
    .map((r) => r.path);
  if (unresolved.length > 0) throw new ConflictsUnresolvedError(unresolved);

  // -- Apply plan to staging ---------------------------------------------
  // applyPlan copies live bytes into staging for preserve-live rows, writes
  // sidecars for staged-for-merge rows, and deletes take-newPack-delete rows.
  await applyPlan({
    plan,
    liveRoot: entry.target,
    stagingRoot: unzip.root,
    conflictDir: paths.conflictDir,
    grantId: stateEntry.grantId,
  });

  // -- Deploy (swap staging → live, back up old live + pristine snapshot)
  const result = await deploy({
    stagingRoot: unzip.root,
    targetPath: entry.target,
    backupDir: cfg.backupDir,
    slug: entry.slug,
    dryRun: false,
    backupRetain: cfg.backupRetain,
    pristine: {
      grantId: stateEntry.grantId,
      currentPristineVersionId: stateEntry.pristineVersionId,
      pristineDir: paths.pristineDir,
      pristineHistoryDir: paths.pristineHistoryDir,
      currentPristineHashes: stateEntry.pristineHashes,
      currentPristineCapturedAt: stateEntry.pristineCapturedAt,
    },
  });

  // -- Rotate pristine to the NEW pack contents --------------------------
  // Source is the deployed live dir (staging was moved into it).
  // rotatePristine is idempotent + self-healing; retry-safe if we crash here.
  const rotation = await rotatePristine({
    grantId: stateEntry.grantId,
    newStagingRoot: result.deployedPath,
    stateEntry,
    pristineDir: paths.pristineDir,
    newVersionId: stateEntry.versionId,
  });

  // -- Commit state (LAST write). A crash earlier is recoverable; a crash
  //    after deploy + rotate but before save means next run sees old state
  //    entry with stale pristineHashes — deploy will re-rotate to the same
  //    versionId (idempotent) and this time save. No data loss.
  state.upsert({
    ...stateEntry,
    deployedPath: result.deployedPath,
    deployedAt: new Date().toISOString(),
    backups: result.backupPath
      ? [result.backupPath, ...stateEntry.backups].slice(0, cfg.backupRetain)
      : stateEntry.backups,
    pristineVersionId: rotation.rotatedTo,
    pristineCapturedAt: rotation.capturedAt,
    pristineHashes: mapToRecord(rotation.newPristineHashes),
  });
  await state.save();

  return {
    slug: entry.slug,
    deployedPath: result.deployedPath,
    backupPath: result.backupPath,
    suggestedServerCfg: null,
    suggestedRestartCommand: `restart ${entry.slug}`,
    dryRun: false,
    plan: serializePlan(plan),
    preservePathsHints: preservePathsHintsFromMapping(entry),
    packValidationFailures: unzip.validationFailures,
    preservationMode: "layer-2",
    pristineCaptured: true,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mapToRecord(m: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of m) out[k] = v;
  return out;
}

function recordToMap(r: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(r)) out.set(k, v);
  return out;
}

function collectUnion(
  a: Map<string, string>,
  b: Map<string, string>,
  c: Map<string, string>
): string[] {
  const s = new Set<string>();
  for (const k of a.keys()) s.add(k);
  for (const k of b.keys()) s.add(k);
  for (const k of c.keys()) s.add(k);
  return [...s];
}

/**
 * Hash `root` if it exists; return empty map if missing (first deploy into a
 * fresh target, or a prior crashed deploy wiped the live dir).
 */
async function hashTreeIfExists(root: string): Promise<Map<string, string>> {
  try {
    await fsP.stat(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw e;
  }
  return hashTree(root);
}

function preservePathsHintsFromMapping(entry: MappingEntry): string[] {
  return entry.preservePaths ?? [];
}

/**
 * Convert an internal DeployPlan into the zod-validated output shape.
 * Everything is already JSON-serializable — this is mostly a cast with a
 * narrow `as` to bridge the two identical shapes declared in different
 * modules (schema.ts vs preservation/types.ts).
 */
function serializePlan(plan: DeployPlan): z.infer<typeof DeployPlanSchema> {
  return {
    rows: plan.rows.map(serializeRow),
    blockers: plan.blockers.map(serializeRow),
    conflicts: plan.conflicts.map(serializeRow),
    packValidationFailures: plan.packValidationFailures.map(
      (v) => ({ path: v.path, reason: v.reason }) as z.infer<typeof ValidationFailureSchema>
    ),
  };
}

function serializeRow(r: PlanRow): z.infer<typeof PlanRowSchema> {
  // All PlanRow fields are serializable; we just forward them. zod validates
  // structure at the MCP boundary.
  return {
    path: r.path,
    decision: r.decision,
    rowNumber: r.rowNumber,
    ...(r.rename ? { rename: r.rename } : {}),
    ...(r.conflictOptions ? { conflictOptions: r.conflictOptions } : {}),
    ...(r.resolution ? { resolution: r.resolution } : {}),
    ...(r.blockerCode ? { blockerCode: r.blockerCode } : {}),
    ...(r.blockerDetail ? { blockerDetail: r.blockerDetail } : {}),
    ...(r.collision ? { collision: r.collision } : {}),
    ...(r.liveSha ? { liveSha: r.liveSha } : {}),
    ...(r.pristineSha ? { pristineSha: r.pristineSha } : {}),
    ...(r.packSha ? { packSha: r.packSha } : {}),
  };
}
