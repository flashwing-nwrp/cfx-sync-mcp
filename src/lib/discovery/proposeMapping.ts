import type { MatchGrantsResult } from "./matchGrants.js";
import type { Grant } from "../portal/types.js";
import type { MappingEntry } from "../state/mapping.js";

export interface ProposedMappingJson {
  version: 1;
  generatedAt: string;
  entries: Record<string, MappingEntry>;
  newInstalls: number[];
  orphaned: string[];
  caveats: string[];
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
}

export function proposeMapping(match: MatchGrantsResult, grants: Grant[]): ProposedMappingJson {
  const byId = new Map<number, Grant>(grants.map((g) => [g.grant_id, g]));
  const entries: Record<string, MappingEntry> = {};
  for (const m of match.matches) {
    const g = byId.get(m.grantId);
    if (!g) continue;
    entries[String(m.grantId)] = {
      slug: slugify(g.asset.name),
      target: m.matchedPath,
      disabled: false,
      assetName: g.asset.name,
      discoveredTier: m.matchTier,
      discoveredConfidence: m.confidence,
    };
  }
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries,
    newInstalls: match.newInstalls,
    orphaned: match.orphaned,
    caveats: [
      // NOTE: the first entry is intentionally terse — tests match on this exact prefix string.
      // The follow-up sentence provides actionable guidance for human operators.
      "Grants pre-dating the 2025-10-15 portal migration",
      "may not be visible via this API — check the portal UI for any assets not listed here.",
    ],
  };
}
