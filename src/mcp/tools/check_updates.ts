import type { z } from "zod";
import type { CheckUpdatesInput, CheckUpdatesOutput } from "../schemas/index.js";
import { loadConfig } from "../../lib/config.js";
import { CookieJar } from "../../lib/auth/cookieJar.js";
import { loadCookiesFromFile } from "../../lib/auth/fileAuth.js";
import { PortalApiClient } from "../../lib/portal/client.js";
import { RateLimitGate } from "../../lib/portal/rateLimit.js";
import { State } from "../../lib/state/state.js";
import { Mapping } from "../../lib/state/mapping.js";
import { StateLock } from "../../lib/state/lock.js";

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
}

export async function cfx_check_updates(
  input: z.infer<typeof CheckUpdatesInput>
): Promise<z.infer<typeof CheckUpdatesOutput>> {
  const cfg = loadConfig();
  const state = new State(cfg.stateDir);
  await state.load();
  const mapping = new Mapping(cfg.stateDir);
  await mapping.load();

  const gate = new RateLimitGate({ ttlMs: cfg.rateLimitTtlMs });
  const gateResult = gate.evaluate({
    callerId: "local",
    lastPolledAt: state.lastPolledAt("local"),
    force: input.force ?? false,
  });

  let updated: z.infer<typeof CheckUpdatesOutput>["updated"] = [];
  let stale = false;

  if (gateResult.decision === "STALE") {
    stale = true;
  } else {
    const jar = new CookieJar();
    await loadCookiesFromFile(cfg.cookieFile, jar);
    const client = new PortalApiClient({ apiBase: cfg.apiBase, cookieJar: jar });
    const { grants } = await client.listGrants({});

    // Acquire lock for state.save() — prevents race with concurrent destructive tools.
    const lock = new StateLock(cfg.stateDir);
    await lock.acquire();
    try {
      await state.load();
      state.setLastPolledAt("local", new Date().toISOString());
      await state.save();
    } finally {
      await lock.release();
    }

    for (const g of grants) {
      if (g.asset.is_disabled) continue;
      if (mapping.isApproved() && mapping.isDisabled(g.grant_id)) continue;
      const local = state.get(g.grant_id);
      const needsUpdate = !local || g.updated_at > local.updatedAt;
      if (needsUpdate) {
        updated.push({
          grantId: g.grant_id,
          slug: slugify(g.asset.name),
          assetName: g.asset.name,
          reason: local ? "version_bump" : "never_deployed",
        });
      }
    }
  }

  return { updated, stale };
}
