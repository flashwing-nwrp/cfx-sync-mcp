import type { z } from "zod";
import type {
  ApproveMappingInput,
  ApproveMappingOutput,
} from "../schemas/index.js";
import { loadConfig } from "../../lib/config.js";
import { Mapping } from "../../lib/state/mapping.js";
import { StateLock } from "../../lib/state/lock.js";
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
    mapping.approveFromProposed(input.proposed.entries);
    await mapping.save();
    return {
      path: path.join(cfg.stateDir, "cfx-sync-map.json"),
      entriesCount: Object.keys(input.proposed.entries).length,
    };
  } finally {
    await lock.release();
  }
}
