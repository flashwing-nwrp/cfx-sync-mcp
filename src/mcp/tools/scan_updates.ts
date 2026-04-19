/**
 * cfx_scan_updates — Phase 1.6 Task 10.
 *
 * Thin MCP tool that composes the pure pieces built in Tasks 7–9:
 *  - `PATTERNS` registry (Task 7) — per-author log notice parsers
 *  - `parseNotices` (Task 8) — walker over raw log lines
 *  - `scanUpdates` (Task 9) — merge + 4-bucket output
 *
 * ### Adapter strategy
 *
 * Scanner's `CheckUpdatesFn` contract is intentionally richer than
 * `cfx_check_updates`'s public output: it wants `updatedAt` + `versionId` on
 * each row so it can resolve "announced" version strings when no log signal
 * fired. Rather than widen the neighboring tool's output shape (which would
 * break backwards compat with consumers keyed on `{updated, stale}`), we
 * inline the ~25 lines of "rate-limit gate → list grants → diff vs state"
 * logic here. `cfx_check_updates` and `cfx_scan_updates` remain decoupled.
 *
 * ### Open-source boundary
 *
 * No outbound MCP calls. The tool depends only on:
 *  - lib/** (pure logic + portal client + state)
 *  - ../schemas/index.js (same tree)
 *
 * Enforced by a static import-grep unit test in
 * tests/unit/mcp/scan_updates.test.ts.
 *
 * ### portalFromCache semantics
 *
 * The rate-limit gate either (a) short-circuits (`STALE` decision — we did
 * NOT poll, output comes from local state) or (b) passes through to a fresh
 * portal call (`FRESH` decision — we polled). There is no "network hit
 * but filled from CDN cache" middle path in Phase 1.6, so:
 *    portalFromCache ⇔ !portalPolled ⇔ gate decision was STALE
 * Future phases (persistent HTTP cache) may need to split these, but v0.3.0
 * conflates them.
 */

import type { z } from "zod";
import type { ScanUpdatesInput, ScanUpdatesOutput } from "../schemas/index.js";
import { loadConfig } from "../../lib/config.js";
import { CookieJar } from "../../lib/auth/cookieJar.js";
import { loadCookiesFromFile } from "../../lib/auth/fileAuth.js";
import { PortalApiClient } from "../../lib/portal/client.js";
import { RateLimitGate } from "../../lib/portal/rateLimit.js";
import { State } from "../../lib/state/state.js";
import { Mapping } from "../../lib/state/mapping.js";
import { StateLock } from "../../lib/state/lock.js";
import { scanUpdates } from "../../lib/updates/scanner.js";
import type { CheckUpdatesResult } from "../../lib/updates/scanner.js";
import { parseNotices } from "../../lib/updates/logScraper.js";
import { PATTERNS } from "../../lib/updates/patterns/index.js";
import {
  AuthExpiredError,
  AuthMissingError,
  NetworkError,
  PortalRateLimitError,
  ForbiddenError,
} from "../../lib/errors.js";

/**
 * Mirror of the slugify helper used by cfx_check_updates and cfx_discover —
 * kept in-sync by copy because the three tools all normalize
 * `grant.asset.name` to a canonical slug the same way.
 */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
}

/**
 * Graceful-degradation wrapper around a portal-fetch operation. On expected
 * auth / connectivity / rate-limit errors, returns a sentinel that tells the
 * scanner "portal signal unavailable — proceed with log signal only"
 * (`{updated: [], stale: true, portalFromCache: true}`). Other errors
 * propagate unchanged — we don't want to silently swallow genuine bugs.
 *
 * Exposed (not exported from the package entry, but reachable by tests in
 * the same tree) so the try/catch branch can be unit-tested in isolation
 * without mocking the full PortalApiClient.
 *
 * @param fetchFn thunk that performs the portal fetch and returns the
 *   successful `CheckUpdatesResult`. Thrown errors are inspected here.
 */
export async function adaptPortalFetch(
  fetchFn: () => Promise<CheckUpdatesResult>
): Promise<CheckUpdatesResult> {
  try {
    return await fetchFn();
  } catch (err) {
    if (
      err instanceof AuthExpiredError ||
      err instanceof AuthMissingError ||
      err instanceof NetworkError ||
      err instanceof PortalRateLimitError ||
      err instanceof ForbiddenError
    ) {
      // Graceful degradation: portal signal unavailable (expired cookies, no
      // cookies yet, transient network, rate limit, revoked grant). The
      // scanner is happy to proceed with log signal only. Surfaces as
      // portalPolled:false / portalFromCache:true in the scanner output, so
      // operators know to re-authenticate if they need portal signal.
      return { updated: [], stale: true, portalFromCache: true };
    }
    throw err;
  }
}

export async function cfx_scan_updates(
  input: z.infer<typeof ScanUpdatesInput>
): Promise<z.infer<typeof ScanUpdatesOutput>> {
  const cfg = loadConfig();

  const state = new State(cfg.stateDir);
  await state.load();

  const mapping = new Mapping(cfg.stateDir);
  await mapping.load();

  const gate = new RateLimitGate({ ttlMs: cfg.rateLimitTtlMs });
  const gateResult = gate.evaluate({
    callerId: "local",
    lastPolledAt: state.lastPolledAt("local"),
    force: input.forcePortal ?? false,
  });

  /**
   * Adapter that produces the shape scanner wants from the portal + state.
   * See module JSDoc "Adapter strategy" for why this isn't a call to
   * cfx_check_updates.
   *
   * ### Graceful degradation
   *
   * Expected portal-fetch failures (expired cookies, missing cookie file,
   * transient network, rate limit, revoked grant) do NOT throw — they fall
   * through `adaptPortalFetch` into `{updated:[], stale:true,
   * portalFromCache:true}` so the scanner can still process log signal.
   * The state-save (lastPolledAt) runs ONLY on successful poll, keeping the
   * rate-limit gate honest: a failed fetch isn't counted as a poll.
   * Unexpected errors (filesystem corruption, schema bugs) still propagate.
   */
  const checkUpdatesFn = async (_opts: { force: boolean }): Promise<CheckUpdatesResult> => {
    if (gateResult.decision === "STALE") {
      // Gate says "too recent to poll" — short-circuit, no network hit.
      return { updated: [], stale: true, portalFromCache: true };
    }

    return await adaptPortalFetch(async () => {
      const jar = new CookieJar();
      await loadCookiesFromFile(cfg.cookieFile, jar);
      const client = new PortalApiClient({ apiBase: cfg.apiBase, cookieJar: jar });
      const { grants } = await client.listGrants({});

      // Persist the poll timestamp. Match cfx_check_updates' lock-acquire +
      // reload-inside-lock ordering so we don't race other destructive tools.
      // Only reached on a successful portal fetch — failed polls must NOT
      // bump lastPolledAt or the rate-limit gate would suppress retries.
      const lock = new StateLock(cfg.stateDir);
      await lock.acquire();
      try {
        await state.load();
        state.setLastPolledAt("local", new Date().toISOString());
        await state.save();
      } finally {
        await lock.release();
      }

      const updated: CheckUpdatesResult["updated"] = [];
      for (const g of grants) {
        if (g.asset.is_disabled) continue;
        if (mapping.isApproved() && mapping.isDisabled(g.grant_id)) continue;
        const local = state.get(g.grant_id);
        const needsUpdate = local === undefined || g.updated_at > local.updatedAt;
        if (!needsUpdate) continue;
        // Take the newest version per list_grants ordering convention (the
        // grants endpoint sorts versions descending by id — same assumption
        // made in download_asset.ts).
        const version = g.asset.versions[0];
        const row: CheckUpdatesResult["updated"][number] = {
          grantId: g.grant_id,
          slug: slugify(g.asset.name),
          assetName: g.asset.name,
          updatedAt: g.updated_at,
        };
        if (version !== undefined) row.versionId = version.id;
        updated.push(row);
      }

      return { updated, stale: false, portalFromCache: false };
    });
  };

  return await scanUpdates({
    slug: input.slug,
    grantId: input.grantId,
    logLines: input.logLines,
    forcePortal: input.forcePortal,
    state,
    mapping: mapping.getFile(),
    patterns: PATTERNS,
    checkUpdatesFn,
    parseNoticesFn: parseNotices,
  });
}
