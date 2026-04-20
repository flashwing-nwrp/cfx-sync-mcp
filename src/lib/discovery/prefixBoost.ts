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
 * Within boosted items at the same tier: sort by confidence ascending.
 * Non-boosted items preserve original order.
 * Surfaces a `authorPrefixBoosted` flag on each candidate for caller display logic.
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
  // Sort: tier asc, then (boosted=true) ahead of (boosted=false).
  // Within boosted group: confidence ascending. Non-boosted: preserve original order (stable).
  return decorated
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      if (a.c.tier !== b.c.tier) return a.c.tier - b.c.tier;
      if (a.c.authorPrefixBoosted !== b.c.authorPrefixBoosted) {
        return a.c.authorPrefixBoosted ? -1 : 1;
      }
      // Only sort by confidence within boosted group
      if (a.c.authorPrefixBoosted && a.c.confidence !== b.c.confidence) {
        return a.c.confidence - b.c.confidence;
      }
      // Preserve original order for non-boosted items
      return a.i - b.i;
    })
    .map(({ c }) => c);
}
