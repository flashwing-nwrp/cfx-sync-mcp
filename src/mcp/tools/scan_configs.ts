import type { z } from "zod";
import fsP from "node:fs/promises";
import type {
  ScanConfigsInput,
  ScanConfigsOutput,
} from "../schemas/index.js";
import { loadConfig } from "../../lib/config.js";
import { Mapping } from "../../lib/state/mapping.js";
import { StateLock } from "../../lib/state/lock.js";
import { scanConfigs } from "../../lib/preservation/scanConfigs.js";
import {
  MappingUnapprovedError,
  NotFoundError,
  InvalidTargetError,
} from "../../lib/errors.js";

type Output = z.infer<typeof ScanConfigsOutput>;
type Input = z.infer<typeof ScanConfigsInput>;

/**
 * Layer 1 preservation scanner (advisory). Runs `scanConfigs` across one or
 * all mapped grants and writes `preservePaths` + `preservePathsSource:
 * "scan-v1"` back into cfx-sync-map.json.
 *
 * Idempotent: re-running over a tree with no disk changes yields identical
 * paths. Safe to run against a 300-grant mapping — a missing target emits a
 * `skipped` row rather than aborting the sweep.
 */
export async function cfx_scan_configs(input: Input): Promise<Output> {
  const cfg = loadConfig();
  const lock = new StateLock(cfg.stateDir);
  await lock.acquire();
  try {
    const mapping = new Mapping(cfg.stateDir);
    await mapping.load();
    if (!mapping.isApproved()) {
      throw new MappingUnapprovedError();
    }

    const entries = mapping.entries();
    const activeEntries = mapping.getActiveEntries();

    // Determine which grantIds to scan.
    let targets: number[];
    if (input.grantId !== undefined) {
      const entry = mapping.get(input.grantId);
      if (!entry) {
        throw new NotFoundError(
          `Grant ${input.grantId} not found in cfx-sync-map.json.`
        );
      }
      if (entry.status === "disabled") {
        throw new InvalidTargetError(
          `Grant ${input.grantId} is disabled; scan refused. Set status:'active' in cfx-sync-map.json or pass a different grantId.`
        );
      }
      if (entry.status === "new-install") {
        throw new InvalidTargetError(
          `Grant ${input.grantId} is new-install (not yet deployed locally); scan refused.`
        );
      }
      targets = [input.grantId];
    } else {
      // No args OR { all: true } → every active entry only.
      targets = Object.entries(activeEntries)
        .map(([id]) => Number(id))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);
    }

    const scanned: Output["scanned"] = [];
    const skipped: NonNullable<Output["skipped"]> = [];

    // In all-mode, surface non-active entries as skipped for visibility.
    if (input.grantId === undefined) {
      for (const [id, entry] of Object.entries(entries)) {
        if (entry.status === "disabled") {
          skipped.push({ grantId: Number(id), reason: "disabled" });
        } else if (entry.status === "new-install") {
          skipped.push({ grantId: Number(id), reason: "new-install" });
        }
      }
      skipped.sort((a, b) => a.grantId - b.grantId);
    }

    for (const grantId of targets) {
      const entry = entries[String(grantId)]!;
      // Guard against stale mapping pointing at a deleted/renamed directory.
      // Distinguish ENOENT (skip) from other errors (propagate).
      let targetExists = true;
      try {
        const st = await fsP.stat(entry.target);
        if (!st.isDirectory()) targetExists = false;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") targetExists = false;
        else throw err;
      }
      if (!targetExists) {
        skipped.push({ grantId, reason: "target-not-found" });
        continue;
      }

      const preservePaths = await scanConfigs(entry.target);
      entry.preservePaths = preservePaths;
      entry.preservePathsSource = "scan-v1";
      scanned.push({
        grantId,
        slug: entry.slug,
        preservePaths,
        count: preservePaths.length,
      });
    }

    await mapping.save();

    const totalPreservePaths = scanned.reduce((n, s) => n + s.count, 0);
    const out: Output = { scanned, totalPreservePaths };
    if (skipped.length > 0) out.skipped = skipped;
    return out;
  } finally {
    await lock.release();
  }
}
