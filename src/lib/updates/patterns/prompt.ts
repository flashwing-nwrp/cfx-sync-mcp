/**
 * Prompt author notice pattern.
 *
 * Handles the boxed-table "⚠️  UPDATE AVAILABLE" notice emitted by Prompt-
 * authored resources (prompt_sandy_illegal_garage, prompt_sandy_mechanic,
 * and siblings) when an upstream release differs from the installed version.
 *
 * Block shape (real FLRP capture — Variant A, explicit slug):
 *
 *     +-------------------------------------------------------------------------------+
 *     | ⚠️  UPDATE AVAILABLE for [prompt_sandy_illegal_garage]: 1.0.5 → 1.1.1   |
 *     |                                                                               |
 *     |  CHANGELOGS:                                                                  |
 *     |  -  - Sandy Illegal Garage & Gas Station                                      |
 *     |                                                                               |
 *     |  Please update to the latest version for the best experience.                 |
 *     +-------------------------------------------------------------------------------+
 *
 * Block shape (Variant B — header-less, slug must come from [script:<token>] prefix):
 *
 *     +----------------------------------------------------------------+
 *     | ⚠️  UPDATE AVAILABLE: 1.1.1 → 1.2.1                      |
 *     ...
 *     +----------------------------------------------------------------+
 *
 * FLRP log truncation quirk:
 *   The FiveM log format truncates the `[script:<token>]` prefix at a fixed
 *   13-character budget (including the literal `script:`).  That means for the
 *   `prompt_sandy_mechanic` resource the prefix arrives truncated as
 *   `[script:prompt_sandy_]` — trailing underscore preserved, actual slug lost.
 *   Consequently the header-less Variant B fixture's canonical slug is
 *   `prompt_sandy_` (not `prompt_sandy_mechanic`).  canonicalSlug deliberately
 *   preserves trailing underscores as valid chars — a future reader seeing the
 *   odd slug in mapping entries should understand why.
 *
 * Security / trust:
 *  - `trustedDomains` is EMPTY.  No URL has been observed in any live Prompt
 *    fixture, so the allowlist stays empty until a real URL surfaces.  Any URL
 *    encountered inside the box is demoted to plain text in `severityNote`.
 *  - Consequence: releaseNotesUrl is effectively never set for prompt-v1 today.
 *    When Prompt starts emitting changelog URLs, add the host here and
 *    re-test against a fresh fixture — do not trust a host speculatively.
 *
 * Pure: no I/O, no logger, no `Date.now()`.  Task 9 scanner owns the semver
 * compare step — this module emits raw strings.
 */

import type { NoticePattern, LogNoticeMatch } from "../types.js";
import { walkBlock } from "../blockStateMachine.js";
import { checkUrl } from "../urlAllowlist.js";

/**
 * Top and bottom border of the Prompt box: a plus, three-or-more dashes, a
 * plus, with nothing else on the line after stripping the `[script:...]`
 * prefix.  Used as both opener and closer sentinel.
 */
const BORDER_RE = /^\+-{3,}\+$/;

/**
 * Header line regex.  Matches either Variant A (explicit `for [<slug>]`) or
 * Variant B (header-less).  Captures:
 *
 *   group 1 — explicit slug when `for [<slug>]` is present; else undefined.
 *   group 2 — current version (up to whitespace)
 *   group 3 — announced version (up to whitespace)
 *
 * Tolerates optional leading `⚠️ ` emoji, arbitrary whitespace padding inside
 * `| ... |` cells, and three arrow forms: `→` (canonical / real fixtures),
 * `->`, `=>` (defensive — never observed live but cheap to tolerate).
 *
 * Anchored with `^\|` / `\|?\s*$` to reject notice-shaped content that is
 * not actually inside a table cell.
 */
const HEADER_RE =
  /^\|\s*(?:⚠️\s+)?UPDATE AVAILABLE(?:\s+for\s+\[([a-z0-9_-]+)\])?:\s*(\S+)\s*(?:→|->|=>)\s*(\S+)\s*\|?\s*$/i;

/**
 * CHANGELOGS section opener — the literal `CHANGELOGS:` tag, optionally with
 * leading `  - ` bullet cruft.  Sets an accumulator flag so subsequent `|  ...
 * |` rows that aren't blank / footer are appended as Changelog entries.
 */
const CHANGELOGS_RE = /^\|\s*CHANGELOGS:\s*\|?\s*$/i;

/** Blank row inside the box: `|   |` (pipe + only whitespace + pipe). */
const BLANK_ROW_RE = /^\|\s*\|?\s*$/;

/**
 * "Please update ..." footer — optional line before the closer.  Captures
 * everything between the pipes as a "Note: " addendum to severityNote.
 */
const FOOTER_RE = /^\|\s*(Please update[^|]*?)\s*\|?\s*$/i;

/**
 * Generic box row — `|  <content>  |` — used to catch CHANGELOGS bullets and
 * other narrative content.  Non-greedy `(.+?)` bounded by whitespace + closing
 * pipe prevents catastrophic backtracking on long inputs.
 */
const ROW_RE = /^\|\s+(.+?)\s*\|?\s*$/;

/**
 * Strip the leading `[ script:<token>] ` FiveM log prefix off a raw log line.
 * Example matches:
 *   `[script:foo] `
 *   `[    script:foo] `   (Codesign-style padded)
 *   `[script:prompt_sandy_] ` (Prompt truncated form)
 * If no prefix found, return the line unchanged.
 */
function stripScriptPrefix(line: string): string {
  const m = line.match(/^\[\s*script:[^\]]+\]\s?(.*)$/);
  return m ? (m[1] ?? "") : line;
}

/**
 * Extract the `<token>` from a `[script:<token>]` prefix on the raw (un-
 * stripped) line.  Returns null if no prefix is present.  The token is later
 * fed to `canonicalSlug` to produce the Variant B fallback slug.
 */
function extractScriptToken(rawLine: string): string | null {
  const m = rawLine.match(/^\[\s*script:([^\]]+)\]/);
  if (!m) return null;
  const token = (m[1] ?? "").trim();
  return token.length > 0 ? token : null;
}

/** Accumulator carried across lines while IN_BLOCK. */
interface PromptAccumulator {
  /** Token extracted from `[script:<token>]` on the opener's raw line. */
  scriptToken: string | null;
  /** Slug from the explicit `for [<slug>]` header, when Variant A. */
  explicitSlug: string | null;
  current: string | null;
  announced: string | null;
  /** True after CHANGELOGS: marker seen → subsequent rows are bullets. */
  inChangelogs: boolean;
  severityParts: string[];
  /** URLs encountered inside the box — demoted to severityNote at emit time. */
  untrustedUrls: string[];
}

/** Pull all http(s) URL substrings out of a line. */
function extractUrls(text: string): string[] {
  // Bounded [^\s]+ so we don't suck up the entire line on malformed input.
  return Array.from(text.matchAll(/https?:\/\/[^\s]+/gi), (m) => m[0]);
}

/**
 * Normalize a log-side slug token to the canonical mapping key.
 *
 * Accepts bare `prompt_sandy_illegal_garage` or bracket-wrapped
 * `[prompt_sandy_illegal_garage]`, lowercases.
 *
 * Unlike Codesign's normalizer, this one does NOT strip trailing underscores
 * — FLRP's log-format truncation leaves `prompt_sandy_` as a legitimate (if
 * ugly) canonical form for Variant B matches.  Mapping entries for such
 * resources are expected to use the truncated form.
 *
 * Returns `null` if:
 *  - Empty after bracket-strip
 *  - Contains `:` (caller passed raw `[script:...]` noise — caller bug)
 *  - Contains chars outside `[a-z0-9_-]`
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
 * Attempt to match a Prompt notice block starting at `lines[startIdx]`.
 * Startidx must point at the top `+---...---+` border.
 *
 * Input lines may be either raw FiveM log lines (with `[script:<token>]`
 * prefix) or pre-stripped content lines.  Both are accepted; the pattern
 * internally strips the prefix if present.
 */
function blockMatch(lines: string[], startIdx: number): LogNoticeMatch | null {
  const trusted = promptPattern.trustedDomains;

  const result = walkBlock<PromptAccumulator>(lines, startIdx, {
    onOpener(line) {
      const stripped = stripScriptPrefix(line);
      if (!BORDER_RE.test(stripped)) return null;
      const scriptToken = extractScriptToken(line);
      return {
        scriptToken,
        explicitSlug: null,
        current: null,
        announced: null,
        inChangelogs: false,
        severityParts: [],
        untrustedUrls: [],
      };
    },
    onLine(line, acc) {
      const stripped = stripScriptPrefix(line);

      // Bottom border → block complete only if both versions landed.
      if (BORDER_RE.test(stripped)) {
        return acc.current && acc.announced ? "complete" : "reset";
      }

      // Header line (Variant A or B).  We require it to appear at least once;
      // subsequent header-shaped lines inside a single block would be
      // ill-formed but we just overwrite — the last wins.
      const headerM = stripped.match(HEADER_RE);
      if (headerM) {
        if (headerM[1] !== undefined) acc.explicitSlug = headerM[1];
        acc.current = headerM[2] ?? null;
        acc.announced = headerM[3] ?? null;
        return "continue";
      }

      // CHANGELOGS section marker.
      if (CHANGELOGS_RE.test(stripped)) {
        acc.inChangelogs = true;
        return "continue";
      }

      // Blank row — terminate CHANGELOGS section but keep walking.
      if (BLANK_ROW_RE.test(stripped)) {
        acc.inChangelogs = false;
        return "continue";
      }

      // "Please update ..." footer.
      const footerM = stripped.match(FOOTER_RE);
      if (footerM) {
        acc.inChangelogs = false;
        acc.severityParts.push(`Note: ${footerM[1]}`);
        // Capture any URL in the footer text too.
        for (const url of extractUrls(footerM[1] ?? "")) {
          acc.untrustedUrls.push(url);
        }
        return "continue";
      }

      // Generic table row — CHANGELOGS bullet or misc content.
      const rowM = stripped.match(ROW_RE);
      if (rowM) {
        const content = rowM[1] ?? "";
        if (acc.inChangelogs) {
          acc.severityParts.push(`Changelog: ${content}`);
        }
        // Any URL found in a row goes into the untrusted-URL bucket, to be
        // resolved against the (empty) allowlist at emit time.
        for (const url of extractUrls(content)) {
          acc.untrustedUrls.push(url);
        }
        return "continue";
      }

      // Unknown intermediate line — tolerate within the 20-line budget.
      return "continue";
    },
  });

  if (!result) return null;

  const { accumulator: acc, linesConsumed } = result;

  if (!acc.current || !acc.announced) return null;

  // Slug resolution: prefer explicit Variant A slug; fall back to Variant B
  // script-prefix token.  If neither canonicalizes, drop the notice.
  const slugCandidate =
    acc.explicitSlug ?? (acc.scriptToken !== null ? acc.scriptToken : "");
  const slug = canonicalSlug(slugCandidate);
  if (!slug) return null;

  // Resolve any captured URLs against the trusted-domains allowlist.  With
  // trustedDomains=[] every URL fails and is demoted.  When trustedDomains
  // eventually grows, the first passing URL becomes releaseNotesUrl.
  let releaseNotesUrl: string | undefined;
  const severityParts = [...acc.severityParts];

  for (const raw of acc.untrustedUrls) {
    const check = checkUrl(raw, trusted);
    if (check.ok && releaseNotesUrl === undefined) {
      releaseNotesUrl = check.url.toString();
    } else {
      severityParts.push(`URL: ${raw}`);
    }
  }

  // Newline-join — vendor notes can contain semicolons, and Task 4's
  // convention (`codesign.ts`) already uses `\n` so operators see one
  // fragment per line in Discord embeds.
  const severityNote =
    severityParts.length > 0 ? severityParts.join("\n") : undefined;

  return {
    canonicalSlug: slug,
    current: acc.current,
    announced: acc.announced,
    releaseNotesUrl,
    severityNote,
    linesConsumed,
    patternId: promptPattern.id,
  };
}

/** The Prompt pattern registration.  See module JSDoc for contract. */
export const promptPattern: NoticePattern = {
  id: "prompt-v1",
  description:
    "Prompt vendor boxed-table '⚠️  UPDATE AVAILABLE' notice (prompt_sandy_* + siblings).",
  trustedDomains: [],
  blockMatch,
  canonicalSlug,
};
