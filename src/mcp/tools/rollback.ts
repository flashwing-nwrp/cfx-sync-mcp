import type { z } from "zod";
import type { RollbackInput, RollbackOutput } from "../schemas/index.js";
import { loadConfig } from "../../lib/config.js";
import { Mapping } from "../../lib/state/mapping.js";
import { StateLock } from "../../lib/state/lock.js";
import { rollback } from "../../lib/deploy/rollback.js";
import { NotFoundError, AmbiguousSlugError, MappingUnapprovedError } from "../../lib/errors.js";

export async function cfx_rollback(
  input: z.infer<typeof RollbackInput>
): Promise<z.infer<typeof RollbackOutput>> {
  const cfg = loadConfig();
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

    const r = await rollback({
      targetPath: entry.target,
      backupDir: cfg.backupDir,
      slug: entry.slug,
      toTimestamp: input.toTimestamp,
    });
    return {
      restoredPath: r.restoredPath,
      fromBackup: r.fromBackup,
      newRollingBackup: r.newRollingBackup,
      suggestedRestartCommand: `restart ${entry.slug}`,
    };
  } finally {
    await lock.release();
  }
}
