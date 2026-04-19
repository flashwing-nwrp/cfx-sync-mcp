/**
 * Loose semver comparison helper.
 *
 * Policy wrapper around node-semver's coerce() + compare().  Returns a 4-outcome
 * type used by the scanner's merge step.
 *
 * Documented deliberate deviations from semver 2.0.0:
 *  - Leading 'v' or 'V' stripped from both sides before processing.
 *  - Pre-release / build tags (1.0.0-beta, 2.1.15-rc1) treated as EQUIVALENT
 *    to their release counterpart.  coerce() discards the pre-release portion,
 *    so coerce("1.0.0-beta") === "1.0.0".  Operators on beta channels who want
 *    strict ordering should set ignoreUpstreamUpdates on affected resources.
 *  - 2-part versions (1.0) are normalized to 3-part (1.0.0) via coerce().
 *  - 4-part versions (1.0.0.1) → "incomparable" to avoid coerce() silently
 *    dropping the 4th component and producing a false match.
 *  - Non-numeric prefixes (r42, abc) → "incomparable".
 *  - Date-style versions (2025.01.15) parse as major.minor.patch — compares
 *    numerically as documented in spec § Semver comparison helper.
 */

import * as semver from "semver";

export type SemverComparison = "ahead" | "equal" | "behind" | "incomparable";

/** Regex that detects 4+ dot-separated numeric parts (after v/V strip). */
const FOUR_PART_RE = /^\d+\.\d+\.\d+\.\d+/;

/** Regex that detects a non-digit leading character (after v/V strip). */
const NON_DIGIT_START_RE = /^[^\d]/;

/**
 * Compare local version string (a) to announced version string (b) with loose
 * semver semantics.
 *
 * Returns:
 *  "ahead"        — a is strictly greater than b
 *  "equal"        — a and b coerce to the same semver
 *  "behind"       — a is strictly less than b
 *  "incomparable" — either side cannot be coerced (empty, non-numeric prefix,
 *                   4-part, or coerce returns null)
 *
 * Decision flow:
 *  1. Empty / nullish input → incomparable
 *  2. Strip leading v or V (case-insensitive)
 *  3. 4+ dot-separated numeric parts (e.g. 1.0.0.1) → incomparable
 *  4. Non-digit start (e.g. r42, abc) → incomparable
 *  5. coerce() both sides — if either is null → incomparable
 *  6. semver.compare(coercedA, coercedB) → map to SemverComparison
 */
export function compareLoose(a: string, b: string): SemverComparison {
  // Step 1: empty / nullish guard
  if (!a || !b) {
    return "incomparable";
  }

  // Step 2: strip leading v/V
  const strippedA = a.replace(/^[vV]/, "");
  const strippedB = b.replace(/^[vV]/, "");

  // Step 3: reject 4-part versions before coerce() silently drops the 4th part
  if (FOUR_PART_RE.test(strippedA) || FOUR_PART_RE.test(strippedB)) {
    return "incomparable";
  }

  // Step 4: reject non-numeric prefixes (r42, abc, etc.)
  if (NON_DIGIT_START_RE.test(strippedA) || NON_DIGIT_START_RE.test(strippedB)) {
    return "incomparable";
  }

  // Step 5: coerce — handles 2-part, 3-part, pre-release tags (stripped by coerce).
  // Use { loose: true } so that zero-padded segments (e.g. "2025.01.15")
  // are accepted — coerce in strict mode rejects leading zeros.
  const coercedA = semver.coerce(strippedA, { loose: true });
  const coercedB = semver.coerce(strippedB, { loose: true });

  if (coercedA === null || coercedB === null) {
    return "incomparable";
  }

  // Step 6: compare and map
  const cmp = semver.compare(coercedA, coercedB);
  if (cmp < 0) return "behind";
  if (cmp > 0) return "ahead";
  return "equal";
}
