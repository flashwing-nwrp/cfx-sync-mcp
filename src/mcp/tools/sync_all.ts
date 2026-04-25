import type { z } from "zod";
import type { SyncAllInput, SyncAllOutput } from "../schemas/index.js";
import { cfx_check_updates } from "./check_updates.js";
import { cfx_download_asset } from "./download_asset.js";
import { cfx_deploy_asset } from "./deploy_asset.js";
import { CfxError, PreservationError } from "../../lib/errors.js";

export async function cfx_sync_all(
  input: z.infer<typeof SyncAllInput>
): Promise<z.infer<typeof SyncAllOutput>> {
  const only = new Set(input.only ?? []);
  const skip = new Set(input.skip ?? []);

  const { updated } = await cfx_check_updates({ force: input.force });
  const summary = { checked: updated.length, changed: 0, downloaded: 0, deployed: 0, skipped: 0, failed: 0 };
  const perAsset: z.infer<typeof SyncAllOutput>["perAsset"] = [];
  const suggestedRestarts: string[] = [];

  for (const u of updated) {
    if (only.size > 0 && !only.has(u.grantId)) {
      summary.skipped++;
      perAsset.push({ grantId: u.grantId, slug: u.slug, action: "skipped" });
      continue;
    }
    if (skip.has(u.grantId)) {
      summary.skipped++;
      perAsset.push({ grantId: u.grantId, slug: u.slug, action: "skipped" });
      continue;
    }

    summary.changed++;
    try {
      await cfx_download_asset({ grantId: u.grantId });
      summary.downloaded++;
      const deployed = await cfx_deploy_asset({ grantId: u.grantId, dryRun: input.dryRun ?? false });
      if (!deployed.dryRun) {
        summary.deployed++;
        suggestedRestarts.push(deployed.suggestedRestartCommand);
      }
      perAsset.push({ grantId: u.grantId, slug: u.slug, action: deployed.dryRun ? "downloaded" : "deployed" });
    } catch (e) {
      summary.failed++;
      perAsset.push({
        grantId: u.grantId,
        slug: u.slug,
        action: "failed",
        error: (e instanceof CfxError || e instanceof PreservationError)
          ? { code: e.code, message: e.message, hint: e.hint, retryable: e.retryable }
          : { code: "IO", message: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  return { summary, perAsset, suggestedRestarts };
}
