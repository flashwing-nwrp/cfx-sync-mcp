/**
 * Per-token block-match state machine.
 *
 * Encapsulates the IDLE → IN_BLOCK → COMPLETE cycle documented in the Phase
 * 1.6 spec (§ Signal source 2 — Log scraper).  Each pattern parser owns its
 * own instance per `[script:<token>]` correlation key it sees in the input
 * stream; this module provides a reusable primitive so sibling pattern
 * authors (Tasks 5 / 6 / 7) don't re-invent the bookkeeping.
 *
 * State transitions (verbatim from spec):
 *
 *   IDLE     → IN_BLOCK  on opener match (start lineCount=1)
 *   IN_BLOCK → IN_BLOCK  on expected follow-up (lineCount++)
 *   IN_BLOCK → IDLE      on 20-line timeout (discards partial accumulator)
 *   IN_BLOCK → COMPLETE  when all required fields captured → emit → IDLE
 *   *        → IDLE      on "Started resource <slug>" sentinel for this token
 *                         (assumes previous announce window closed)
 *   IN_BLOCK → IDLE      on end-of-input (discard partial)
 *
 * Purity: no logger, no I/O, no `Date.now()`.  Deterministic for a given
 * input sequence.  Accumulator type is caller-owned via generics so each
 * pattern can carry its own in-progress fields (version strings, URLs, …).
 */

/**
 * Spec-defined maximum lines between opener and completion before timeout.
 * See spec § Signal source 2 — Log scraper, state machine transitions line 118.
 */
export const MAX_BLOCK_LINES = 20;

/**
 * Caller-supplied line-handler contract.  Receives the current accumulator
 * and the input line; returns one of:
 *
 *  - `"continue"`  line either updated or did not affect the accumulator;
 *                  keep walking (most lines fall here).  The handler mutates
 *                  `accumulator` in place when it extracts a field.
 *  - `"complete"`  line was the closing sentinel; emit now.
 *  - `"reset"`     sentinel line cancels the walk entirely (walkBlock returns
 *                  null).  Multi-block stream scanning is the scraper's job
 *                  (Task 8), not this primitive's.
 */
export type LineOutcome = "continue" | "complete" | "reset";

export interface BlockMachineHooks<TAccumulator> {
  /**
   * Test whether a line is an opener for this pattern.  When returning a
   * non-null accumulator the machine transitions IDLE → IN_BLOCK with
   * lineCount=1.  The returned accumulator is the seed for subsequent
   * `onLine` calls.  Returning null keeps the machine IDLE.
   */
  onOpener(line: string): TAccumulator | null;

  /**
   * Called for each follow-up line while IN_BLOCK.  Mutates the accumulator
   * in place and returns an outcome that drives the state transition.
   */
  onLine(line: string, accumulator: TAccumulator): LineOutcome;

  /**
   * Maximum lines allowed between opener (inclusive) and completion before
   * the block is abandoned.  Defaults to `MAX_BLOCK_LINES` (20).
   */
  maxBlockLines?: number;
}

/**
 * Drive a block-match walk over a slice of log lines starting at `startIdx`.
 *
 * Single-shot API: returns the first `COMPLETE` outcome it reaches (with
 * `linesConsumed` from the opener inclusive), or `null` if the block
 * times out / truncates / never opens.  This is the shape Task 4's pattern
 * `blockMatch(lines, startIdx)` consumers need.
 *
 * The walker respects the spec's 20-line timeout: if the accumulator still
 * hasn't completed once `lineCount` exceeds the pattern's `maxBlockLines`
 * bound (default `MAX_BLOCK_LINES`), it returns `null`.
 *
 * End-of-input while IN_BLOCK also returns `null` (the spec calls this
 * "discard partial — notice was truncated").
 */
export function walkBlock<TAccumulator>(
  lines: string[],
  startIdx: number,
  hooks: BlockMachineHooks<TAccumulator>
): { accumulator: TAccumulator; linesConsumed: number } | null {
  const maxLines = hooks.maxBlockLines ?? MAX_BLOCK_LINES;

  const openerLine = lines[startIdx];
  if (openerLine === undefined) return null;

  const accumulator = hooks.onOpener(openerLine);
  if (accumulator === null) return null;

  // Opener accepted: we are IN_BLOCK with lineCount=1 (the opener itself).
  let lineCount = 1;

  for (let i = startIdx + 1; i < lines.length; i++) {
    // Timeout check BEFORE processing the next line — if we've already
    // consumed the budget, the block is abandoned without inspecting
    // further input.
    if (lineCount >= maxLines) {
      return null;
    }

    const current = lines[i] ?? "";
    const outcome = hooks.onLine(current, accumulator);
    lineCount++;

    if (outcome === "reset") {
      return null;
    }
    if (outcome === "complete") {
      return { accumulator, linesConsumed: lineCount };
    }
    // "continue" — keep walking until complete / reset / timeout / EOF.
  }

  // End-of-input while still IN_BLOCK: the spec says discard partial.
  return null;
}
