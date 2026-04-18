import type { Grant } from "../portal/types.js";
import type { ResourceMeta } from "./scanResources.js";

const STOPWORDS = new Set([
  "system", "manager", "script", "core", "pro", "v2", "v3",
  "mod", "addon", "plus", "lite", "free", "premium",
]);

export interface MatchedGrant {
  grantId: number;
  matchedPath: string;
  matchTier: 1 | 2 | 3 | 4;
  confidence: number;
  alternatives: Array<{ path: string; confidence: number; tier: number }>;
}

export interface MatchGrantsResult {
  matches: MatchedGrant[];
  newInstalls: number[];   // grantIds with no match
  orphaned: string[];      // paths of .fxap resources not matched to any grant
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Use a single flat Uint32Array indexed as dp[i * (n+1) + j].
  // Avoids `noUncheckedIndexedAccess` pain of nested arrays (dp[i] would be
  // typed `number[] | undefined` forcing non-null assertions everywhere).
  const w = n + 1;
  const dp = new Uint32Array((m + 1) * w);
  for (let i = 0; i <= m; i++) dp[i * w] = i;
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = dp[(i - 1) * w + j]! + 1;
      const ins = dp[i * w + (j - 1)]! + 1;
      const sub = dp[(i - 1) * w + (j - 1)]! + cost;
      dp[i * w + j] = Math.min(del, ins, sub);
    }
  }
  return dp[m * w + n]!;
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

export function matchGrants(grants: Grant[], resources: ResourceMeta[]): MatchGrantsResult {
  const matches: MatchedGrant[] = [];
  const newInstalls: number[] = [];
  const consumedPaths = new Set<string>();

  // Deterministic output: process grants in ascending grant_id order
  const sortedGrants = [...grants].sort((a, b) => a.grant_id - b.grant_id);

  for (const g of sortedGrants) {
    const cands: Array<{ path: string; tier: 1 | 2 | 3 | 4; conf: number }> = [];

    for (const r of resources) {
      // Skip if already consumed by a higher-priority (earlier) grant
      if (consumedPaths.has(r.path)) continue;

      // Tier 1: exact folder name
      if (r.folderName === g.asset.name) {
        cands.push({ path: r.path, tier: 1, conf: 1.0 });
        continue;
      }
      // Tier 2: slugified asset name == normalized folder/fxmanifest name
      const slugGrant = normalize(g.asset.name);
      if (slugGrant === normalize(r.folderName)) {
        cands.push({ path: r.path, tier: 2, conf: 1.0 });
        continue;
      }
      if (r.fxmanifestName && slugGrant === normalize(r.fxmanifestName)) {
        cands.push({ path: r.path, tier: 2, conf: 1.0 });
        continue;
      }
      // Tier 3: author + name token overlap. Require overlap ≥ 2 distinct
      // meaningful tokens OR overlap ≥ 1 token where that token is length ≥ 4
      // (filters out `qs`, `cd`, `flrp` namespace prefixes).
      if (r.author && g.asset.author) {
        const aAuthor = normalize(g.asset.author);
        const bAuthor = normalize(r.author);
        const authorHit = aAuthor === bAuthor || aAuthor.includes(bAuthor) || bAuthor.includes(aAuthor);
        if (authorHit) {
          const grantTokens = tokens(g.asset.name);
          const folderTokens = tokens(r.folderName);
          const shared = [...grantTokens].filter((t) => folderTokens.has(t));
          const meaningfulOverlap = shared.filter((t) => t.length >= 4).length;
          const totalOverlap = shared.length;
          if (totalOverlap >= 2 || meaningfulOverlap >= 1) {
            cands.push({ path: r.path, tier: 3, conf: 0.85 });
          }
        }
      }
      // Tier 4a: Levenshtein ≥ 0.8
      const simFolder = similarity(slugGrant, normalize(r.folderName));
      const simManifest = r.fxmanifestName
        ? similarity(slugGrant, normalize(r.fxmanifestName))
        : 0;
      const sim = Math.max(simFolder, simManifest);
      if (sim >= 0.8) {
        cands.push({ path: r.path, tier: 4, conf: sim });
      } else {
        // Tier 4b: folder-token subset of grant-tokens (excluding stopwords).
        // Catches "Renewed Banking System" vs "Renewed-Banking" type cases.
        // Cap confidence at 0.7 — this tier is structurally fuzzier.
        const grantTokens = [...tokens(g.asset.name)].filter((t) => !STOPWORDS.has(t));
        const folderTokens = [...tokens(r.folderName)].filter((t) => !STOPWORDS.has(t));
        if (folderTokens.length >= 2 && grantTokens.length >= folderTokens.length) {
          const isSubset = folderTokens.every((t) => grantTokens.includes(t));
          if (isSubset) {
            cands.push({ path: r.path, tier: 4, conf: 0.7 });
          }
        }
      }
    }

    // Stable sort: tier asc, conf desc, path asc (tiebreak)
    cands.sort((a, b) => a.tier - b.tier || b.conf - a.conf || a.path.localeCompare(b.path));
    const best = cands[0];
    if (!best) { newInstalls.push(g.grant_id); continue; }

    consumedPaths.add(best.path);
    matches.push({
      grantId: g.grant_id,
      matchedPath: best.path,
      matchTier: best.tier,
      confidence: best.conf,
      alternatives: cands.slice(1).map((c) => ({ path: c.path, confidence: c.conf, tier: c.tier })),
    });
  }

  const orphaned = resources
    .filter((r) => r.hasFxap && !consumedPaths.has(r.path))
    .map((r) => r.path);

  return { matches, newInstalls, orphaned };
}
