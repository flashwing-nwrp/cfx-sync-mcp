/**
 * Log scraper — Phase 1.6 Task 8.
 *
 * Walks a flat array of log lines, dispatching each candidate start index
 * through every registered pattern's `blockMatch`.  Pure function.
 *
 * Each pattern's `blockMatch(lines, startIdx)` is already single-shot via
 * `walkBlock`: it returns the first complete notice starting at `startIdx`
 * (tolerating non-matching lines up to its `maxBlockLines` budget) or null.
 * So the walker here is simpler than the spec's "per-token state machine
 * map" sketch — we just outer-loop over line indices and inner-loop over
 * the PATTERNS registry, advancing past consumed blocks.
 *
 * Returns `{ notices, scannedLogLines, logHasStartupBoundary }` — the
 * scanner (Task 9) consumes this with portal signal to produce the
 * 4-bucket output.
 *
 * Purity: no I/O, no `Date.now()`, no logger, deterministic for a given
 * input.  `performance.now()` is permitted in tests for timing assertions
 * but NOT used in the implementation.
 *
 * Interleaved-notice limitation: if two different resources' notices truly
 * overlap within the same line range (not just interleaved with unrelated
 * banners), the single-shot walker may miss the second one — `blockMatch`
 * consumes the lines of the first match and we skip past them.  Real FLRP
 * fixtures do not exhibit this pattern (each resource emits its notice
 * contiguously).  Documented as an acceptable Phase 1.6 limitation; the
 * operator workflow (≥ one cold-boot window per scan) ensures notices are
 * well-separated in practice.
 *
 * Cross-orthogonality: verified in Tasks 4–7 that no pattern false-matches
 * another's block shape.  The `break inner loop on first match` rule is
 * therefore safe — patterns compete on the opener line only.
 *
 * Startup-boundary detection: runs on every line independently of pattern
 * matching.  Any line containing `Started resource <slug>` flips
 * `logHasStartupBoundary` to true — we don't short-circuit, because we still
 * need to scan for notices after the boundary.
 */

import type { NoticePattern, LogNoticeMatch } from "./types.js";

/**
 * Startup-boundary regex.  FiveM's resource manager emits
 * `[           resources] Started resource <slug>` (variable leading
 * whitespace inside the brackets) once per resource during boot.  We
 * anchor on `\bStarted resource ` so any log format variant that preserves
 * the phrase qualifies, and require a non-whitespace slug follow.
 *
 * Non-anchored (no `^`) deliberately — the line has a bracketed prefix we
 * don't care about.  `\S+` bounds the capture so a blank slug doesn't
 * count.
 */
const STARTUP_BOUNDARY_RE = /\bStarted resource \S+/;

/**
 * Result shape returned by {@link parseNotices}.  Matches the spec's
 * "Signal source 2 — Log scraper" output contract at line 138.
 */
export interface ParseNoticesResult {
  /**
   * Deduplicated matches — one entry per unique
   * `(canonicalSlug, current, announced)` triple.  When the same triple
   * appears twice (e.g. server restarted mid-window), the LAST occurrence
   * wins (spec line 123 "most recent occurrence only").
   */
  notices: LogNoticeMatch[];

  /**
   * Exact pass-through of `lines.length` — downstream observability
   * (logged at scan time) confirms the walker saw the full input.
   */
  scannedLogLines: number;

  /**
   * True if ANY line in the input matched the startup-boundary regex
   * (`Started resource <slug>`).  Task 9 uses this to anchor the scan
   * window: if false, we didn't see a cold boot and the scan should warn
   * the operator that notices may be stale.
   */
  logHasStartupBoundary: boolean;
}

/**
 * Walk `lines`, dispatching each candidate start index through every
 * registered pattern.  See module JSDoc for the full algorithm and the
 * interleaved-notice limitation.
 *
 * @param lines     Raw log lines, already split on `\r?\n` by the caller.
 * @param patterns  The ordered `PATTERNS` registry (or a test subset).
 */
export function parseNotices(
  lines: string[],
  patterns: readonly NoticePattern[]
): ParseNoticesResult {
  const matches: LogNoticeMatch[] = [];
  let logHasStartupBoundary = false;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Boundary detection runs on EVERY line, independent of pattern matching.
    // No short-circuit — we still need to scan for notices past the boundary.
    if (!logHasStartupBoundary && STARTUP_BOUNDARY_RE.test(line)) {
      logHasStartupBoundary = true;
    }

    // Inner loop: probe each pattern at the current index.  First match wins
    // (patterns are cross-orthogonal — verified in Tasks 4–7 tests).
    let consumedByMatch = 0;
    for (const pattern of patterns) {
      const m = pattern.blockMatch(lines, i);
      if (m !== null) {
        matches.push(m);
        // Defensive floor of 1 — a pathological pattern returning 0 must still
        // advance the walker so we don't infinite-loop.  Real patterns always
        // return linesConsumed ≥ 1 because the opener itself counts.
        consumedByMatch = Math.max(1, m.linesConsumed);
        break;
      }
    }

    if (consumedByMatch > 0) {
      i += consumedByMatch;
    } else {
      i++;
    }
  }

  // Dedup by (canonicalSlug, current, announced).  Last-wins: iterate in
  // source order and always `set` — later entries overwrite earlier ones,
  // matching spec line 123 "most recent occurrence only".
  const dedupedMap = new Map<string, LogNoticeMatch>();
  for (const m of matches) {
    const key = `${m.canonicalSlug}|${m.current}|${m.announced}`;
    dedupedMap.set(key, m);
  }

  return {
    notices: [...dedupedMap.values()],
    scannedLogLines: lines.length,
    logHasStartupBoundary,
  };
}
