import type { z } from "zod";
import type { ApproveMappingInput, ApproveMappingOutput } from "../schemas/index.js";
import { loadConfig } from "../../lib/config.js";
import { Mapping, type MappingEntry } from "../../lib/state/mapping.js";
import { StateLock } from "../../lib/state/lock.js";
import { ResolutionLog } from "../../lib/state/resolutionLog.js";
import path from "node:path";

export async function cfx_approve_mapping(
  input: z.infer<typeof ApproveMappingInput>
): Promise<z.infer<typeof ApproveMappingOutput>> {
  const cfg = loadConfig();
  const lock = new StateLock(cfg.stateDir);
  await lock.acquire();
  try {
    const mapping = new Mapping(cfg.stateDir);
    await mapping.load();

    // Commit tier 1+2 (confidence === 1.0) with reviewedByUser: true (auto-safe).
    // Commit tier 3+4 (fuzzy) provisionally with reviewedByUser: false — they
    // surface in cfx_list_unresolved's "suspicious" bucket for manual review.
    // newInstalls stay in the out-of-band queue and are never written as entries.
    const committed: Record<string, MappingEntry> = {};
    const autoSafeKeys: string[] = [];
    let fuzzy = 0;
    for (const [k, v] of Object.entries(input.proposed.entries)) {
      // Strip legacy `disabled` field from the v3-shaped DiscoverOutput entry.
      const { disabled: _, ...rest } = v as typeof v & { disabled?: boolean };
      const autoSafe = v.discoveredConfidence === 1.0;
      committed[k] = {
        ...rest,
        status: "active",
        reviewedByUser: autoSafe,
      };
      if (autoSafe) autoSafeKeys.push(k);
      else fuzzy += 1;
    }

    // Preserve newInstalls + orphaned from the proposal so cfx_list_unresolved
    // can surface them. approveFromProposed only takes entries; patch the
    // rest after-the-fact.
    mapping.approveFromProposed(committed);
    const data = mapping.getFile();
    data.newInstalls = input.proposed.newInstalls ?? [];
    data.orphaned = input.proposed.orphaned ?? [];
    await mapping.save();

    // Log auto-approve resolutions (only tier 1+2 — fuzzy entries log when they're actually resolved)
    const log = new ResolutionLog(cfg.stateDir);
    const now = new Date().toISOString();
    for (const k of autoSafeKeys) {
      const v = committed[k]!;
      await log.append({
        ts: now,
        grantId: Number(k),
        author: null,
        assetName: v.assetName,
        action: "auto-approve",
        tierBefore: v.discoveredTier,
        confidenceBefore: v.discoveredConfidence,
        chosenBasename: path.basename(v.target),
        overrideInput: null,
      });
    }

    const newInstallCount = (input.proposed.newInstalls ?? []).length;
    return {
      path: path.join(cfg.stateDir, "cfx-sync-map.json"),
      entriesCount: autoSafeKeys.length,
      needsResolution: { fuzzy, newInstalls: newInstallCount },
      nextStep: fuzzy > 0 || newInstallCount > 0
        ? "call cfx_list_unresolved"
        : undefined,
    };
  } finally {
    await lock.release();
  }
}
