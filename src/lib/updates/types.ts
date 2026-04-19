/**
 * Shared types for the Phase 1.6 update scanner.
 *
 * Phase 1.6 Task 4 seeds these interfaces; Task 9 extends types.ts with
 * ResourceSignal + ScanUpdatesResult when the scanner's 4-bucket output shape
 * lands.  Keeping everything in one module lets downstream pattern modules
 * import a single public surface.
 *
 * A `NoticePattern` is the per-author plugin that parses a specific vendor's
 * in-game "update available" log block.  Patterns are DATA, not code — adding
 * a new author is a PR to the registry with a fixture + unit test, nothing in
 * the core engine changes.
 *
 * See `docs/superpowers/specs/2026-04-19-cfx-sync-update-scanner-design.md`
 * § "Signal source 2 — Log scraper (new)" for the full contract and state
 * machine documentation.
 */

/**
 * Self-contained parser for one author's in-game update notice format.
 * Each pattern owns its own block regex, canonical-slug normalizer, and the
 * list of vendor domains it trusts for release-notes URLs.
 */
export interface NoticePattern {
  /** Stable pattern identifier, e.g. "codesign-v1", "ulc-v1". */
  id: string;

  /** Human-readable description, surfaced in logger output + debug tooling. */
  description: string;

  /**
   * Attempt to match a notice block starting at `lines[startIdx]`.
   *
   * The line at `startIdx` must be the pattern's identifying-line / opener;
   * the caller (logScraper in Task 8) is responsible for probing each line
   * for a potential opener before invoking blockMatch.
   *
   * Returns `null` if:
   *  - The starting line is not a valid opener for this pattern
   *  - The block is truncated (EOF before required fields captured)
   *  - The block exceeds the pattern's line-timeout window without completing
   *  - Any required field (version strings, slug token) is missing
   */
  blockMatch(lines: string[], startIdx: number): LogNoticeMatch | null;

  /**
   * Normalize a log-side slug token (e.g. `"[cd_dispatch]"`, `"[ULC]"`) to
   * the canonical mapping key used by `cfx-sync-map.json`.  Returns `null`
   * when the token does not resolve to a valid mapping-key shape.
   *
   * Implementations MUST NOT accept tokens containing the `script:` prefix —
   * the logScraper strips the `[script:<token>]` wrapper before calling.
   */
  canonicalSlug(logToken: string): string | null;

  /**
   * Vendor domains whose URLs are safe to surface as `releaseNotesUrl`.  Any
   * URL off this list is demoted to a plain text fragment inside
   * `severityNote` and NOT exposed as a URL field.  Applied via
   * `urlAllowlist.checkUrl`.  See that module for the exact-host-equality
   * policy.
   */
  trustedDomains: string[];
}

/**
 * Successful match of a notice block.  `linesConsumed` lets the caller
 * advance past the block to avoid re-scanning its contents.
 */
export interface LogNoticeMatch {
  /** Canonical mapping key (lowercase, normalized). */
  canonicalSlug: string;

  /** Locally-installed version as the resource reported it. */
  current: string;

  /** Upstream version the resource announced as available. */
  announced: string;

  /**
   * Optional vendor changelog / release-notes URL.  Only set when the URL
   * passed the pattern's `trustedDomains` allowlist check.
   */
  releaseNotesUrl?: string;

  /**
   * Optional plain-text operator hint.  Collects "Notes: ..." content and any
   * URL that failed the trusted-domain check (demoted here as text).
   */
  severityNote?: string;

  /**
   * Number of input lines the block spanned, counted from the opener
   * inclusive.  Caller advances `startIdx += linesConsumed` to continue
   * scanning past this match.
   */
  linesConsumed: number;

  /** Which pattern produced this match; threads through for observability. */
  patternId: string;
}

/**
 * State-machine phase for a single per-token block parser instance.
 *
 *  - `IDLE`     Waiting for the pattern's opener line.
 *  - `IN_BLOCK` Opener seen; accumulating required / optional fields.
 *  - `COMPLETE` All required fields captured; parser emits and resets.
 *
 * See `blockStateMachine.ts` for the transition rules.
 *
 * Consumed by Task 8 logScraper correlation layer. Kept here so all
 * updates-module types sit in one file.
 */
export type BlockState = "IDLE" | "IN_BLOCK" | "COMPLETE";
