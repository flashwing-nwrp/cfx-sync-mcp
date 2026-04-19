/**
 * cfx_set_fork_mode — Phase 1.6 Task 11.
 *
 * Mutates a single mapping entry's `ignoreUpstreamUpdates*` triad so operators
 * don't hand-edit cfx-sync-map.json for the common fork case (e.g. ULC with
 * local 1.9.0 ahead of upstream v1.8.0). A subsequent `cfx_scan_updates` call
 * immediately sees the flag and routes the resource to `suppressed` with
 * reason `ignore-upstream-updates`.
 *
 * Operates under `StateLock` (same pattern as `cfx_scan_configs` /
 * `cfx_reset_pristine`). Mutation reaches disk via `Mapping.save()`'s atomic
 * tmp+rename — no new I/O primitives added.
 *
 * ### Semantics (spec §cfx_set_fork_mode)
 *
 *  - Target mapping entry must exist (approved mapping). Unknown slug/grantId
 *    → `NotFoundError`. Missing/unapproved mapping → `MappingUnapprovedError`.
 *  - `enabled: true` — writes the triad. If already flagged, refreshes
 *    `reason` + `setAt` to the new call's values (operator "update my note").
 *  - `enabled: false` — clears all three audit fields back to absent. On an
 *    unflagged entry this is an idempotent no-op (no save, nothing to clear).
 *    Returns the current state either way.
 *
 * ### `setAt` in the output
 *
 * Mirrors what lives on disk after the call. On `enabled: true` that's the
 * fresh ISO stamp. On `enabled: false` where the flag was present it's the
 * pre-clear `setAt` we just removed — we retain it in the response for audit
 * so the operator sees the value that was just cleared. On `enabled: false`
 * against an unflagged entry there's no meaningful historical value, so we
 * stamp the no-op call time to satisfy the schema's required `setAt`.
 */

import type { z } from "zod";
import type { SetForkModeInput, SetForkModeOutput } from "../schemas/index.js";
import type { MappingEntry } from "../../lib/state/mapping.js";
import { loadConfig } from "../../lib/config.js";
import { Mapping } from "../../lib/state/mapping.js";
import { StateLock } from "../../lib/state/lock.js";
import {
  MappingUnapprovedError,
  NotFoundError,
  AmbiguousSlugError,
} from "../../lib/errors.js";

type Input = z.infer<typeof SetForkModeInput>;
type Output = z.infer<typeof SetForkModeOutput>;

export async function cfx_set_fork_mode(input: Input): Promise<Output> {
  const cfg = loadConfig();
  const lock = new StateLock(cfg.stateDir);
  await lock.acquire();
  try {
    const mapping = new Mapping(cfg.stateDir);
    await mapping.load();
    if (!mapping.isApproved()) {
      throw new MappingUnapprovedError();
    }

    // Resolve {slug|grantId} → (grantId, entry). Schema guarantees exactly one
    // is set; check both defensively.
    let grantId: number | undefined;
    let entry: MappingEntry | undefined;

    if (input.grantId !== undefined) {
      grantId = input.grantId;
      entry = mapping.get(grantId);
    } else if (input.slug !== undefined) {
      const hits = Object.entries(mapping.entries())
        .filter(([, v]) => v.slug === input.slug)
        .map(([k, v]) => ({ id: Number(k), entry: v }));
      if (hits.length === 0) {
        throw new NotFoundError(
          `No mapping entry matches slug "${input.slug}".`
        );
      }
      if (hits.length > 1) {
        throw new AmbiguousSlugError(
          input.slug,
          hits.map((h) => h.id)
        );
      }
      grantId = hits[0]!.id;
      entry = hits[0]!.entry;
    }

    if (entry === undefined || grantId === undefined) {
      throw new NotFoundError(
        `No mapping entry matches grantId=${String(input.grantId)}.`
      );
    }

    const now = new Date().toISOString();
    const wasFlagged = entry.ignoreUpstreamUpdates === true;
    const priorSetAt = entry.ignoreUpstreamUpdatesSetAt;

    if (input.enabled) {
      // Set/refresh the triad — always overwrites so operators can update
      // `reason` on re-call. Optional `reason` stays undefined when omitted;
      // JSON.stringify drops undefined fields from the on-disk entry.
      entry.ignoreUpstreamUpdates = true;
      entry.ignoreUpstreamUpdatesReason = input.reason;
      entry.ignoreUpstreamUpdatesSetAt = now;
      await mapping.save();
      return {
        slug: entry.slug,
        grantId,
        ignoreUpstreamUpdates: true,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        setAt: now,
      };
    }

    // enabled: false — clear the triad back to absent.
    if (!wasFlagged) {
      // Idempotent no-op against an unflagged entry. Skip the disk write so
      // the mapping file's mtime stays stable across no-op calls. Stamp
      // `setAt` with the call time so the output schema (which requires
      // `setAt`) has a defensible value.
      return {
        slug: entry.slug,
        grantId,
        ignoreUpstreamUpdates: false,
        setAt: now,
      };
    }

    // Retain the pre-clear `setAt` for the response so the operator can see
    // the audit timestamp of the flag we just removed. Post-save the on-disk
    // entry has no triad fields.
    entry.ignoreUpstreamUpdates = undefined;
    entry.ignoreUpstreamUpdatesReason = undefined;
    entry.ignoreUpstreamUpdatesSetAt = undefined;
    await mapping.save();
    return {
      slug: entry.slug,
      grantId,
      ignoreUpstreamUpdates: false,
      setAt: priorSetAt ?? now,
    };
  } finally {
    await lock.release();
  }
}
