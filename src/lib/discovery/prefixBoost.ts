import path from "node:path";
import { prefixesForAuthor } from "./authorPrefixes.js";

export interface BoostableCandidate {
  target: string;
  tier: number;
  confidence: number;
}

export interface BoostedCandidate extends BoostableCandidate {
  authorPrefixBoosted: boolean;
}

/**
 * Re-rank candidates so that prefix-matching entries appear first within each tier.
 * Does NOT change tiers or confidences; only re-orders. Surfaces a
 * `authorPrefixBoosted` flag on each candidate for caller display logic.
 *
 * Stable: original relative order is preserved within each (tier, boosted) bucket.
 */
export function applyAuthorPrefixBoost(
  candidates: BoostableCandidate[],
  author: string | null | undefined,
): BoostedCandidate[] {
  const prefixes = prefixesForAuthor(author);
  const decorated: BoostedCandidate[] = candidates.map((c) => {
    const basename = path.basename(c.target).toLowerCase();
    const boosted = prefixes.some((p) => basename.startsWith(p));
    return { ...c, authorPrefixBoosted: boosted };
  });
  // Stable sort: tier asc, then (boosted=true) ahead of (boosted=false), then original-index stable.
  return decorated
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      if (a.c.tier !== b.c.tier) return a.c.tier - b.c.tier;
      if (a.c.authorPrefixBoosted !== b.c.authorPrefixBoosted) {
        return a.c.authorPrefixBoosted ? -1 : 1;
      }
      return a.i - b.i;
    })
    .map(({ c }) => c);
}
