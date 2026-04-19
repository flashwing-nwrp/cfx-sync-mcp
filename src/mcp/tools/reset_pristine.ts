import type { z } from "zod";
import fsP from "node:fs/promises";
import path from "node:path";
import type {
  ResetPristineInput,
  ResetPristineOutput,
} from "../schemas/index.js";
import { loadConfig } from "../../lib/config.js";
import { State } from "../../lib/state/state.js";
import { StateLock } from "../../lib/state/lock.js";
import { detectOrphans } from "../../lib/pristine/gc.js";
import { NotFoundError } from "../../lib/errors.js";

type Input = z.infer<typeof ResetPristineInput>;
type Output = z.infer<typeof ResetPristineOutput>;

/**
 * Operator escape hatch. Drops the CURRENT pristine baseline for one grant
 * (or all grants) and clears the matching pristine* fields on the state entry
 * so the next deploy is treated as a first-deploy (no Layer 2 diff).
 *
 * Layout touched:
 *   - `<stateDir>/pristine/<grantId>/` — removed.
 *
 * Pristine-history is intentionally preserved so older backups remain
 * rollback-able. Task 16's `cfx_rollback` uses `pristineVersionIdAtBackupTime`
 * from the backup manifest to locate `<stateDir>/pristine-history/<grantId>/<v>/`
 * and restore that baseline. Use `cfx_rollback` to restore an older pristine
 * baseline explicitly.
 *
 * {all: true} (or {}) also GCs orphan pristine dirs — numeric-named subdirs
 * of `pristine/` whose grantId is no longer in state. Transient rotation
 * artifacts (`.tmp.*`, `.old.*`) are left alone; those are handled by
 * `rotatePristine`'s self-heal on the next deploy. Pristine-history is NOT
 * swept here — rollback-able snapshots outlive state entries by design.
 */
export async function cfx_reset_pristine(input: Input): Promise<Output> {
  const cfg = loadConfig();
  const pristineDir = path.join(cfg.stateDir, "pristine");

  const lock = new StateLock(cfg.stateDir);
  await lock.acquire();
  try {
    const state = new State(cfg.stateDir);
    await state.load();

    if (input.grantId !== undefined) {
      const entry = state.get(input.grantId);
      if (!entry) {
        throw new NotFoundError(
          `Grant ${input.grantId} not found in state.json; nothing to reset.`
        );
      }
      await removeGrantPristine(pristineDir, input.grantId);
      state.upsert({
        ...entry,
        pristineVersionId: null,
        pristineCapturedAt: null,
        pristineHashes: null,
      });
      await state.save();
      return { removed: [input.grantId], orphansGced: [] };
    }

    // {} or {all: true} — reset every state entry + GC orphan pristine dirs.
    const removed: number[] = [];
    const stateGrantIds: number[] = [];
    for (const entry of state.all()) {
      stateGrantIds.push(entry.grantId);
      await removeGrantPristine(pristineDir, entry.grantId);
      state.upsert({
        ...entry,
        pristineVersionId: null,
        pristineCapturedAt: null,
        pristineHashes: null,
      });
      removed.push(entry.grantId);
    }

    // After clearing all tracked grants, any leftover numeric pristine dir is
    // a pre-Phase-1.5 turd or a hand-edited state leftover — sweep it. Do NOT
    // touch pristine-history; rollback may still need those snapshots.
    const orphansGced = await detectOrphans(stateGrantIds, pristineDir);
    for (const id of orphansGced) {
      await removeGrantPristine(pristineDir, id);
    }

    removed.sort((a, b) => a - b);
    await state.save();
    return { removed, orphansGced };
  } finally {
    await lock.release();
  }
}

/**
 * Remove `<pristineDir>/<grantId>/`. `force: true` suppresses ENOENT — the
 * dir may legitimately be absent (fresh install, or grant never had a
 * pristine captured).
 *
 * NOTE: pristine-history/<grantId>/ is deliberately NOT removed — rollback
 * relies on those snapshots via the backup manifest's
 * `pristineVersionIdAtBackupTime`. See the tool-level doc above.
 */
async function removeGrantPristine(
  pristineDir: string,
  grantId: number
): Promise<void> {
  await fsP.rm(path.join(pristineDir, String(grantId)), {
    recursive: true,
    force: true,
  });
}
