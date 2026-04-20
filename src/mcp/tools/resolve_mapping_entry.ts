import type { z } from "zod";
import path from "node:path";
import type { ResolveMappingEntryInput, ResolveMappingEntryOutput } from "../schemas/index.js";
import { loadConfig } from "../../lib/config.js";
import { Mapping, type MappingEntry } from "../../lib/state/mapping.js";
import { StateLock } from "../../lib/state/lock.js";
import { ResolutionLog } from "../../lib/state/resolutionLog.js";
import { CookieJar } from "../../lib/auth/cookieJar.js";
import { loadCookiesFromFile } from "../../lib/auth/fileAuth.js";
import { PortalApiClient } from "../../lib/portal/client.js";
import { detectLayout } from "../../lib/discovery/detectLayout.js";
import { scanResources } from "../../lib/discovery/scanResources.js";
import { matchGrants } from "../../lib/discovery/matchGrants.js";
import { applyAuthorPrefixBoost, type BoostedCandidate } from "../../lib/discovery/prefixBoost.js";

type ToolOutput = z.infer<typeof ResolveMappingEntryOutput>;

function fail(error: NonNullable<ToolOutput["error"]>, extra: Partial<ToolOutput> = {}): ToolOutput {
  return { committed: false, entry: null, remainingUnresolvedCount: -1, error, ...extra };
}

/**
 * Validates that extra fields are not present for the given action.
 * Returns the offending field name, or null if all fields are valid.
 */
function validateFieldsForAction(input: z.infer<typeof ResolveMappingEntryInput>): string | null {
  const { action, pickIndex, overrideInput, allowRemapOver } = input;
  if (action !== "pick" && pickIndex !== undefined) return "pickIndex";
  if (action !== "override" && overrideInput !== undefined) return "overrideInput";
  if (!(action === "pick" || action === "override") && allowRemapOver !== undefined) return "allowRemapOver";
  return null;
}

export async function cfx_resolve_mapping_entry(
  input: z.infer<typeof ResolveMappingEntryInput>
): Promise<ToolOutput> {
  const badField = validateFieldsForAction(input);
  if (badField) return fail("unexpected-field");

  const cfg = loadConfig();
  const lock = new StateLock(cfg.stateDir);
  await lock.acquire();
  try {
    const mapping = new Mapping(cfg.stateDir);
    await mapping.load();
    if (!mapping.isApproved()) return fail("grantId-not-owned");

    const log = new ResolutionLog(cfg.stateDir);
    const mappingFile = mapping.getFile();
    const currentEntry = mapping.get(input.grantId);

    // Fetch fresh grant info for assetName/author + owned-grant verification.
    const jar = new CookieJar();
    try { await loadCookiesFromFile(cfg.cookieFile, jar); }
    catch (err) { console.warn("[cfx_resolve_mapping_entry] cookie load failed:", (err as Error).message); }
    const client = new PortalApiClient({ apiBase: cfg.apiBase, cookieJar: jar });
    let grants: { grant_id: number; asset: { name: string; author: string } }[] = [];
    try { grants = (await client.listGrants({})).grants as any; }
    catch (err) { console.warn("[cfx_resolve_mapping_entry] listGrants failed:", (err as Error).message); }
    const grant = grants.find((g) => g.grant_id === input.grantId);

    // -----------------------------------------------------------------------
    // skip — no-op, just log and return.
    // -----------------------------------------------------------------------
    if (input.action === "skip") {
      await log.append({
        ts: new Date().toISOString(),
        grantId: input.grantId,
        author: grant?.asset.author ?? null,
        assetName: grant?.asset.name ?? currentEntry?.assetName ?? "",
        action: "skip",
        tierBefore: currentEntry?.discoveredTier ?? null,
        confidenceBefore: currentEntry?.discoveredConfidence ?? null,
        chosenBasename: null,
        overrideInput: null,
      });
      return { committed: false, entry: null, remainingUnresolvedCount: -1 };
    }

    // -----------------------------------------------------------------------
    // new-install — mark grant as a fresh install (no target folder yet).
    // -----------------------------------------------------------------------
    if (input.action === "new-install") {
      if (!grant) return fail("grantId-not-owned");
      const slug = grant.asset.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      const entry: MappingEntry = {
        slug,
        target: "",
        assetName: grant.asset.name,
        discoveredTier: 0,
        discoveredConfidence: 0,
        status: "new-install",
        reviewedByUser: true,
      };
      mapping.setEntry(input.grantId, entry);
      // Remove from the newInstalls queue now that it has been resolved.
      mappingFile.newInstalls = (mappingFile.newInstalls ?? []).filter((g) => g !== input.grantId);
      await mapping.save();
      await log.append({
        ts: new Date().toISOString(),
        grantId: input.grantId,
        author: grant.asset.author ?? null,
        assetName: grant.asset.name,
        action: "new-install",
        tierBefore: null,
        confidenceBefore: null,
        chosenBasename: null,
        overrideInput: null,
      });
      return { committed: true, entry, remainingUnresolvedCount: -1 };
    }

    // -----------------------------------------------------------------------
    // accept — flip reviewedByUser=true on an existing entry.
    // -----------------------------------------------------------------------
    if (input.action === "accept") {
      if (!currentEntry) return fail("no-proposal-to-accept");
      const updated: MappingEntry = { ...currentEntry, reviewedByUser: true };
      mapping.setEntry(input.grantId, updated);
      await mapping.save();
      await log.append({
        ts: new Date().toISOString(),
        grantId: input.grantId,
        author: grant?.asset.author ?? null,
        assetName: updated.assetName,
        action: "accept",
        tierBefore: updated.discoveredTier,
        confidenceBefore: updated.discoveredConfidence,
        chosenBasename: updated.target ? path.basename(updated.target) : null,
        overrideInput: null,
      });
      return { committed: true, entry: updated, remainingUnresolvedCount: -1 };
    }

    // -----------------------------------------------------------------------
    // pick — select an alternative from the re-ranked candidate list.
    // -----------------------------------------------------------------------
    if (input.action === "pick") {
      if (input.pickIndex === undefined) return fail("pick-index-out-of-range");
      if (!grant) return fail("grantId-not-owned");

      let resources: ReturnType<typeof scanResources> = [];
      try {
        const layout = detectLayout(cfg.serverResources);
        resources = scanResources(cfg.serverResources, layout);
      } catch (err) {
        // Empty or unusual layout — treat as no candidates found.
        console.warn("[cfx_resolve_mapping_entry] resource scan failed:", (err as Error).message);
      }
      const matchRes = matchGrants(
        [{ grant_id: input.grantId, asset: grant.asset } as any],
        resources,
      );
      const match = matchRes.matches[0];
      if (!match) return fail("pick-index-out-of-range");

      const alts: BoostedCandidate[] = applyAuthorPrefixBoost(
        [
          { target: match.matchedPath, tier: match.matchTier, confidence: match.confidence },
          ...match.alternatives.map((a) => ({ target: a.path, tier: a.tier, confidence: a.confidence })),
        ],
        grant.asset.author,
      );
      if (input.pickIndex >= alts.length) return fail("pick-index-out-of-range");
      const chosen = alts[input.pickIndex]!;

      // Remap-over guard: if this entry was already reviewed, require confirmation.
      if (currentEntry?.reviewedByUser === true) {
        const expected = currentEntry.target ? path.basename(currentEntry.target) : "";
        if (!input.allowRemapOver || input.allowRemapOver.toLowerCase() !== expected.toLowerCase()) {
          return fail("remap-requires-confirmation", { expectedBasename: expected });
        }
      }

      const isRemap = currentEntry?.reviewedByUser === true;
      const slug =
        currentEntry?.slug ??
        grant.asset.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      const entry: MappingEntry = {
        slug,
        target: chosen.target,
        assetName: grant.asset.name,
        discoveredTier: chosen.tier,
        discoveredConfidence: chosen.confidence,
        preservePaths: null,
        preservePathsSource: null,
        ignoreUpstreamUpdates: currentEntry?.ignoreUpstreamUpdates,
        ignoreUpstreamUpdatesReason: currentEntry?.ignoreUpstreamUpdatesReason,
        ignoreUpstreamUpdatesSetAt: currentEntry?.ignoreUpstreamUpdatesSetAt,
        status: "active",
        reviewedByUser: true,
      };
      mapping.setEntry(input.grantId, entry);
      mappingFile.newInstalls = (mappingFile.newInstalls ?? []).filter((g) => g !== input.grantId);
      await mapping.save();
      await log.append({
        ts: new Date().toISOString(),
        grantId: input.grantId,
        author: grant.asset.author ?? null,
        assetName: grant.asset.name,
        action: isRemap ? "remap" : "pick",
        tierBefore: currentEntry?.discoveredTier ?? null,
        confidenceBefore: currentEntry?.discoveredConfidence ?? null,
        chosenBasename: path.basename(chosen.target),
        overrideInput: null,
      });
      return { committed: true, entry, remainingUnresolvedCount: -1 };
    }

    // override / reactivate implemented in follow-up tasks (11 + 12).
    return fail("unexpected-field");
  } finally {
    await lock.release();
  }
}
