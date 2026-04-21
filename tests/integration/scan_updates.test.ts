/**
 * Phase 1.6 Task 12 — scan_updates integration tests.
 *
 * End-to-end exercise of the update-scanner pipeline against the real
 * `flrp-boot-2000.log` fixture (2000 lines captured from a live FLRP cold
 * boot). Runs the full chain: parseNotices → PATTERNS → scanner.scanUpdates,
 * with an injected mock `checkUpdatesFn` so we don't hit the portal.
 *
 * The fixture includes 3 Codesign notices (cd_bridge, cd_doorlock,
 * cd_dispatch) and 1 ULC notice — spanning ≥2 patterns with ≥4 real signals.
 *
 * Why Approach A (lib-layer entry, not MCP tool):
 *  - scanUpdates() is pure — no cookie/portal/fs setup needed.
 *  - Proves parser + patterns + scanner merge end-to-end on real log data.
 *  - Task 10/11 MCP adapter + tmp-dir scenarios live in tests/unit/mcp/ already.
 *
 * See `docs/superpowers/specs/2026-04-19-cfx-sync-update-scanner-design.md`
 * § "Test plan / Integration" and the plan's Task 12 entry.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { scanUpdates } from "../../src/lib/updates/scanner.js";
import { parseNotices } from "../../src/lib/updates/logScraper.js";
import { PATTERNS } from "../../src/lib/updates/patterns/index.js";
import type { MappingFile, MappingEntry } from "../../src/lib/state/mapping.js";
import type { StateGetter } from "../../src/lib/updates/scanner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadFixture(name: string): string[] {
  const full = path.join(__dirname, "..", "fixtures", "log-snippets", name);
  const txt = readFileSync(full, "utf8");
  const lines = txt.split(/\r?\n/);
  // Drop trailing empty element from a file that ends in \n so
  // scannedLogLines matches visible line count.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function makeEntry(partial: Partial<MappingEntry> & { slug: string }): MappingEntry {
  return {
    slug: partial.slug,
    target: partial.target ?? `[cfx]/${partial.slug}`,
    status: partial.status ?? "active",
    reviewedByUser: partial.reviewedByUser ?? true,
    assetName: partial.assetName ?? partial.slug,
    discoveredTier: partial.discoveredTier ?? 1,
    discoveredConfidence: partial.discoveredConfidence ?? 1,
    preservePaths: null,
    preservePathsSource: null,
    ...(partial.ignoreUpstreamUpdates !== undefined
      ? { ignoreUpstreamUpdates: partial.ignoreUpstreamUpdates }
      : {}),
  };
}

const EMPTY_STATE: StateGetter = { get: () => undefined };

const NO_PORTAL_UPDATES = async () => ({
  updated: [],
  stale: false,
  portalFromCache: false,
});

describe("scan_updates integration — flrp-boot-2000 end-to-end", () => {
  const lines = loadFixture("flrp-boot-2000.log");

  // Baseline mapping: only cd_bridge mapped to a grantId so most notices
  // fall through to the `unmapped` bucket (where we can assert across slugs).
  const baselineMapping: MappingFile = {
    version: 4,
    approvedAt: "2025-01-01T00:00:00.000Z",
    newInstalls: [],
    orphaned: [],
    entries: {
      "101": makeEntry({ slug: "cd_bridge" }),
    },
  };

  it("parses >= 3 real notices across >= 2 distinct patterns from the 2000-line fixture", async () => {
    const result = await scanUpdates({
      logLines: lines,
      state: EMPTY_STATE,
      mapping: baselineMapping,
      patterns: PATTERNS,
      checkUpdatesFn: NO_PORTAL_UPDATES,
      parseNoticesFn: parseNotices,
    });

    const totalNotices =
      result.available.length +
      result.suppressed.length +
      result.unknownSource.length +
      result.unmapped.length;
    expect(totalNotices).toBeGreaterThanOrEqual(3);

    // Collect slugs across all buckets to probe pattern diversity. Since the
    // buckets don't expose `patternId`, we assert via slug membership — the
    // fixture has notices from Codesign (cd_*) + ULC (ulc).
    const allSlugs = new Set<string>([
      ...result.available.map((r) => r.slug),
      ...result.suppressed.map((r) => r.slug),
      ...result.unknownSource.map((r) => r.slug),
      ...result.unmapped.map((r) => r.slug),
    ]);

    const hasCodesign = [...allSlugs].some((s) => s.startsWith("cd_"));
    const hasUlc = allSlugs.has("ulc");
    const hasQs = [...allSlugs].some((s) => s.startsWith("qs_") || s.startsWith("qs-"));
    const hasPrompt = [...allSlugs].some((s) => s.startsWith("prompt_"));

    const patternsHit = [hasCodesign, hasUlc, hasQs, hasPrompt].filter(Boolean).length;
    expect(patternsHit).toBeGreaterThanOrEqual(2);

    // Sanity: the known 3 Codesign notices in the fixture should all appear.
    expect([...allSlugs]).toEqual(expect.arrayContaining(["cd_bridge", "cd_doorlock", "cd_dispatch"]));
  });

  it("logHasStartupBoundary: true (fixture contains 'Started resource' markers)", async () => {
    const result = await scanUpdates({
      logLines: lines,
      state: EMPTY_STATE,
      mapping: baselineMapping,
      patterns: PATTERNS,
      checkUpdatesFn: NO_PORTAL_UPDATES,
      parseNoticesFn: parseNotices,
    });
    expect(result.logHasStartupBoundary).toBe(true);
  });

  it("scannedLogLines equals fixture line count (exact pass-through)", async () => {
    const result = await scanUpdates({
      logLines: lines,
      state: EMPTY_STATE,
      mapping: baselineMapping,
      patterns: PATTERNS,
      checkUpdatesFn: NO_PORTAL_UPDATES,
      parseNoticesFn: parseNotices,
    });
    expect(result.scannedLogLines).toBe(lines.length);
  });

  it("does not false-positive on unrelated log lines (cd_bridge shows up as available, not on every resource line)", async () => {
    const result = await scanUpdates({
      logLines: lines,
      state: EMPTY_STATE,
      mapping: baselineMapping,
      patterns: PATTERNS,
      checkUpdatesFn: NO_PORTAL_UPDATES,
      parseNoticesFn: parseNotices,
    });

    // cd_bridge is the one mapped entry. Its notice has current=1.0.23,
    // announced=1.0.26 → "behind" → available bucket.
    const cdBridge = result.available.find((r) => r.slug === "cd_bridge");
    expect(cdBridge).toBeDefined();
    expect(cdBridge?.current).toBe("1.0.23");
    expect(cdBridge?.announced).toBe("1.0.26");
    expect(cdBridge?.source).toBe("log");

    // Resource-started lines like `Started resource qs-inventory` must NOT
    // produce any bucket row for qs-inventory (no notice = no signal).
    const qsInvEntries = [
      ...result.available,
      ...result.suppressed,
      ...result.unknownSource,
      ...result.unmapped,
    ].filter((r) => r.slug === "qs_inventory" || r.slug === "qs-inventory");
    expect(qsInvEntries.length).toBe(0);

    // Total notices must be bounded. The fixture has exactly 8 notice
    // triggers (grep-verified): 3 Codesign (cd_bridge/cd_doorlock/cd_dispatch)
    // + 1 ULC + 2 quasarstore (qs-inventory reports qs-advancedinventory,
    // qs-housing reports itself) + 2 prompt (prompt_sandy_illegal_garage
    // explicit + prompt_sandy_mechanic header-less). Cap of 10 leaves
    // headroom for dedup edge-cases while still catching false-positive
    // matching on the 2000 unrelated lines.
    const total =
      result.available.length +
      result.suppressed.length +
      result.unknownSource.length +
      result.unmapped.length;
    expect(total).toBeLessThanOrEqual(10);
    expect(total).toBeGreaterThanOrEqual(6);
  });

  it("ULC fork case — local-ahead when semver compare resolves (1.9.0 > v1.8.0)", async () => {
    // Add ULC to the mapping. Log signal supplies both current + announced
    // directly (ULC's 'My Version'/'Latest Version' lines), so the scanner
    // runs compareLoose("1.9.0", "v1.8.0") → "ahead" → suppressed:local-ahead.
    const forkMapping: MappingFile = {
      ...baselineMapping,
      entries: {
        ...baselineMapping.entries,
        "202": makeEntry({ slug: "ulc", assetName: "ultimate-lighting-controller" }),
      },
    };

    const result = await scanUpdates({
      logLines: lines,
      state: EMPTY_STATE,
      mapping: forkMapping,
      patterns: PATTERNS,
      checkUpdatesFn: NO_PORTAL_UPDATES,
      parseNoticesFn: parseNotices,
    });

    const ulcSuppressed = result.suppressed.find((r) => r.slug === "ulc");
    expect(ulcSuppressed).toBeDefined();
    expect(ulcSuppressed?.reason).toBe("local-ahead");
    expect(ulcSuppressed?.source).toBe("log");
    expect(ulcSuppressed?.current).toBe("1.9.0");
    expect(ulcSuppressed?.announced).toBe("v1.8.0");

    // Also: since ULC is now mapped, it must NOT appear in unmapped.
    expect(result.unmapped.some((r) => r.slug === "ulc")).toBe(false);
  });

  it("ULC fork case — ignoreUpstreamUpdates flag short-circuits to suppressed:ignore-upstream-updates", async () => {
    // Operator has run cfx_set_fork_mode → ignoreUpstreamUpdates=true. Scanner
    // must NOT semver-compare; it goes straight to suppressed with the
    // ignore-upstream-updates reason.
    const flaggedMapping: MappingFile = {
      ...baselineMapping,
      entries: {
        ...baselineMapping.entries,
        "202": makeEntry({
          slug: "ulc",
          assetName: "ultimate-lighting-controller",
          ignoreUpstreamUpdates: true,
        }),
      },
    };

    const result = await scanUpdates({
      logLines: lines,
      state: EMPTY_STATE,
      mapping: flaggedMapping,
      patterns: PATTERNS,
      checkUpdatesFn: NO_PORTAL_UPDATES,
      parseNoticesFn: parseNotices,
    });

    const ulcSuppressed = result.suppressed.find((r) => r.slug === "ulc");
    expect(ulcSuppressed).toBeDefined();
    expect(ulcSuppressed?.reason).toBe("ignore-upstream-updates");
  });

  it("portalPolled reflects stale=false from mocked check", async () => {
    const result = await scanUpdates({
      logLines: lines,
      state: EMPTY_STATE,
      mapping: baselineMapping,
      patterns: PATTERNS,
      checkUpdatesFn: NO_PORTAL_UPDATES,
      parseNoticesFn: parseNotices,
    });
    expect(result.portalPolled).toBe(true);
    expect(result.portalFromCache).toBe(false);
  });
});
