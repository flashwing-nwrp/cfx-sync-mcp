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
 * Operator escape hatch. Drops the pristine baseline for one grant (or all
 * grants) and clears the matching pristine* fields on the state entry so the
 * next deploy is treated as a first-deploy (no Layer 2 diff).
 *
 * Layout:
 *   - `<stateDir>/pristine/<grantId>/`          — current pristine snapshot
 *   - `<stateDir>/pristine-history/<grantId>/`  — rollback-able snapshots
 *
 * Both trees are removed for the reset grants so future rollbacks don't
 * reference stale pristine data. Operator opted into "forget this baseline."
 *
 * {all: true} (or {}) also GCs orphan dirs — numeric-named pristine or
 * pristine-history dirs whose grantId is no longer in state. Transient
 * rotation artifacts (`.tmp.*`, `.old.*`) are left alone; those are handled
 * by `rotatePristine`'s self-heal on the next deploy.
 */
export async function cfx_reset_pristine(input: Input): Promise<Output> {
  const cfg = loadConfig();
  const pristineDir = path.join(cfg.stateDir, "pristine");
  const pristineHistoryDir = path.join(cfg.stateDir, "pristine-history");

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
      await removeGrantPristine(pristineDir, pristineHistoryDir, input.grantId);
      state.upsert({
        ...entry,
        pristineVersionId: null,
        pristineCapturedAt: null,
        pristineHashes: null,
      });
      await state.save();
      return { removed: [input.grantId], orphansGced: [] };
    }

    // {} or {all: true} — reset every state entry + GC orphans.
    const removed: number[] = [];
    const stateGrantIds: number[] = [];
    for (const entry of state.all()) {
      stateGrantIds.push(entry.grantId);
      await removeGrantPristine(pristineDir, pristineHistoryDir, entry.grantId);
      state.upsert({
        ...entry,
        pristineVersionId: null,
        pristineCapturedAt: null,
        pristineHashes: null,
      });
      removed.push(entry.grantId);
    }

    // After clearing all tracked grants, the state has zero pristine baselines
    // — any leftover numeric dir is either a pre-Phase-1.5 turd or a hand-
    // edited state leftover. Sweep both trees.
    const pristineOrphans = await detectOrphans(stateGrantIds, pristineDir);
    const historyOrphans = await detectOrphans(stateGrantIds, pristineHistoryDir);
    const orphanSet = new Set<number>([...pristineOrphans, ...historyOrphans]);
    const orphansGced = Array.from(orphanSet).sort((a, b) => a - b);

    for (const id of orphansGced) {
      await removeGrantPristine(pristineDir, pristineHistoryDir, id);
    }

    removed.sort((a, b) => a - b);
    await state.save();
    return { removed, orphansGced };
  } finally {
    await lock.release();
  }
}

/**
 * Remove `<pristineDir>/<grantId>/` and `<pristineHistoryDir>/<grantId>/`.
 * `force: true` suppresses ENOENT — both dirs may legitimately be absent
 * (fresh install, or grant never had a pristine captured).
 */
async function removeGrantPristine(
  pristineDir: string,
  pristineHistoryDir: string,
  grantId: number
): Promise<void> {
  await fsP.rm(path.join(pristineDir, String(grantId)), {
    recursive: true,
    force: true,
  });
  await fsP.rm(path.join(pristineHistoryDir, String(grantId)), {
    recursive: true,
    force: true,
  });
}
