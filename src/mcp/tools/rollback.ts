import type { z } from "zod";
import fsP from "node:fs/promises";
import path from "node:path";
import type { RollbackInput, RollbackOutput } from "../schemas/index.js";
import { loadConfig, getPristinePaths } from "../../lib/config.js";
import { Mapping } from "../../lib/state/mapping.js";
import { State } from "../../lib/state/state.js";
import { StateLock } from "../../lib/state/lock.js";
import { rollback } from "../../lib/deploy/rollback.js";
import { NotFoundError, AmbiguousSlugError, MappingUnapprovedError } from "../../lib/errors.js";

/**
 * cfx_rollback — Phase 1.5 pristine-aware rollback.
 *
 * Wraps the `rollback()` primitive to complete the Layer 2 lifecycle:
 *
 *   1. Restore live from the selected backup (primitive does this).
 *   2. Rotate the pristine dir back to the snapshot referenced by the backup
 *      manifest's `pristineVersionIdAtBackupTime` (primitive handles this when
 *      `grantId` + `pristineDir` are passed).
 *   3. Rewrite state.pristine* to match the restored baseline so the NEXT
 *      deploy diffs against the correct pristine (no false-positive conflicts).
 *
 * Legacy-backup handling: v0.1.0 backups have no manifest; pre-first-deploy
 * manifests have null pristine fields. In BOTH cases the primitive returns
 * `restoredPristine: null`. The tool then clears state's pristine fields AND
 * wipes `<pristineDir>/<grantId>/` so the next deploy is treated as first-deploy
 * and re-captures. Leaving stale hashes pointing at a pristine that no longer
 * matches live would guarantee false conflicts on the next Layer 2 diff.
 *
 * pristine-history is never touched here — snapshots outlive state entries by
 * design (the GC pairing happens in the deployer's `pruneBackups` when the
 * corresponding backup ages out).
 */
export async function cfx_rollback(
  input: z.infer<typeof RollbackInput>
): Promise<z.infer<typeof RollbackOutput>> {
  const cfg = loadConfig();
  const { pristineDir } = getPristinePaths(cfg);
  const lock = new StateLock(cfg.stateDir);
  await lock.acquire();
  try {
    const mapping = new Mapping(cfg.stateDir);
    await mapping.load();
    if (!mapping.isApproved()) throw new MappingUnapprovedError();

    let grantId = input.grantId;
    if (grantId === undefined && input.slug) {
      const hits = Object.entries(mapping.entries())
        .filter(([, v]) => v.slug === input.slug)
        .map(([k]) => Number(k));
      if (hits.length === 0) throw new NotFoundError(`No grant with slug "${input.slug}"`);
      if (hits.length > 1) throw new AmbiguousSlugError(input.slug, hits);
      grantId = hits[0];
    }
    if (grantId === undefined) throw new NotFoundError("grantId or slug required");

    const entry = mapping.get(grantId);
    if (!entry) throw new NotFoundError(`grantId ${grantId} not in mapping`);

    const state = new State(cfg.stateDir);
    await state.load();
    const stateEntry = state.get(grantId);

    // -- Step 1 + 2: restore live + rotate pristine (primitive handles both) --
    // Passing grantId + pristineDir enables pristine rotation inside the
    // primitive. The primitive reads the backup manifest and returns
    // `restoredPristine` populated iff the manifest carried pristine info.
    const r = await rollback({
      targetPath: entry.target,
      backupDir: cfg.backupDir,
      slug: entry.slug,
      toTimestamp: input.toTimestamp,
      grantId,
      pristineDir,
    });

    // -- Step 3: reconcile state.pristine* with what actually happened -----
    if (stateEntry) {
      if (r.restoredPristine) {
        // Manifest carried a snapshot → pristine dir is now the restored
        // version. Mirror those fields into state so the next deploy diffs
        // against the correct baseline.
        state.upsert({
          ...stateEntry,
          pristineVersionId: r.restoredPristine.pristineVersionId,
          pristineCapturedAt: r.restoredPristine.pristineCapturedAt,
          pristineHashes: r.restoredPristine.pristineHashes,
        });
      } else {
        // Legacy / first-deploy backup with no pristine snapshot → the
        // primitive did NOT touch the pristine dir, but any pristine that
        // existed BEFORE rollback is now stale relative to the restored live.
        // Wipe it so the next deploy is treated as a fresh first-deploy.
        await fsP.rm(path.join(pristineDir, String(grantId)), {
          recursive: true,
          force: true,
        });
        state.upsert({
          ...stateEntry,
          pristineVersionId: null,
          pristineCapturedAt: null,
          pristineHashes: null,
        });
      }
      await state.save();
    }

    return {
      restoredPath: r.restoredPath,
      fromBackup: r.fromBackup,
      newRollingBackup: r.newRollingBackup,
      suggestedRestartCommand: `restart ${entry.slug}`,
      pristineRotatedTo: r.restoredPristine?.pristineVersionId ?? null,
    };
  } finally {
    await lock.release();
  }
}
