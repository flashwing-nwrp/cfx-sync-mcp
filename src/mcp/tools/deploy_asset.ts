import type { z } from "zod";
import type { DeployAssetInput, DeployAssetOutput } from "../schemas/index.js";
import { loadConfig } from "../../lib/config.js";
import { State } from "../../lib/state/state.js";
import { Mapping } from "../../lib/state/mapping.js";
import { StateLock } from "../../lib/state/lock.js";
import { unzipToStaging } from "../../lib/deploy/unzipper.js";
import { deploy } from "../../lib/deploy/deployer.js";
import { MappingUnapprovedError, NotFoundError } from "../../lib/errors.js";
import path from "node:path";

export async function cfx_deploy_asset(
  input: z.infer<typeof DeployAssetInput>
): Promise<z.infer<typeof DeployAssetOutput>> {
  const cfg = loadConfig();
  const lock = new StateLock(cfg.stateDir);
  await lock.acquire();
  try {
    const state = new State(cfg.stateDir);
    await state.load();
    const mapping = new Mapping(cfg.stateDir);
    await mapping.load();
    if (!mapping.isApproved()) throw new MappingUnapprovedError();

    const entry = mapping.get(input.grantId);
    if (!entry) throw new NotFoundError(`grantId ${input.grantId} not in mapping`);

    const stateEntry = state.get(input.grantId);
    if (!stateEntry) throw new NotFoundError(`No cached pack for grantId ${input.grantId}. Run cfx_download_asset first.`);

    const dryRun = input.dryRun ?? !stateEntry.deployedAt;
    const unzip = await unzipToStaging(
      stateEntry.cachedZipPath,
      cfg.stagingDir,
      path.basename(entry.target)
    );

    const result = await deploy({
      stagingRoot: unzip.root,
      targetPath: entry.target,
      backupDir: cfg.backupDir,
      slug: entry.slug,
      dryRun,
      backupRetain: cfg.backupRetain,
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
      suggestedServerCfg: null, // Phase 1: skip server.cfg inspection; emit null
      suggestedRestartCommand: `restart ${entry.slug}`,
      dryRun,
    };
  } finally {
    await lock.release();
  }
}
