/**
 * Known portal authors and the slug prefixes they use when shipping resources.
 * Consulted by matchGrants to re-rank alternatives during discovery — not a
 * hard filter. Unknown authors fall through with ordering untouched.
 *
 * Case-insensitive lookup via prefixesForAuthor().
 */
export const AUTHOR_PREFIXES: Record<string, string[]> = {
  "BroFX":               ["brofx_"],
  "Codesign":            ["cd_"],
  "Apollo Developments": ["apollo_"],
  "quasarstore":         ["qs-", "qs_"],
  "ULC":                 ["ulc_", "dawnstar_"],
  "Prompt":              ["prompt_"],
  "Rcore":               ["rcore_"],
  "Molo":                ["molo_"],
  "LondonStudios":       ["ls_", "london_"],
  "AL-Developments":     ["al_", "al-"],
};

// Pre-built lowercase index for O(1) case-insensitive lookup.
const INDEX: Record<string, string[]> = Object.fromEntries(
  Object.entries(AUTHOR_PREFIXES).map(([k, v]) => [k.toLowerCase(), v])
);

export function prefixesForAuthor(author: string | null | undefined): string[] {
  if (!author) return [];
  return INDEX[author.toLowerCase()] ?? [];
}
