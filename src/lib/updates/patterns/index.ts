/**
 * Pattern registry — stable-ordered export of all Phase 1.6 NoticePattern
 * implementations.  Adding a new vendor pattern is a single-file PR: add
 * src/lib/updates/patterns/<vendor>.ts, append to PATTERNS array below,
 * add fixtures + unit test.  No engine changes.
 *
 * Order is stable so tests + downstream observability can rely on it.
 * Alphabetical by id for deterministic iteration — Task 8's logScraper
 * probes each pattern in this order when correlating a given
 * `[script:<token>]` block to a pattern id.
 */

import type { NoticePattern } from "../types.js";
import { codesignPattern } from "./codesign.js";
import { promptPattern } from "./prompt.js";
import { quasarstorePattern } from "./quasarstore.js";
import { ulcPattern } from "./ulc.js";

export const PATTERNS: readonly NoticePattern[] = [
  codesignPattern,
  promptPattern,
  quasarstorePattern,
  ulcPattern,
] as const;

export function getAllPatterns(): readonly NoticePattern[] {
  return PATTERNS;
}
