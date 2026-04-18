import fs from "node:fs/promises";
import type { z } from "zod";
import type { StatusOutput } from "../schemas/index.js";
import { loadConfig } from "../../lib/config.js";
import { State } from "../../lib/state/state.js";
import { Mapping } from "../../lib/state/mapping.js";

export async function cfx_status(): Promise<z.infer<typeof StatusOutput>> {
  const cfg = loadConfig();
  let cookiesPresent = false;
  let cookieAgeMs: number | null = null;
  try {
    const stat = await fs.stat(cfg.cookieFile);
    cookiesPresent = true;
    cookieAgeMs = Date.now() - stat.mtime.getTime();
  } catch { /* no cookies */ }

  const state = new State(cfg.stateDir);
  await state.load();
  const mapping = new Mapping(cfg.stateDir);
  await mapping.load();

  return {
    cookiesPresent,
    cookieAgeMs,
    mappingApproved: mapping.isApproved(),
    deployedCount: state.all().filter((a) => a.deployedAt).length,
    lastPolledAt: state.lastPolledAt("local"),
  };
}
