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

// ---------------------------------------------------------------------------
// Task 9 — scanner output types.
//
// The scanner produces 4 buckets (available / suppressed / unknownSource /
// unmapped). Three of them share a `ResourceSignal` base plus a `source` tag;
// `unmapped` is shaped slightly differently because it has no grantId / no
// portal context by definition.
//
// Task 4 seeded `NoticePattern` / `LogNoticeMatch` / `BlockState` above; Task 9
// adds the merged-output shapes here so the whole updates subsystem shares one
// type module.
// ---------------------------------------------------------------------------

/**
 * Canonical shape for both portal-signal and log-signal rows once merged.
 * Three of the four output buckets wrap this with a `source` tag plus an
 * optional `reason`. The `unmapped` bucket uses `UnmappedRow` instead (no
 * `grantId`, no `updatedAt`).
 */
export interface ResourceSignal {
  /** Canonical resource slug (exact match with mapping entry's `slug`). */
  slug: string;
  /** Portal grant ID when the entry is mapped; absent for unmapped rows. */
  grantId?: number;
  /**
   * Locally-installed version. `null` when no reliable current version is
   * available (portal-only signal where state.versionId is a numeric pack-id,
   * not a semver string — see spec review R3).
   */
  current: string | null;
  /** Upstream announced version (semver string, or stringified portal field). */
  announced: string;
  /** Vendor release-notes URL, only set if the pattern's URL allowlist passed. */
  releaseNotesUrl?: string;
  /** Plain-text operator hint (vendor commentary + untrusted-URL fallback). */
  severityNote?: string;
  /** Portal `updatedAt` (ISO8601) when portal signal participated. */
  updatedAt?: string;
  /** True iff the log input contained a `Started resource <slug>` boundary. */
  boundaryKnown: boolean;
}

/** Origin of the merged signal. */
export type SignalSource = "portal" | "log" | "portal+log";

/** Mapped signal in the `available` bucket. */
export type AvailableRow = ResourceSignal & { source: SignalSource };

/** Why a mapped signal was suppressed. */
export type SuppressedReason =
  | "local-ahead"              // local semver > announced
  | "local-equal"              // local semver == announced (heartbeat)
  | "ignore-upstream-updates"; // operator flagged as a fork

/** Mapped signal in the `suppressed` bucket. */
export type SuppressedRow = ResourceSignal & {
  source: SignalSource;
  reason: SuppressedReason;
};

/** Why a mapped signal couldn't be semver-compared. */
export type UnknownSourceReason =
  | "no-semver"        // both sides present but one/both non-semver
  | "missing-current"  // current was empty / null
  | "missing-announced"; // announced was empty

/** Mapped signal in the `unknownSource` bucket. */
export type UnknownSourceRow = ResourceSignal & {
  source: SignalSource;
  reason: UnknownSourceReason;
};

/**
 * Unmapped signal — a log notice whose canonical slug doesn't match any
 * mapping entry. These have no `grantId` and no portal context, so the shape
 * is narrower than `ResourceSignal`.
 */
export interface UnmappedRow {
  slug: string;
  current: string | null;
  announced: string;
  /** Only log signal can produce unmapped rows. */
  source: "log";
  releaseNotesUrl?: string;
  severityNote?: string;
  boundaryKnown: boolean;
}

/**
 * Return shape of `scanUpdates`. Mirrors the spec's tool API output shape
 * 1:1 — Task 10 (cfx_scan_updates MCP tool) maps this to the public zod
 * schema unchanged.
 */
export interface ScanUpdatesResult {
  available: AvailableRow[];
  suppressed: SuppressedRow[];
  unknownSource: UnknownSourceRow[];
  unmapped: UnmappedRow[];
  /** Exact pass-through of `parseNotices` result (0 when no logLines). */
  scannedLogLines: number;
  /** True iff `Started resource <slug>` boundary was observed in the log. */
  logHasStartupBoundary: boolean;
  /** True iff `cfx_check_updates` actually hit the portal this run. */
  portalPolled: boolean;
  /** True iff the portal result came from the 1h rate-limit cache. */
  portalFromCache: boolean;
}
