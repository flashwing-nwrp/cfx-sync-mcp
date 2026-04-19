/**
 * Codesign author notice pattern.
 *
 * Handles the "New Update Available!" block that Codesign-authored resources
 * (cd_bridge, cd_doorlock, cd_dispatch, cd_carhud, …) emit once per boot
 * when an upstream release differs from the locally-installed version.
 *
 * Block shape (real FLRP capture):
 *
 *     =====================================================================
 *     [cd_bridge] - New Update Available!
 *     Current Version: 1.0.23.
 *     New Version: 1.0.26.
 *     Released: 5 days ago.
 *     Notes: Another Major Update - Please Update.
 *     Download: https://portal.cfx.re/assets/granted-assets?search=cd_bridge.
 *     Changelog: https://docs.codesign.pro/paid-scripts/bridge/changelog.
 *     =====================================================================
 *
 * Each line carries a `[script:<token>]` prefix in the raw FiveM log — this
 * pattern ignores the prefix and matches against the bracketed slug that
 * follows (`[cd_bridge]`).
 *
 * Security / trust:
 *  - Only the `Changelog:` URL is extracted as `releaseNotesUrl`.  `Download:`
 *    is ignored per plan line 58 — it often points at a portal or keymaster
 *    URL that isn't the changelog.
 *  - `Changelog:` URL must pass `urlAllowlist.checkUrl` against
 *    `trustedDomains`.  Any failing URL is demoted to plain text inside
 *    `severityNote` so operators can still see what was announced.
 *  - `trustedDomains` includes `keymaster.fivem.net` because cd_dispatch's
 *    real fixture has `Download:` pointing at keymaster (even though we
 *    don't surface Download at all, the allowlist stays permissive enough
 *    that if Codesign ever swaps Changelog host we don't regress silently).
 *
 * Version regex is anchored (`^Current Version:\s*(\S+?)\.?$`) to reject
 * newline-smuggled composite inputs — defence-in-depth for the Task 8
 * adversarial plan.  Codesign versions commonly have a trailing period in
 * their log output ("1.0.23."); the optional `\.?$` strips it.
 *
 * Pure: no I/O, no logger, no `Date.now()`.  Task 9 scanner owns the
 * semver compare step — this module emits raw strings.
 */

import type { NoticePattern, LogNoticeMatch } from "../types.js";
import { walkBlock } from "../blockStateMachine.js";
import { checkUrl } from "../urlAllowlist.js";

/** Regex for the opening "[<slug>] - New Update Available!" line.  Anchored
 *  to `^` so intermediate lines that happen to contain the phrase cannot be
 *  mistaken for openers. */
const OPENER_RE = /^\[([a-z0-9_-]+)\]\s*-\s*New Update Available!/i;

/**
 * Strict version regex — must end at string boundary (optional trailing dot)
 * so `Current Version: 1.0.0.\nNew Version: 9.9.9` smuggled into a single
 * array element cannot match "1.0.0".  Line content is stripped of the
 * `[script:...]` prefix before we apply it.
 */
const CURRENT_VERSION_RE = /^Current Version:\s*(\S+?)\.?$/;
const NEW_VERSION_RE = /^New Version:\s*(\S+?)\.?$/;
const NOTES_RE = /^Notes:\s*(.+?)\.?$/;
const CHANGELOG_RE = /^Changelog:\s*(\S+?)\.?$/;
const CLOSING_BANNER_RE = /^={5,}$/;

/**
 * Strip the leading `[ script:<token>]` FiveM log prefix off a raw log line
 * to get at the author-emitted content.  Codesign lines arrive looking like
 * `"[    script:cd_bridge] Current Version: 1.0.23."` — we need just the
 * `"Current Version: 1.0.23."` tail.  If no prefix is found (e.g. caller
 * already stripped), return the line unchanged.
 */
function stripScriptPrefix(line: string): string {
  // Leading bracket-wrapped `script:...` with optional whitespace padding.
  // Example matches: "[script:foo] ", "[    script:foo] ", "[ script:foo] ".
  const m = line.match(/^\[\s*script:[^\]]+\]\s?(.*)$/);
  return m ? (m[1] ?? "") : line;
}

/** Accumulator carried across lines while IN_BLOCK. */
interface CodesignAccumulator {
  canonicalSlug: string;
  current?: string;
  announced?: string;
  notesText?: string;
  changelogUrl?: string;
}

/**
 * Normalize a log-side slug token to the canonical mapping key.
 *
 * Accepts bare `cd_bridge` or bracket-wrapped `[cd_bridge]`, lowercases,
 * replaces dashes with underscores (Codesign has been observed emitting
 * `[cd-dispatch-]` in early resource versions — see spec § Extrapolation),
 * then strips trailing underscores so `[cd-dispatch-]` → `cd_dispatch`.
 *
 * Returns `null` if:
 *  - Input is empty after strip/normalize
 *  - Input contains `script:` (caller fed raw `[script:...]` prefix — the
 *    logScraper in Task 8 is responsible for stripping that first)
 *  - Input contains characters outside `[a-z0-9_-]` (whitespace, `$`, …)
 *
 * Policy note:
 *  - Inputs without the Codesign "cd_" prefix are normalized through without
 *    rejection. Pattern-level discrimination happens via OPENER_RE in
 *    blockMatch, not here. Keeps future Codesign subbrands frictionless.
 */
function canonicalSlug(logToken: string): string | null {
  if (!logToken) return null;

  // Strip surrounding brackets if present.
  const bracketed = logToken.match(/^\[(.+)\]$/);
  const inner = bracketed ? (bracketed[1] ?? "") : logToken;

  if (inner.length === 0) return null;

  // Reject script:-prefixed input — that's a caller bug.
  if (inner.includes(":")) return null;

  // Validate character set BEFORE normalization so whitespace / special chars
  // surface as null rather than silently producing a mangled slug.
  if (!/^[a-z0-9_-]+$/i.test(inner)) return null;

  // Normalize: lowercase, dashes → underscores, trim trailing underscores.
  // The pre-normalization class check above (line with `/^[a-z0-9_-]+$/i`) plus
  // this empty-string guard fully validate the result — no post-normalize
  // regex needed (dash→underscore cannot introduce out-of-class characters).
  const normalized = inner
    .toLowerCase()
    .replace(/-/g, "_")
    .replace(/_+$/, "");

  if (normalized.length === 0) return null;

  return normalized;
}

/**
 * Attempt to match a Codesign notice block starting at `lines[startIdx]`.
 * See module JSDoc for the expected block shape.
 *
 * Input lines may be either raw FiveM log lines (with `[script:<token>]`
 * prefix) or pre-stripped content lines. Both are accepted; the pattern
 * internally strips the prefix if present.
 *
 * When multiple severity fragments (Notes text + a demoted untrusted URL)
 * land on the same match, they are joined with a literal newline so that
 * operators reading the output in Discord embeds can see one fragment per
 * line and vendor-supplied semicolons inside Notes text remain unambiguous.
 */
function blockMatch(lines: string[], startIdx: number): LogNoticeMatch | null {
  const trusted = codesignPattern.trustedDomains;

  const result = walkBlock<CodesignAccumulator>(lines, startIdx, {
    onOpener(line) {
      const stripped = stripScriptPrefix(line);
      const m = stripped.match(OPENER_RE);
      if (!m) return null;
      const slug = canonicalSlug(m[1] ?? "");
      if (!slug) return null;
      return { canonicalSlug: slug };
    },
    onLine(line, acc) {
      const stripped = stripScriptPrefix(line);

      // Closing banner: block complete only if both required versions landed.
      if (CLOSING_BANNER_RE.test(stripped)) {
        return acc.current && acc.announced ? "complete" : "reset";
      }

      const currentM = stripped.match(CURRENT_VERSION_RE);
      if (currentM) {
        acc.current = currentM[1];
        return "continue";
      }

      const newM = stripped.match(NEW_VERSION_RE);
      if (newM) {
        acc.announced = newM[1];
        return "continue";
      }

      const notesM = stripped.match(NOTES_RE);
      if (notesM) {
        acc.notesText = notesM[1];
        return "continue";
      }

      const changelogM = stripped.match(CHANGELOG_RE);
      if (changelogM) {
        acc.changelogUrl = changelogM[1];
        return "continue";
      }

      // Unknown intermediate line (e.g. "Released:" or "Download:") — tolerate
      // within the 20-line budget.  walkBlock enforces the timeout.
      return "continue";
    },
  });

  if (!result) return null;

  const { accumulator: acc, linesConsumed } = result;

  if (!acc.current || !acc.announced) return null;

  // Evaluate the Changelog URL against the trusted-domains list.  Trusted
  // → promote to releaseNotesUrl.  Untrusted → demote to severityNote plain
  // text so the operator can still see what the resource announced.
  let releaseNotesUrl: string | undefined;
  const severityParts: string[] = [];

  if (acc.notesText) {
    severityParts.push(`Notes: ${acc.notesText}`);
  }

  if (acc.changelogUrl) {
    const check = checkUrl(acc.changelogUrl, trusted);
    if (check.ok) {
      releaseNotesUrl = check.url.toString();
    } else {
      severityParts.push(`Changelog: ${acc.changelogUrl}`);
    }
  }

  // Newline-join (not "; ") — vendor Notes text can legitimately contain
  // semicolons (e.g. "Fix; break; run.") which would collide with "; ".
  const severityNote = severityParts.length > 0 ? severityParts.join("\n") : undefined;

  return {
    canonicalSlug: acc.canonicalSlug,
    current: acc.current,
    announced: acc.announced,
    releaseNotesUrl,
    severityNote,
    linesConsumed,
    patternId: codesignPattern.id,
  };
}

/** The Codesign pattern registration.  See module JSDoc for contract. */
export const codesignPattern: NoticePattern = {
  id: "codesign-v1",
  description:
    "Codesign 'New Update Available!' notice block — cd_bridge, cd_doorlock, cd_dispatch, etc.",
  trustedDomains: ["docs.codesign.pro", "portal.cfx.re", "keymaster.fivem.net"],
  blockMatch,
  canonicalSlug,
};
