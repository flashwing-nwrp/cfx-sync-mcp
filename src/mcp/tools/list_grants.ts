import type { z } from "zod";
import type { ListGrantsInput, ListGrantsOutput } from "../schemas/index.js";
import { loadConfig } from "../../lib/config.js";
import { CookieJar } from "../../lib/auth/cookieJar.js";
import { loadCookiesFromFile } from "../../lib/auth/fileAuth.js";
import { PortalApiClient } from "../../lib/portal/client.js";
import { RateLimitGate } from "../../lib/portal/rateLimit.js";
import { State } from "../../lib/state/state.js";
import { StateLock } from "../../lib/state/lock.js";

export async function cfx_list_grants(
  input: z.infer<typeof ListGrantsInput>
): Promise<z.infer<typeof ListGrantsOutput>> {
  const cfg = loadConfig();
  const state = new State(cfg.stateDir);
  await state.load();

  const gate = new RateLimitGate({ ttlMs: cfg.rateLimitTtlMs });
  const gateResult = gate.evaluate({
    callerId: "local",
    lastPolledAt: state.lastPolledAt("local"),
    force: input.force ?? false,
  });
  if (gateResult.decision === "STALE") {
    // Not an error — return cached state view. `assetName` comes from the
    // AssetState.assetName field (stored at download time by cfx_download_asset).
    return {
      grants: state.all().map((a) => ({
        grantId: a.grantId, assetName: a.assetName, author: "unknown",
        updatedAt: a.updatedAt, isDisabled: false,
      })),
      stale: true,
    };
  }

  const jar = new CookieJar();
  await loadCookiesFromFile(cfg.cookieFile, jar);
  const client = new PortalApiClient({ apiBase: cfg.apiBase, cookieJar: jar });
  const result = await client.listGrants({ search: input.search });

  // Acquire lock for the state write. Destructive tools (sync_all, download_asset,
  // deploy_asset) also acquire this lock; the lastPolledAt update must not race
  // with their state.save() calls.
  const lock = new StateLock(cfg.stateDir);
  await lock.acquire();
  try {
    // Re-load state inside the lock — another process may have updated it
    // between our initial load() and lock acquisition.
    await state.load();
    state.setLastPolledAt("local", new Date().toISOString());
    await state.save();
  } finally {
    await lock.release();
  }

  return {
    grants: result.grants.map((g) => ({
      grantId: g.grant_id, assetName: g.asset.name, author: g.asset.author,
      updatedAt: g.updated_at, isDisabled: g.asset.is_disabled,
    })),
    stale: false,
  };
}
