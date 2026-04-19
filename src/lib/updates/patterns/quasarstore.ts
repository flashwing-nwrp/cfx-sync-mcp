/**
 * quasarstore author notice pattern.
 *
 * Handles the simple 1-2 line "New version available" notice emitted by
 * Quasar Store resources (qs-inventory, qs-housing, qs-advancedinventory,
 * qs-vehiclekeys, qs-motorhome, ...).
 *
 * Block shape (outdated — 2 lines, real FLRP capture):
 *
 *     [ script:qs-inventory] New version available for qs-advancedinventory!
 *     [ script:qs-inventory] You have version 1.5.56, upgrade to version 1.5.71!
 *
 * Block shape (up-to-date — single line, also real):
 *
 *     [script:qs-vehiclekey] You are using the latest version of qs-vehiclekeys!
 *
 * Real-world quirk: qs-inventory publishes notices for its sibling
 * qs-advancedinventory (and qs-vehiclekeys publishes for qs-motorhome).  The
 * slug in the message body therefore differs from the emitting `[script:...]`
 * token.  Pattern contract: the ANNOUNCED slug (from the message body) wins
 * over the emitter-script-prefix slug — that's what Task 9 maps through
 * cfx-sync-map.json to find the asset on disk.
 *
 * Up-to-date variant policy:
 *  - The scanner only cares about actionable (outdated) notices.
 *  - `blockMatch` deliberately does NOT match the `You are using the latest
 *    version ...` line.  There is no opener regex alternative for it, and
 *    the pattern returns null at those start indices.  A future extension
 *    could emit a "confirmed up-to-date" signal but that's out of scope for
 *    Phase 1.6 — Task 9's 4-bucket output treats absence-of-notice as the
 *    up-to-date signal for portal-known resources and ignores everything
 *    else.
 *
 * Security / trust:
 *  - `trustedDomains` is EMPTY — no URL has been observed in any quasarstore
 *    notice.  Were one to appear it would be demoted to severityNote plain
 *    text by `urlAllowlist.checkUrl`.
 *
 * Pure: no I/O, no logger, no `Date.now()`.  Task 9 scanner owns the semver
 * compare step — this module emits raw version strings as captured.
 */

import type { NoticePattern, LogNoticeMatch } from "../types.js";
import { walkBlock } from "../blockStateMachine.js";

/**
 * The notice is deterministically 2 lines (opener + upgrade-version line).
 * Cap at 2 so malformed or truncated notices fall off immediately rather
 * than tolerating ~20 lines of noise between them.
 */
const MAX_BLOCK_LINES_QUASARSTORE = 2;

/**
 * Opener regex: `New version available for <slug>!` (optional bang).  Captures
 * the ANNOUNCED slug — the slug-to-report, which may differ from the emitter.
 * Anchored ^...$ (no `m` flag) so newline-smuggled composites cannot sneak a
 * two-line match into a single array element.  Bounded charset bounds input.
 */
const OPENER_RE = /^New version available for ([a-z0-9_-]+)!?\s*$/i;

/**
 * Upgrade version regex: `You have version A, upgrade to version B!` (optional
 * bang).  `\S+?` non-greedy bounded by a comma / whitespace / bang means the
 * version capture cannot consume the rest of the line — no catastrophic
 * backtracking potential.  Anchored.
 */
const UPGRADE_RE =
  /^You have version (\S+?),\s*upgrade to version (\S+?)!?\s*$/i;

/**
 * Strip the leading `[ script:<token>] ` FiveM log prefix off a raw log line.
 * Self-contained per Phase 1.6 plan — not imported from sibling patterns.
 * `(.*)$` without the `m` flag means embedded newlines inside a single array
 * element are NOT treated as line splits (defence vs newline smuggling).
 */
function stripScriptPrefix(line: string): string {
  const m = line.match(/^\[\s*script:[^\]]+\]\s?(.*)$/);
  return m ? (m[1] ?? "") : line;
}

/** Accumulator carried across lines while IN_BLOCK. */
interface QuasarstoreAccumulator {
  /**
   * Announced slug captured from the opener line's body — NOT the emitter
   * script-prefix slug.  Runs through `canonicalSlug` at emit time to
   * normalize / reject.
   */
  announcedSlug: string;
  current?: string;
  announced?: string;
}

/**
 * Normalize a log-side slug token to the canonical mapping key.
 *
 * Accepts bare `qs-inventory` or bracket-wrapped `[qs-inventory]`, lowercases.
 * Permissive charset (same shape as promptPattern.canonicalSlug) — the actual
 * vendor-prefix enforcement ("must start with qs-") is done by the opener
 * regex during `blockMatch`, NOT here.  Future quasarstore sub-brands /
 * renames can register without touching this normalizer.
 *
 * Returns `null` if:
 *  - Empty after bracket-strip
 *  - Contains `:` (caller fed raw `[script:...]` noise — caller bug)
 *  - Contains chars outside `[a-z0-9_-]` (whitespace, `$`, …)
 */
function canonicalSlug(logToken: string): string | null {
  if (!logToken) return null;

  const bracketed = logToken.match(/^\[(.+)\]$/);
  const inner = bracketed ? (bracketed[1] ?? "") : logToken;

  if (inner.length === 0) return null;
  if (inner.includes(":")) return null;
  if (!/^[a-z0-9_-]+$/i.test(inner)) return null;

  return inner.toLowerCase();
}

/**
 * Attempt to match a quasarstore notice block starting at `lines[startIdx]`.
 * The opener is `New version available for <slug>!` (post-prefix-strip).
 *
 * Input lines may be either raw FiveM log lines (with `[script:<token>]`
 * prefix) or pre-stripped content lines.  The pattern strips internally.
 *
 * Up-to-date notices (`You are using the latest version of <slug>!`) do NOT
 * match the opener regex and therefore return null at those start indices.
 * That's intentional — the scanner only emits actionable outdated signals
 * from the log-scraper surface.
 */
function blockMatch(lines: string[], startIdx: number): LogNoticeMatch | null {
  const result = walkBlock<QuasarstoreAccumulator>(lines, startIdx, {
    maxBlockLines: MAX_BLOCK_LINES_QUASARSTORE,
    onOpener(line) {
      const stripped = stripScriptPrefix(line);
      const m = stripped.match(OPENER_RE);
      if (!m) return null;
      const announcedSlug = (m[1] ?? "").trim();
      if (announcedSlug.length === 0) return null;
      return { announcedSlug };
    },
    onLine(line, acc) {
      const stripped = stripScriptPrefix(line);

      const upgradeM = stripped.match(UPGRADE_RE);
      if (upgradeM) {
        acc.current = (upgradeM[1] ?? "").trim();
        acc.announced = (upgradeM[2] ?? "").trim();
        return "complete";
      }

      // Anything else on the one-and-only follow-up line slot is malformed.
      // Abandon rather than tolerate — quasarstore's format is a deterministic
      // 2-liner and the `maxBlockLines: 2` cap would kick in anyway.
      return "reset";
    },
  });

  if (!result) return null;

  const { accumulator: acc, linesConsumed } = result;

  if (!acc.current || !acc.announced) return null;

  // Run the ANNOUNCED slug through canonicalSlug to normalize.  If the slug
  // fails validation (shouldn't — the opener regex's charset already bounds
  // it, but belt-and-braces) the notice is dropped.
  const slug = canonicalSlug(acc.announcedSlug);
  if (!slug) return null;

  return {
    canonicalSlug: slug,
    current: acc.current,
    announced: acc.announced,
    linesConsumed,
    patternId: quasarstorePattern.id,
  };
}

/** The quasarstore pattern registration.  See module JSDoc for contract. */
export const quasarstorePattern: NoticePattern = {
  id: "quasarstore-v1",
  description:
    "quasarstore 1-2 line notice format — qs-inventory, qs-housing, qs-advancedinventory, qs-vehiclekeys, qs-motorhome. Emitter-slug and announced-slug may differ.",
  trustedDomains: [],
  blockMatch,
  canonicalSlug,
};
