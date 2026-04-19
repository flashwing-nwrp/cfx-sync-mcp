/**
 * Scanner — Phase 1.6 Task 9.
 *
 * Pure orchestrator that merges portal + log signals into the 4-bucket
 * ScanUpdatesResult (available / suppressed / unknownSource / unmapped).
 *
 * Architecture constraints:
 *  - **Pure function.** No I/O, no Date.now(), no logger, no direct MCP calls.
 *    All dependencies are injected as function parameters.
 *  - **No MCP-to-MCP wiring.** `checkUpdatesFn` is a function reference; the
 *    Task 10 tool layer passes the real `cfx_check_updates` bound to a thin
 *    adapter; tests inject a mock. Scanner does NOT import from `src/mcp/**`.
 *  - **No state mutation.** Scanner is read-only — never calls Mapping.save()
 *    or State.save(). Filter and observe, nothing more.
 *
 * Algorithm (spec § "Signal source merge"):
 *
 *   Pass 1 — mapped resources. For each MappingEntry in scope:
 *     1. Look up portal signal by grantId.
 *     2. Look up log signal by canonicalSlug === entry.slug.
 *     3. If neither fired, skip. (`ignoreUpstreamUpdates` only matters when
 *        there's something to suppress; no signal = no bucket.)
 *     4. If entry.ignoreUpstreamUpdates === true → suppressed with
 *        reason `"ignore-upstream-updates"`. Short-circuits the semver compare.
 *     5. Determine `source` ("portal" | "log" | "portal+log") from which
 *        signals fired.
 *     6. Resolve current + announced (log wins when present; fall back to
 *        state / portal fields).
 *     7. Run `compareLoose(current, announced)`:
 *          "behind"       → available
 *          "ahead"        → suppressed:local-ahead
 *          "equal"        → suppressed:local-equal
 *          "incomparable" → unknownSource (reason inferred from which side is bad)
 *
 *   Pass 2 — unmapped log signals. For each log notice whose canonicalSlug
 *   doesn't match any mapping entry's slug: push to `unmapped`. Skipped when a
 *   slug/grantId filter is active (operator is asking about a specific mapped
 *   resource).
 *
 * See `docs/superpowers/specs/2026-04-19-cfx-sync-update-scanner-design.md`
 * § "Signal source merge" and § "Tool API" for the full contract.
 */

import type {
  NoticePattern,
  LogNoticeMatch,
  ResourceSignal,
  SignalSource,
  UnknownSourceReason,
  AvailableRow,
  SuppressedRow,
  UnknownSourceRow,
  UnmappedRow,
  ScanUpdatesResult,
} from "./types.js";
import type { MappingFile, MappingEntry } from "../state/mapping.js";
import type { AssetState } from "../state/state.js";
import type { ParseNoticesResult } from "./logScraper.js";
import { compareLoose } from "./semverCompare.js";
import { NotFoundError } from "../errors.js";

// ---------------------------------------------------------------------------
// Dependency-injection shapes.
//
// The scanner does NOT import the real cfx_check_updates tool or the State
// class — those pull in fs / env / cookie-jar machinery that would break
// purity. Instead we declare the minimal interface the scanner needs and let
// the caller (Task 10 tool layer) adapt the real implementations.
// ---------------------------------------------------------------------------

/**
 * Shape of the `cfx_check_updates` result the scanner consumes.
 * Intentionally thinner than the MCP zod schema so this module stays free of
 * MCP-layer imports. Task 10's tool layer adapts the real output to this
 * shape.
 */
export interface CheckUpdatesResult {
  updated: Array<{
    grantId: number;
    slug: string;
    assetName: string;
    /** Portal `updatedAt` (ISO8601). */
    updatedAt: string;
    /**
     * Portal versionId. Present when the portal exposed it; used as a
     * string-coerced fallback for `announced` when no log signal fired.
     */
    versionId?: number;
  }>;
  /** True iff the rate-limit gate short-circuited the portal call. */
  stale: boolean;
  /** True iff the result came from the 1h rate-limit cache. */
  portalFromCache: boolean;
}

export type CheckUpdatesFn = (input: { force: boolean }) => Promise<CheckUpdatesResult>;

export type ParseNoticesFn = (
  lines: string[],
  patterns: readonly NoticePattern[]
) => ParseNoticesResult;

/**
 * Minimal State surface the scanner reads. Lets tests pass a plain object
 * without instantiating the real State class (which would pull fs + StateLock
 * into the test path). The real State.get matches this signature.
 */
export interface StateGetter {
  get(grantId: number): AssetState | undefined;
}

export interface ScanUpdatesInput {
  /** Filter to one resource by canonical slug. Mutually exclusive with grantId at MCP schema layer. */
  slug?: string;
  /** Filter to one resource by grantId. */
  grantId?: number;
  /** Raw log lines for the log-signal pass. If absent, scanner runs portal-only. */
  logLines?: string[];
  /** If true, bypass the 1h portal rate-limit cache. Defaults to false. */
  forcePortal?: boolean;

  state: StateGetter;
  mapping: MappingFile;
  patterns: readonly NoticePattern[];
  checkUpdatesFn: CheckUpdatesFn;
  parseNoticesFn: ParseNoticesFn;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export async function scanUpdates(input: ScanUpdatesInput): Promise<ScanUpdatesResult> {
  // --- Phase A: collect log signal (optional) ---------------------------
  const logResult: ParseNoticesResult = input.logLines !== undefined
    ? input.parseNoticesFn(input.logLines, input.patterns)
    : { notices: [], scannedLogLines: 0, logHasStartupBoundary: false };

  // --- Phase B: portal signal (always call so portalFromCache is accurate) ---
  const portal = await input.checkUpdatesFn({ force: input.forcePortal ?? false });
  const portalPolled = !portal.stale;

  // --- Phase C: determine which mapping entries are in scope ------------
  const entriesToScan = selectEntriesToScan(input);

  // Fast index of portal updates by grantId for O(1) lookup in Pass 1.
  const portalByGrant = new Map<number, CheckUpdatesResult["updated"][number]>();
  for (const u of portal.updated) portalByGrant.set(u.grantId, u);

  // Index of log notices by canonicalSlug. `parseNotices` already dedups by
  // (canonicalSlug, current, announced), so a slug can still have multiple
  // entries in theory — but in practice only the latest matters. Take the
  // first occurrence; same behavior as Map.set.
  const logBySlug = new Map<string, LogNoticeMatch>();
  for (const n of logResult.notices) logBySlug.set(n.canonicalSlug, n);

  // Build a set of ALL mapped slugs (not just in-scope) so Pass 2 doesn't
  // misfire on log signals for mapped-but-disabled resources.
  const allMappedSlugs = new Set<string>();
  for (const e of Object.values(input.mapping.entries)) allMappedSlugs.add(e.slug);

  // --- Phase D: Pass 1 — mapped entries --------------------------------
  const available: AvailableRow[] = [];
  const suppressed: SuppressedRow[] = [];
  const unknownSource: UnknownSourceRow[] = [];

  for (const [grantIdStr, entry] of entriesToScan) {
    const grantId = Number(grantIdStr);
    const portalSignal = portalByGrant.get(grantId);
    const logSignal = logBySlug.get(entry.slug);

    // Neither signal fired — nothing to bucket.
    if (portalSignal === undefined && logSignal === undefined) continue;

    const source: SignalSource =
      portalSignal !== undefined && logSignal !== undefined
        ? "portal+log"
        : portalSignal !== undefined
          ? "portal"
          : "log";

    // Resolve current + announced. Log signal wins when present for both
    // fields — it's the in-game truth. Fall back to state / portal only when
    // log didn't fire or left the field blank.
    const { current, announced } = resolveVersions({
      entry,
      state: input.state,
      grantId,
      portalSignal,
      logSignal,
    });

    const base: ResourceSignal = {
      slug: entry.slug,
      grantId,
      current,
      announced,
      boundaryKnown: logResult.logHasStartupBoundary,
    };
    if (logSignal?.releaseNotesUrl !== undefined) base.releaseNotesUrl = logSignal.releaseNotesUrl;
    if (logSignal?.severityNote !== undefined) base.severityNote = logSignal.severityNote;
    if (portalSignal?.updatedAt !== undefined) base.updatedAt = portalSignal.updatedAt;

    // ignoreUpstreamUpdates short-circuits the semver compare.
    if (entry.ignoreUpstreamUpdates === true) {
      suppressed.push({ ...base, source, reason: "ignore-upstream-updates" });
      continue;
    }

    // Run semver comparison. `compareLoose("", announced)` returns
    // "incomparable" per its contract, so we don't special-case null here —
    // the reason extractor below disambiguates.
    const cmp = compareLoose(current ?? "", announced);
    switch (cmp) {
      case "behind":
        available.push({ ...base, source });
        break;
      case "ahead":
        suppressed.push({ ...base, source, reason: "local-ahead" });
        break;
      case "equal":
        suppressed.push({ ...base, source, reason: "local-equal" });
        break;
      case "incomparable": {
        const reason: UnknownSourceReason = inferUnknownReason(current, announced);
        unknownSource.push({ ...base, source, reason });
        break;
      }
    }
  }

  // --- Phase E: Pass 2 — unmapped log signals --------------------------
  // Skip unmapped scan when a filter is active — operator is asking about a
  // specific mapped resource.
  const filterActive = input.grantId !== undefined || input.slug !== undefined;
  const unmapped: UnmappedRow[] = [];
  if (!filterActive) {
    for (const n of logResult.notices) {
      if (allMappedSlugs.has(n.canonicalSlug)) continue; // handled in Pass 1 (or mapped-but-disabled)
      const row: UnmappedRow = {
        slug: n.canonicalSlug,
        current: n.current,
        announced: n.announced,
        source: "log",
        boundaryKnown: logResult.logHasStartupBoundary,
      };
      if (n.releaseNotesUrl !== undefined) row.releaseNotesUrl = n.releaseNotesUrl;
      if (n.severityNote !== undefined) row.severityNote = n.severityNote;
      unmapped.push(row);
    }
  }

  return {
    available,
    suppressed,
    unknownSource,
    unmapped,
    scannedLogLines: logResult.scannedLogLines,
    logHasStartupBoundary: logResult.logHasStartupBoundary,
    portalPolled,
    portalFromCache: portal.portalFromCache,
  };
}

// ---------------------------------------------------------------------------
// Helpers (module-local; not exported)
// ---------------------------------------------------------------------------

/**
 * Resolve which mapping entries participate in Pass 1.
 * - `grantId` → one entry (throws NotFoundError if missing)
 * - `slug` → one entry by slug match (throws NotFoundError if missing)
 * - neither → all entries where disabled === false
 */
function selectEntriesToScan(
  input: ScanUpdatesInput
): Array<[string /*grantIdStr*/, MappingEntry]> {
  if (input.grantId !== undefined) {
    const grantIdStr = String(input.grantId);
    const entry = input.mapping.entries[grantIdStr];
    if (entry === undefined) {
      throw new NotFoundError(`No mapping entry for grantId ${input.grantId}`);
    }
    return [[grantIdStr, entry]];
  }
  if (input.slug !== undefined) {
    const match = Object.entries(input.mapping.entries).find(
      ([, e]) => e.slug === input.slug
    );
    if (match === undefined) {
      throw new NotFoundError(`No mapping entry for slug "${input.slug}"`);
    }
    return [match];
  }
  // Default: all enabled entries.
  return Object.entries(input.mapping.entries).filter(([, e]) => e.disabled === false);
}

/**
 * Resolve `current` + `announced` for a mapped entry.
 *
 * Priority:
 *  - `current`: log.current (if non-empty) → state.versionId (only when it's a
 *    non-numeric semver-ish string; numeric pack-ids bail to null per spec R3)
 *    → null
 *  - `announced`: log.announced (if non-empty) → portal.versionId (stringified)
 *    → portal.updatedAt → "" (forces `missing-announced` downstream)
 */
function resolveVersions(args: {
  entry: MappingEntry;
  state: StateGetter;
  grantId: number;
  portalSignal: CheckUpdatesResult["updated"][number] | undefined;
  logSignal: LogNoticeMatch | undefined;
}): { current: string | null; announced: string } {
  const { state, grantId, portalSignal, logSignal } = args;

  // --- current ---
  let current: string | null;
  if (logSignal !== undefined && logSignal.current !== "") {
    current = logSignal.current;
  } else if (logSignal !== undefined && logSignal.current === "") {
    // Log explicitly reported empty current — preserve empty so the reason
    // extractor picks "missing-current" over "no-semver". We use "" (empty
    // string) instead of null so `compareLoose` returns "incomparable" via
    // its empty-guard and the downstream reason is deterministic.
    current = "";
  } else {
    // No log signal. Look at state.versionId — which is a `number` per the
    // AssetState schema. Numeric pack-ids don't semver-compare meaningfully
    // against portal.updatedAt, so default to null (→ "missing-current" /
    // "no-semver" reason).
    const st = state.get(grantId);
    if (st === undefined) {
      current = null;
    } else {
      // state.versionId is always number in v3. We deliberately do NOT coerce
      // it to a string — a pack-id like 18765 is not a semver and must flow
      // through as null. Future schema versions may carry a semver-string
      // alongside; this branch is the extension point.
      current = null;
    }
  }

  // --- announced ---
  let announced: string;
  if (logSignal !== undefined && logSignal.announced !== "") {
    announced = logSignal.announced;
  } else if (portalSignal !== undefined) {
    // Prefer portal.versionId (numeric) stringified over updatedAt — but both
    // will typically be non-semver, landing in unknownSource with no-semver.
    // That's fine; the spec expects portal-only entries without a log signal
    // to frequently hit unknownSource until the log layer catches up.
    if (portalSignal.versionId !== undefined) {
      announced = String(portalSignal.versionId);
    } else {
      announced = portalSignal.updatedAt;
    }
  } else {
    // Neither log nor portal — shouldn't reach here (caller filtered to
    // "signal present"), but be defensive.
    announced = "";
  }

  return { current, announced };
}

/**
 * Map compareLoose's "incomparable" outcome onto a typed UnknownSourceReason.
 *
 *  - current null/empty → "missing-current"
 *  - announced empty    → "missing-announced"
 *  - both present but un-coercible → "no-semver"
 */
function inferUnknownReason(
  current: string | null,
  announced: string
): UnknownSourceReason {
  if (current === null || current === "") return "missing-current";
  if (announced === "") return "missing-announced";
  return "no-semver";
}

// Re-export types commonly consumed alongside the scanner so downstream
// callers (Task 10 tool layer) don't have to import from two modules.
export type {
  ResourceSignal,
  SignalSource,
  SuppressedReason,
  UnknownSourceReason,
  AvailableRow,
  SuppressedRow,
  UnknownSourceRow,
  UnmappedRow,
  ScanUpdatesResult,
} from "./types.js";
