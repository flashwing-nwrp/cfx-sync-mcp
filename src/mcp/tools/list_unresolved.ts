import type { z } from "zod";
import type { ListUnresolvedInput, ListUnresolvedOutput } from "../schemas/index.js";
import { loadConfig } from "../../lib/config.js";
import { Mapping } from "../../lib/state/mapping.js";
import { CookieJar } from "../../lib/auth/cookieJar.js";
import { loadCookiesFromFile } from "../../lib/auth/fileAuth.js";
import { PortalApiClient } from "../../lib/portal/client.js";
import { detectLayout } from "../../lib/discovery/detectLayout.js";
import { scanResources, type ResourceMeta } from "../../lib/discovery/scanResources.js";
import { matchGrants } from "../../lib/discovery/matchGrants.js";
import { applyAuthorPrefixBoost } from "../../lib/discovery/prefixBoost.js";

export async function cfx_list_unresolved(
  _input: z.infer<typeof ListUnresolvedInput>
): Promise<z.infer<typeof ListUnresolvedOutput>> {
  const cfg = loadConfig();
  const mapping = new Mapping(cfg.stateDir);
  await mapping.load();

  if (!mapping.isApproved()) {
    return {
      unresolved: [],
      suspicious: [],
      summary: { unresolvedCount: 0, suspiciousCount: 0, autoApprovedCount: 0 },
      notice: "run cfx_discover first — no approved mapping on disk",
    };
  }

  // Suspicious bucket: active entries committed at tier >= 3 with reviewedByUser=false.
  const entries = mapping.entries();
  const suspicious: z.infer<typeof ListUnresolvedOutput>["suspicious"] = [];
  for (const [k, v] of Object.entries(entries)) {
    if (v.status === "active" && v.discoveredTier >= 3 && v.reviewedByUser === false) {
      suspicious.push({
        grantId: Number(k),
        assetName: v.assetName,
        currentTarget: v.target,
        tierAtCommit: v.discoveredTier,
        confidenceAtCommit: v.discoveredConfidence,
      });
    }
  }

  // Unresolved bucket: newInstalls + reactivated new-install entries + name-collisions.
  const mappingFile = mapping.getFile();
  const newInstallIds = new Set(mappingFile.newInstalls ?? []);

  // Fetch grants (needed for assetName/author + name-collision detection).
  const jar = new CookieJar();
  try {
    await loadCookiesFromFile(cfg.cookieFile, jar);
  } catch {
    // Cookie file missing or invalid — proceed without auth; portal fetch will fail below.
  }
  const client = new PortalApiClient({ apiBase: cfg.apiBase, cookieJar: jar });
  let grants: Array<{ grant_id: number; asset: { name: string; author: string } }> = [];
  try {
    const r = await client.listGrants({});
    grants = r.grants as Array<{ grant_id: number; asset: { name: string; author: string } }>;
  } catch {
    // Portal unreachable — unresolved bucket may be incomplete; surface a notice below.
  }
  const grantById = new Map(grants.map((g) => [g.grant_id, g]));

  // Resource scan for reactivation detection + alternative generation.
  let resources: ResourceMeta[] = [];
  try {
    const layout = detectLayout(cfg.serverResources);
    resources = scanResources(cfg.serverResources, layout);
  } catch {
    // Directory has unusual layout or is empty — proceed with empty resources.
  }

  const unresolved: z.infer<typeof ListUnresolvedOutput>["unresolved"] = [];

  // a) newInstalls: grants owned but never installed (or name-collisions).
  for (const gid of newInstallIds) {
    const g = grantById.get(gid);
    if (!g) continue; // stale — grant revoked or portal unreachable

    // Name-collision detection: does any active entry share this assetName?
    let collidesWith: { grantId: number; target: string } | undefined;
    for (const [otherK, otherV] of Object.entries(entries)) {
      if (
        Number(otherK) !== gid &&
        otherV.status === "active" &&
        otherV.assetName === g.asset.name
      ) {
        collidesWith = { grantId: Number(otherK), target: otherV.target };
        break;
      }
    }

    unresolved.push({
      grantId: gid,
      assetName: g.asset.name,
      author: g.asset.author ?? null,
      proposed: null,
      alternatives: [],
      reason: collidesWith ? "name-collision" : "new-install",
      ...(collidesWith ? { collidesWith } : {}),
    });
  }

  // b) Reactivated new-install entries whose resource now exists on disk.
  for (const [k, v] of Object.entries(entries)) {
    if (v.status !== "new-install") continue;
    const gid = Number(k);
    const g = grantById.get(gid);
    if (!g) continue;

    // Run matcher against current resource scan for this single grant.
    const matchRes = matchGrants(
      [{ grant_id: gid, asset: g.asset } as Parameters<typeof matchGrants>[0][0]],
      resources
    );
    const match = matchRes.matches[0];
    if (match) {
      const alts = applyAuthorPrefixBoost(
        [
          { target: match.matchedPath, tier: match.matchTier, confidence: match.confidence },
          ...match.alternatives.map((a) => ({
            target: a.path,
            tier: a.tier,
            confidence: a.confidence,
          })),
        ],
        g.asset.author
      );
      unresolved.push({
        grantId: gid,
        assetName: g.asset.name,
        author: g.asset.author ?? null,
        proposed: {
          target: alts[0]!.target,
          tier: alts[0]!.tier,
          confidence: alts[0]!.confidence,
        },
        alternatives: alts.slice(1),
        reason: "reactivated",
      });
    }
    // If matcher still finds nothing, entry stays new-install (not surfaced here).
  }

  return {
    unresolved,
    suspicious,
    summary: {
      unresolvedCount: unresolved.length,
      suspiciousCount: suspicious.length,
      autoApprovedCount: Object.values(entries).filter(
        (e) => e.status === "active" && e.reviewedByUser === true
      ).length,
    },
  };
}
