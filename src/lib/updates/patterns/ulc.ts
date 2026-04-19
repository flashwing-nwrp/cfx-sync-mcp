/**
 * ULC / Ultimate Lighting Controller (by Dawnstar) notice pattern.
 *
 * Handles the two-part notice emitted by the `ulc` resource on boot when a
 * mismatch exists between installed and announced upstream versions.  The
 * block is canonically TWO parts separated by ~12 lines of ASCII banner art:
 *
 * Part A (always present):
 *
 *     [ULC] My Version: [1.9.0]
 *     [ULC] Latest Version: [v1.8.0]
 *
 * Part B (present when outdated; the common case we're built for):
 *
 *     [ULC] OUTDATED. A NEW VERSION (v1.8.0) IS AVAILABLE.
 *     [ULC] YOUR VERSION: 1.9.0
 *     [ULC] GET LATEST VERSION HERE: https://github.com/Flohhhhh/ultimate-lighting-controller/releases/
 *
 * Between Part A and Part B: an ASCII-art banner (roughly 10 lines) plus the
 * `ULTIMATE LIGHTING CONTROLLER / by Dawnstar / Loaded` header trio and a
 * couple of whitespace-only lines.  Those intermediate lines are non-`[ULC]`
 * and we just tolerate them via walkBlock's "continue" outcome.
 *
 * The shipped fixture `ulc-fork-case.log` is the canonical fork case: local
 * `1.9.0` > announced `v1.8.0`.  The pattern's job here is to parse the
 * notice cleanly.  Task 9's scanner merge compares semver and flips the
 * result into `suppressed: local-ahead` — this module deliberately does NOT
 * do that compare.
 *
 * Design decision — which Part wins on disagreement:
 *  - Part A comes first in the script's emission order.  If Part A and Part
 *    B versions disagree, Part A wins.  `onLine` handlers set fields only
 *    if the field is unset, so the first observed value persists.
 *
 * Security / trust:
 *  - `trustedDomains: ["github.com"]` — EXACT host equality.
 *  - `raw.githubusercontent.com` is NOT a subdomain match; it is rejected
 *    and demoted to severityNote.  This is intentional.  Dawnstar's release
 *    URLs are on `github.com`; raw content URLs are not a vendor-sanctioned
 *    change surface.
 *
 * Version-string policy:
 *  - Emit versions AS-CAPTURED.  `v1.8.0` stays `v1.8.0`.  Do NOT strip the
 *    `v` prefix in the pattern — Task 9's semverCompare's loose policy
 *    handles the strip.  Preserving the raw emitted form helps operators
 *    quickly cross-reference against vendor release titles.
 *  - Surrounding whitespace is trimmed.
 *
 * Block-walk completion:
 *  - Completes when `GET LATEST VERSION HERE: <url>` line arrives AND both
 *    `current` + `announced` are already captured.
 *  - If required fields are missing at URL time → reset (malformed / spurious).
 *  - If EOF is hit before URL → walkBlock returns null (truncated Part B —
 *    up-to-date resources don't emit Part B at all, and the scanner is
 *    looking only for outdated notices here anyway).
 *  - `maxBlockLines: 30` to accommodate the ~12-line banner between parts.
 *
 * Pure: no I/O, no logger, no `Date.now()`.  Task 9 scanner owns the
 * semver compare step.
 */

import type { NoticePattern, LogNoticeMatch } from "../types.js";
import { walkBlock } from "../blockStateMachine.js";
import { checkUrl } from "../urlAllowlist.js";

/**
 * ULC's banner art plus header trio is roughly 12 lines long, and both Part A
 * lines + Part B's narrative lines live outside that budget.  30 is a safe
 * ceiling that still bounds adversarial inputs.
 */
const MAX_BLOCK_LINES_ULC = 30;

/**
 * Opener: the `[ULC] My Version: [X]` line is always emitted FIRST before any
 * banner art — so it's the reliable entry point.  Anchored ^/$ rejects
 * newline-smuggled composites.
 */
const OPENER_RE = /^\[ULC\]\s+My Version:\s*\[([^\]]+)\]\s*$/;

/**
 * Part A's second line: Latest Version.  Captures the version inside `[...]`
 * verbatim (no v-strip — Task 9 handles that).  Anchored.
 */
const LATEST_VERSION_RE = /^\[ULC\]\s+Latest Version:\s*\[([^\]]+)\]\s*$/;

/**
 * Part B's first line: OUTDATED narrative.  Captures the full sentence for
 * severityNote operator visibility.  Non-greedy capture bounded by the line
 * terminator anchor.
 */
const OUTDATED_RE = /^\[ULC\]\s+(OUTDATED\.\s+A NEW VERSION[^\n]*?)\s*$/;

/**
 * Part B's terminator: the URL line.  `\S+?` is non-greedy so trailing
 * whitespace doesn't get absorbed.  Anchored at end.
 */
const URL_RE = /^\[ULC\]\s+GET LATEST VERSION HERE:\s*(\S+?)\s*$/;

/**
 * Strip the leading `[ script:<token>] ` FiveM log prefix off a raw log line.
 * Self-contained — not imported from sibling patterns.  `(.*)$` without the
 * `m` flag means embedded newlines inside a single array element do NOT get
 * treated as line splits (defence against newline-smuggling inputs).
 */
function stripScriptPrefix(line: string): string {
  const m = line.match(/^\[\s*script:[^\]]+\]\s?(.*)$/);
  return m ? (m[1] ?? "") : line;
}

/** Accumulator carried across lines while IN_BLOCK. */
interface UlcAccumulator {
  current?: string;
  announced?: string;
  outdatedNote?: string;
  urlCandidate?: string;
}

/**
 * Normalize a log-side slug token to the canonical mapping key.
 *
 * ULC has exactly one canonical slug — `ulc` — so be strict.  Accepts:
 *  - `[ULC]`, `[ulc]` (bracket-wrapped, any case)
 *  - `ULC`, `ulc`, `Ulc` (bare, any case)
 *
 * Rejects everything else.  No dash-to-underscore normalization needed.
 *
 * Returns `null` if:
 *  - Input is empty or brackets-only after strip
 *  - Input contains `:` (caller fed raw `[script:...]` prefix — caller bug)
 *  - Input contains chars outside `[a-z0-9]`
 *  - Input does not normalize to `ulc`
 */
function canonicalSlug(logToken: string): string | null {
  if (!logToken) return null;

  const bracketed = logToken.match(/^\[(.+)\]$/);
  const inner = bracketed ? (bracketed[1] ?? "") : logToken;

  if (inner.length === 0) return null;
  if (inner.includes(":")) return null;
  if (!/^[a-z0-9]+$/i.test(inner)) return null;

  const normalized = inner.toLowerCase();
  return normalized === "ulc" ? "ulc" : null;
}

/**
 * Attempt to match a ULC notice block starting at `lines[startIdx]`.  The
 * opener is `[ULC] My Version: [X]` (Part A's first line).
 *
 * Input lines may be either raw FiveM log lines (with `[script:<token>]`
 * prefix) or pre-stripped content lines. Both accepted; the pattern strips
 * the prefix internally.
 *
 * See module JSDoc for the completion rule (URL line + both versions set).
 */
function blockMatch(lines: string[], startIdx: number): LogNoticeMatch | null {
  const trusted = ulcPattern.trustedDomains;

  const result = walkBlock<UlcAccumulator>(lines, startIdx, {
    maxBlockLines: MAX_BLOCK_LINES_ULC,
    onOpener(line) {
      const stripped = stripScriptPrefix(line);
      const m = stripped.match(OPENER_RE);
      if (!m) return null;
      const current = (m[1] ?? "").trim();
      if (current.length === 0) return null;
      return { current };
    },
    onLine(line, acc) {
      const stripped = stripScriptPrefix(line);

      const latestM = stripped.match(LATEST_VERSION_RE);
      if (latestM) {
        // First-wins: don't overwrite a Part A value with a Part B value.
        if (acc.announced === undefined) {
          acc.announced = (latestM[1] ?? "").trim();
        }
        return "continue";
      }

      const outdatedM = stripped.match(OUTDATED_RE);
      if (outdatedM) {
        if (acc.outdatedNote === undefined) {
          acc.outdatedNote = outdatedM[1];
        }
        return "continue";
      }

      const urlM = stripped.match(URL_RE);
      if (urlM) {
        acc.urlCandidate = urlM[1];
        // Completion rule: URL line + both versions captured → emit.  Missing
        // required fields → malformed block, bail.
        return acc.current && acc.announced ? "complete" : "reset";
      }

      // Banner art, ULTIMATE LIGHTING CONTROLLER header, `by Dawnstar`,
      // `Loaded`, blank lines, YOUR VERSION narrative — all tolerable noise.
      return "continue";
    },
  });

  if (!result) return null;

  const { accumulator: acc, linesConsumed } = result;

  // Belt-and-braces — walkBlock only returns "complete" when both versions
  // are set, but guard anyway so future refactors can't silently regress.
  if (!acc.current || !acc.announced) return null;

  let releaseNotesUrl: string | undefined;
  const severityParts: string[] = [];

  if (acc.outdatedNote) {
    severityParts.push(acc.outdatedNote);
  }

  if (acc.urlCandidate) {
    const check = checkUrl(acc.urlCandidate, trusted);
    if (check.ok) {
      releaseNotesUrl = check.url.toString();
    } else {
      severityParts.push(`Update URL: ${acc.urlCandidate}`);
    }
  }

  // Newline-join matches sibling conventions (codesign.ts, prompt.ts) so
  // operators see one fragment per line in Discord embeds.
  const severityNote =
    severityParts.length > 0 ? severityParts.join("\n") : undefined;

  return {
    canonicalSlug: "ulc",
    current: acc.current,
    announced: acc.announced,
    releaseNotesUrl,
    severityNote,
    linesConsumed,
    patternId: ulcPattern.id,
  };
}

/** The ULC pattern registration.  See module JSDoc for contract. */
export const ulcPattern: NoticePattern = {
  id: "ulc-v1",
  description:
    "ULC / Ultimate Lighting Controller (by Dawnstar) two-part notice. Includes fork-case detection fixture.",
  trustedDomains: ["github.com"],
  blockMatch,
  canonicalSlug,
};
