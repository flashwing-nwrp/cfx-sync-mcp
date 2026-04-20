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
import fs from "node:fs";
import { detectLayout } from "../../lib/discovery/detectLayout.js";
import { scanResources } from "../../lib/discovery/scanResources.js";
import { matchGrants } from "../../lib/discovery/matchGrants.js";
import { applyAuthorPrefixBoost, type BoostedCandidate } from "../../lib/discovery/prefixBoost.js";

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const w = n + 1;
  const dp = new Uint32Array((m + 1) * w);
  for (let i = 0; i <= m; i++) dp[i * w] = i;
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i * w + j] = Math.min(
        dp[(i - 1) * w + j]! + 1,
        dp[i * w + (j - 1)]! + 1,
        dp[(i - 1) * w + (j - 1)]! + cost,
      );
    }
  }
  return dp[m * w + n]!;
}
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

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
      // Remap-over guard: if this entry was already reviewed, require confirmation.
      if (currentEntry?.reviewedByUser === true) {
        const expected = currentEntry.target ? path.basename(currentEntry.target) : "";
        if (!input.allowRemapOver || input.allowRemapOver.toLowerCase() !== expected.toLowerCase()) {
          return fail("remap-requires-confirmation", { expectedBasename: expected });
        }
      }

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

    // -----------------------------------------------------------------------
    // override — fuzzy-match overrideInput against scanned resources and
    // commit if exactly one folder scores ≥0.9.
    // -----------------------------------------------------------------------
    if (input.action === "override") {
      if (input.overrideInput === undefined) return fail("unexpected-field");
      if (!grant) return fail("grantId-not-owned");

      // Enumerate all subdirectories (and category subdirectories for categorized
      // layouts) regardless of fxmanifest presence, so bare/pending folders are
      // also reachable via override.
      const allFolderPaths: string[] = [];
      const addDirsFrom = (root: string) => {
        try {
          for (const e of fs.readdirSync(root, { withFileTypes: true })) {
            if (!e.isDirectory() || e.isSymbolicLink()) continue;
            allFolderPaths.push(path.join(root, e.name));
          }
        } catch { /* ignore unreadable dirs */ }
      };
      // Try to detect layout; if unknown, treat the root itself as the flat root.
      try {
        const layout = detectLayout(cfg.serverResources);
        if (layout === "categorized") {
          for (const e of fs.readdirSync(cfg.serverResources, { withFileTypes: true })) {
            if (e.isDirectory() && e.name.startsWith("[") && e.name.endsWith("]")) {
              addDirsFrom(path.join(cfg.serverResources, e.name));
            }
          }
        } else {
          addDirsFrom(cfg.serverResources);
        }
      } catch {
        // UnknownLayoutError — fall back to treating root as flat.
        addDirsFrom(cfg.serverResources);
      }

      // Fuzzy-match overrideInput against every folder path.
      const normalize = (s: string): string =>
        s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      const target = normalize(input.overrideInput);
      const scored = allFolderPaths.map((p) => {
        const sim = similarity(target, normalize(path.basename(p)));
        return { target: p, similarity: sim };
      });
      scored.sort((a, b) => b.similarity - a.similarity);
      const hits = scored.filter((s) => s.similarity >= 0.9);
      if (hits.length !== 1) {
        return {
          committed: false, entry: null, remainingUnresolvedCount: -1,
          overrideAmbiguous: {
            input: input.overrideInput,
            candidates: scored.slice(0, 5),
          },
        };
      }
      const chosen = hits[0]!;

      // Target ownership guard
      for (const [otherK, otherV] of Object.entries(mapping.entries())) {
        if (Number(otherK) !== input.grantId
            && otherV.status === "active"
            && otherV.target === chosen.target) {
          return fail("target-owned-by-other-grant", { ownedBy: Number(otherK) });
        }
      }

      // Remap guard
      if (currentEntry?.reviewedByUser === true) {
        const expected = currentEntry.target ? path.basename(currentEntry.target) : "";
        if (!input.allowRemapOver || input.allowRemapOver.toLowerCase() !== expected.toLowerCase()) {
          return fail("remap-requires-confirmation", { expectedBasename: expected });
        }
      }

      const isRemap = currentEntry?.reviewedByUser === true;
      const slug = currentEntry?.slug ?? grant.asset.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      const entry: MappingEntry = {
        slug, target: chosen.target, assetName: grant.asset.name,
        discoveredTier: 0, discoveredConfidence: chosen.similarity,
        preservePaths: null, preservePathsSource: null,
        ignoreUpstreamUpdates: currentEntry?.ignoreUpstreamUpdates,
        ignoreUpstreamUpdatesReason: currentEntry?.ignoreUpstreamUpdatesReason,
        ignoreUpstreamUpdatesSetAt: currentEntry?.ignoreUpstreamUpdatesSetAt,
        status: "active", reviewedByUser: true,
      };
      mapping.setEntry(input.grantId, entry);
      mappingFile.newInstalls = (mappingFile.newInstalls ?? []).filter((g) => g !== input.grantId);
      await mapping.save();
      await log.append({
        ts: new Date().toISOString(), grantId: input.grantId,
        author: grant.asset.author ?? null, assetName: grant.asset.name,
        action: isRemap ? "remap" : "override",
        tierBefore: currentEntry?.discoveredTier ?? null,
        confidenceBefore: currentEntry?.discoveredConfidence ?? null,
        chosenBasename: path.basename(chosen.target), overrideInput: input.overrideInput,
      });
      return {
        committed: true, entry, remainingUnresolvedCount: -1,
        overrideResolved: { input: input.overrideInput, matchedTarget: chosen.target, similarity: chosen.similarity },
      };
    }

    // -----------------------------------------------------------------------
    // reactivate — flip status from 'new-install' back to 'active', clear reviewedByUser.
    // -----------------------------------------------------------------------
    if (input.action === "reactivate") {
      if (!currentEntry) return fail("reactivate-invalid-state");
      if (currentEntry.status !== "new-install") return fail("reactivate-invalid-state");
      const entry: MappingEntry = {
        ...currentEntry,
        status: "active",
        reviewedByUser: false,
        target: currentEntry.target || "",  // caller is expected to run override next
      };
      mapping.setEntry(input.grantId, entry);
      await mapping.save();
      await log.append({
        ts: new Date().toISOString(), grantId: input.grantId,
        author: grant?.asset.author ?? null, assetName: entry.assetName,
        action: "reactivate",
        tierBefore: null, confidenceBefore: null, chosenBasename: null, overrideInput: null,
      });
      return { committed: true, entry, remainingUnresolvedCount: -1 };
    }

    return fail("unexpected-field");
  } finally {
    await lock.release();
  }
}
