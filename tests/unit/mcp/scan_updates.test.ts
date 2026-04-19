/**
 * Phase 1.6 Task 10 — cfx_scan_updates MCP tool tests.
 *
 * Thin orchestrator, so tests focus on:
 *   1. Schema surface (input refinement + output round-trip)
 *   2. TOOLS registry entry + dispatch wiring
 *   3. Static assertion: no outbound MCP imports in scan_updates.ts
 *
 * The end-to-end behavior (portal poll + log merge) is exercised via the
 * pure scanner's own tests (tests/unit/lib/updates/scanner.test.ts) plus the
 * Task 12 integration harness. Here we verify only the adapter + schema layer.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ScanUpdatesInput, ScanUpdatesOutput } from "../../../src/mcp/schemas/index.js";
import { TOOLS, toolNames } from "../../../src/mcp/tools/index.js";
import { dispatch } from "../../../src/mcp/dispatch.js";
import type { ScanUpdatesResult } from "../../../src/lib/updates/types.js";
import type { MappingFile, MappingEntry } from "../../../src/lib/state/mapping.js";
import { adaptPortalFetch } from "../../../src/mcp/tools/scan_updates.js";
import {
  AuthExpiredError,
  AuthMissingError,
  NetworkError,
  PortalRateLimitError,
  ForbiddenError,
} from "../../../src/lib/errors.js";
import type { CheckUpdatesResult } from "../../../src/lib/updates/scanner.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "../../..");

describe("ScanUpdatesInput schema", () => {
  it("accepts empty input (scan-all portal-only)", () => {
    const parsed = ScanUpdatesInput.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it("accepts slug alone", () => {
    const parsed = ScanUpdatesInput.safeParse({ slug: "cd_dispatch" });
    expect(parsed.success).toBe(true);
  });

  it("accepts grantId alone", () => {
    const parsed = ScanUpdatesInput.safeParse({ grantId: 1234 });
    expect(parsed.success).toBe(true);
  });

  it("rejects both slug and grantId (mutually exclusive)", () => {
    const parsed = ScanUpdatesInput.safeParse({ slug: "cd_dispatch", grantId: 1234 });
    expect(parsed.success).toBe(false);
  });

  it("accepts logLines + forcePortal together", () => {
    const parsed = ScanUpdatesInput.safeParse({
      logLines: ["foo", "bar"],
      forcePortal: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects non-positive grantId", () => {
    expect(ScanUpdatesInput.safeParse({ grantId: 0 }).success).toBe(false);
    expect(ScanUpdatesInput.safeParse({ grantId: -1 }).success).toBe(false);
  });

  it("rejects non-integer grantId", () => {
    expect(ScanUpdatesInput.safeParse({ grantId: 1.5 }).success).toBe(false);
  });
});

describe("ScanUpdatesOutput schema", () => {
  it("round-trips a fully-populated ScanUpdatesResult", () => {
    const sample: ScanUpdatesResult = {
      available: [
        {
          slug: "cd_dispatch",
          grantId: 100,
          current: "3.4.0",
          announced: "3.5.0",
          source: "portal+log",
          releaseNotesUrl: "https://docs.codesign.pro/cd_dispatch/changelog",
          severityNote: "Security hotfix",
          updatedAt: "2026-04-18T10:00:00.000Z",
          boundaryKnown: true,
        },
      ],
      suppressed: [
        {
          slug: "ulc_bodycams",
          grantId: 200,
          current: "1.9.0",
          announced: "1.8.0",
          source: "portal",
          reason: "local-ahead",
          boundaryKnown: true,
        },
        {
          slug: "quasar_inventory",
          grantId: 201,
          current: "2.0.0",
          announced: "2.0.0",
          source: "log",
          reason: "local-equal",
          boundaryKnown: true,
        },
        {
          slug: "my_fork",
          grantId: 202,
          current: null,
          announced: "5.0.0",
          source: "portal",
          reason: "ignore-upstream-updates",
          boundaryKnown: false,
        },
      ],
      unknownSource: [
        {
          slug: "cd_dispatch_nosemver",
          grantId: 300,
          current: "not-a-semver",
          announced: "also-not",
          source: "log",
          reason: "no-semver",
          boundaryKnown: true,
        },
        {
          slug: "cd_no_current",
          grantId: 301,
          current: null,
          announced: "3.0.0",
          source: "portal",
          reason: "missing-current",
          boundaryKnown: true,
        },
        {
          slug: "cd_no_announced",
          grantId: 302,
          current: "1.0.0",
          announced: "",
          source: "portal",
          reason: "missing-announced",
          boundaryKnown: false,
        },
      ],
      unmapped: [
        {
          slug: "unknown_mod",
          current: "1.0.0",
          announced: "1.1.0",
          source: "log",
          releaseNotesUrl: "https://docs.codesign.pro/unknown_mod/changelog",
          severityNote: "minor bugfix",
          boundaryKnown: true,
        },
      ],
      scannedLogLines: 42,
      logHasStartupBoundary: true,
      portalPolled: true,
      portalFromCache: false,
    };

    const roundTripped = ScanUpdatesOutput.parse(sample);
    expect(roundTripped).toEqual(sample);
  });

  it("round-trips an empty-bucket result", () => {
    const empty: ScanUpdatesResult = {
      available: [],
      suppressed: [],
      unknownSource: [],
      unmapped: [],
      scannedLogLines: 0,
      logHasStartupBoundary: false,
      portalPolled: false,
      portalFromCache: true,
    };
    expect(ScanUpdatesOutput.parse(empty)).toEqual(empty);
  });

  it("rejects invalid source enum", () => {
    const bad = {
      available: [{
        slug: "x", grantId: 1, current: null, announced: "1.0.0",
        source: "satellite", boundaryKnown: false,
      }],
      suppressed: [], unknownSource: [], unmapped: [],
      scannedLogLines: 0, logHasStartupBoundary: false,
      portalPolled: false, portalFromCache: false,
    };
    expect(ScanUpdatesOutput.safeParse(bad).success).toBe(false);
  });

  it("rejects invalid suppressed.reason enum", () => {
    const bad = {
      available: [],
      suppressed: [{
        slug: "x", grantId: 1, current: "1.0.0", announced: "1.0.0",
        source: "portal", reason: "vibes-bad", boundaryKnown: false,
      }],
      unknownSource: [], unmapped: [],
      scannedLogLines: 0, logHasStartupBoundary: false,
      portalPolled: false, portalFromCache: false,
    };
    expect(ScanUpdatesOutput.safeParse(bad).success).toBe(false);
  });

  it("rejects invalid unknownSource.reason enum", () => {
    const bad = {
      available: [], suppressed: [],
      unknownSource: [{
        slug: "x", grantId: 1, current: "1.0.0", announced: "1.0.0",
        source: "portal", reason: "not-in-enum", boundaryKnown: false,
      }],
      unmapped: [],
      scannedLogLines: 0, logHasStartupBoundary: false,
      portalPolled: false, portalFromCache: false,
    };
    expect(ScanUpdatesOutput.safeParse(bad).success).toBe(false);
  });

  it("requires unmapped.source to be literal 'log'", () => {
    const bad = {
      available: [], suppressed: [], unknownSource: [],
      unmapped: [{
        slug: "x", current: null, announced: "1.0.0",
        source: "portal", boundaryKnown: false,
      }],
      scannedLogLines: 0, logHasStartupBoundary: false,
      portalPolled: false, portalFromCache: false,
    };
    expect(ScanUpdatesOutput.safeParse(bad).success).toBe(false);
  });
});

describe("TOOLS registry integration", () => {
  it("includes cfx_scan_updates", () => {
    expect(toolNames()).toContain("cfx_scan_updates");
  });

  it("cfx_scan_updates is marked non-destructive", () => {
    const t = TOOLS.find((x) => x.name === "cfx_scan_updates");
    expect(t).toBeDefined();
    expect(t!.destructive).toBe(false);
  });

  it("cfx_scan_updates has a description mentioning signals", () => {
    const t = TOOLS.find((x) => x.name === "cfx_scan_updates");
    expect(t?.description).toMatch(/portal|log|signal/i);
  });

  it("dispatch handler exists for cfx_scan_updates", async () => {
    // Calling dispatch("cfx_scan_updates", {}) would attempt a real portal
    // poll — we only assert the route is wired, not its runtime behavior.
    try {
      await dispatch("cfx_scan_updates", {});
    } catch (e) {
      // Any thrown error is fine here — the "Unknown tool" error means the
      // route is NOT wired, which we explicitly check against.
      expect((e as Error).message).not.toMatch(/Unknown tool/);
      return;
    }
    // If it somehow resolves, that's also fine.
  });
});

/**
 * The open-source boundary is strict: the scan_updates tool must not pull in
 * any MCP-client code. Only MCP-server schemas/tooling glue is allowed.
 */
describe("no outbound MCP client imports", () => {
  it("scan_updates.ts does not import @modelcontextprotocol SDK client parts", () => {
    const src = readFileSync(
      path.join(REPO_ROOT, "src/mcp/tools/scan_updates.ts"),
      "utf8"
    );
    // Explicit SDK import check — whole package is OK to reference only from
    // src/index.ts (server entrypoint); not from tool files.
    expect(src).not.toMatch(/@modelcontextprotocol\//);
    // Heuristic guards against "ad-hoc MCP client" shapes.
    expect(src).not.toMatch(/\bMCPClient\b/);
    expect(src).not.toMatch(/\bcallTool\(/);
  });
});

/**
 * End-to-end smoke that exercises the tool against an empty-mapping state
 * without touching the real portal. The adapter should short-circuit on the
 * rate-limit gate when there's no cookie file, AND the Mapping loader tolerates
 * a missing cfx-sync-map.json. With an empty mapping, the scanner produces an
 * empty result.
 *
 * We force STALE by setting the lastPolledAt to "now" in state.json, which
 * causes the inline adapter to return `{updated: [], stale: true,
 * portalFromCache: true}` without touching the network.
 */
describe("cfx_scan_updates end-to-end smoke", () => {
  let dir: string;
  let stateDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cfx-scanupd-"));
    stateDir = path.join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    process.env.CFX_SERVER_RESOURCES = dir;
    process.env.CFX_STATE_DIR = stateDir;
    process.env.CFX_CACHE_DIR = path.join(dir, "cache");
    process.env.CFX_STAGING_DIR = path.join(dir, "staging");
    process.env.CFX_BACKUP_DIR = path.join(dir, "backups");
    process.env.CFX_COOKIE_FILE = path.join(dir, ".cookies.json");
    // 1h TTL → any lastPolledAt set to near-now short-circuits the gate.
    process.env.CFX_RATE_LIMIT_TTL_MS = "3600000";
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.CFX_RATE_LIMIT_TTL_MS;
  });

  it("returns empty buckets for empty mapping with STALE portal gate", async () => {
    // Seed state with a recent lastPolledAt to force the rate-limit gate to STALE.
    const state = {
      version: 3,
      rateLimit: { local: { lastPolledAt: new Date().toISOString() } },
      assets: {},
    };
    writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state));

    // Seed an empty mapping so the scanner has something to load.
    const mapping: MappingFile = {
      version: 3,
      approvedAt: new Date().toISOString(),
      entries: {},
      newInstalls: [],
      orphaned: [],
    };
    writeFileSync(
      path.join(stateDir, "cfx-sync-map.json"),
      JSON.stringify(mapping)
    );

    const { cfx_scan_updates } = await import("../../../src/mcp/tools/scan_updates.js");
    const result = await cfx_scan_updates({});

    // Output round-trips through the schema.
    const parsed = ScanUpdatesOutput.parse(result);
    expect(parsed.available).toEqual([]);
    expect(parsed.suppressed).toEqual([]);
    expect(parsed.unknownSource).toEqual([]);
    expect(parsed.unmapped).toEqual([]);
    expect(parsed.portalPolled).toBe(false); // STALE → no poll
    expect(parsed.portalFromCache).toBe(true);
    expect(parsed.scannedLogLines).toBe(0);
    expect(parsed.logHasStartupBoundary).toBe(false);
  });

  it("reports scannedLogLines from supplied logLines even when portal is STALE", async () => {
    const state = {
      version: 3,
      rateLimit: { local: { lastPolledAt: new Date().toISOString() } },
      assets: {},
    };
    writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state));

    const mapping: MappingFile = {
      version: 3,
      approvedAt: new Date().toISOString(),
      entries: {},
      newInstalls: [],
      orphaned: [],
    };
    writeFileSync(
      path.join(stateDir, "cfx-sync-map.json"),
      JSON.stringify(mapping)
    );

    const { cfx_scan_updates } = await import("../../../src/mcp/tools/scan_updates.js");
    const result = await cfx_scan_updates({
      logLines: [
        "irrelevant line",
        "another irrelevant line",
        "Started resource cd_dispatch",
      ],
    });

    const parsed = ScanUpdatesOutput.parse(result);
    expect(parsed.scannedLogLines).toBe(3);
    expect(parsed.logHasStartupBoundary).toBe(true);
  });

  it("throws NotFoundError when slug filter targets a missing mapping entry", async () => {
    // STALE gate → no network.
    const state = {
      version: 3,
      rateLimit: { local: { lastPolledAt: new Date().toISOString() } },
      assets: {},
    };
    writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state));

    const entry: MappingEntry = {
      slug: "cd_dispatch",
      target: path.join(dir, "resources/cd_dispatch"),
      disabled: false,
      assetName: "cd_dispatch",
      discoveredTier: 1,
      discoveredConfidence: 1.0,
    };
    const mapping: MappingFile = {
      version: 3,
      approvedAt: new Date().toISOString(),
      entries: { "100": entry },
      newInstalls: [],
      orphaned: [],
    };
    writeFileSync(
      path.join(stateDir, "cfx-sync-map.json"),
      JSON.stringify(mapping)
    );

    const { cfx_scan_updates } = await import("../../../src/mcp/tools/scan_updates.js");
    await expect(cfx_scan_updates({ slug: "not_there" })).rejects.toThrow(/not_there|No mapping/i);
  });
});

/**
 * Phase 1.6 follow-up — graceful degradation when the portal fetch fails
 * with an expected error class (stale cookies, missing cookies, transient
 * network, rate limit, revoked grant). The adapter must return the
 * "did not poll" sentinel so the scanner can still process log signal.
 * Unexpected errors (filesystem corruption, bug-class errors) must still
 * propagate — we don't silently swallow genuine failures.
 *
 * Tests target the exported `adaptPortalFetch` helper directly, which
 * keeps the assertions hermetic (no PortalApiClient mocking) and
 * isolates the try/catch branch.
 */
describe("adaptPortalFetch — graceful degradation on portal auth failure", () => {
  const STALE_SENTINEL: CheckUpdatesResult = {
    updated: [],
    stale: true,
    portalFromCache: true,
  };

  it("returns stale sentinel on AuthExpiredError (cookies present but rejected)", async () => {
    const result = await adaptPortalFetch(async () => {
      throw new AuthExpiredError();
    });
    expect(result).toEqual(STALE_SENTINEL);
  });

  it("returns stale sentinel on AuthMissingError (no cookie file)", async () => {
    const result = await adaptPortalFetch(async () => {
      throw new AuthMissingError();
    });
    expect(result).toEqual(STALE_SENTINEL);
  });

  it("returns stale sentinel on NetworkError (transient connectivity)", async () => {
    const result = await adaptPortalFetch(async () => {
      throw new NetworkError("DNS lookup failed");
    });
    expect(result).toEqual(STALE_SENTINEL);
  });

  it("returns stale sentinel on PortalRateLimitError (429 from portal)", async () => {
    const result = await adaptPortalFetch(async () => {
      throw new PortalRateLimitError(60);
    });
    expect(result).toEqual(STALE_SENTINEL);
  });

  it("returns stale sentinel on ForbiddenError (403 / revoked grant)", async () => {
    const result = await adaptPortalFetch(async () => {
      throw new ForbiddenError("https://portal.cfx.re/api/list_grants");
    });
    expect(result).toEqual(STALE_SENTINEL);
  });

  it("propagates unexpected errors (generic Error) — does NOT swallow genuine bugs", async () => {
    await expect(
      adaptPortalFetch(async () => {
        throw new Error("filesystem corrupted");
      })
    ).rejects.toThrow(/filesystem corrupted/);
  });

  it("propagates unexpected errors (TypeError) — bug-class still throws", async () => {
    await expect(
      adaptPortalFetch(async () => {
        throw new TypeError("cannot read properties of undefined");
      })
    ).rejects.toThrow(TypeError);
  });

  it("returns successful result unchanged when fetchFn succeeds", async () => {
    const success: CheckUpdatesResult = {
      updated: [
        { grantId: 42, slug: "cd_dispatch", assetName: "cd_dispatch", updatedAt: "2026-04-19T00:00:00Z" },
      ],
      stale: false,
      portalFromCache: false,
    };
    const result = await adaptPortalFetch(async () => success);
    expect(result).toEqual(success);
  });
});

/**
 * End-to-end: with no cookie file, cfx_scan_updates must NOT throw. The
 * adapter catches AuthMissingError from loadCookiesFromFile and returns
 * the stale sentinel; scanner surfaces it as portalPolled:false, and any
 * supplied logLines are still parsed into the unmapped bucket.
 */
describe("cfx_scan_updates — graceful degradation end-to-end", () => {
  let dir: string;
  let stateDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cfx-scanupd-degrade-"));
    stateDir = path.join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    process.env.CFX_SERVER_RESOURCES = dir;
    process.env.CFX_STATE_DIR = stateDir;
    process.env.CFX_CACHE_DIR = path.join(dir, "cache");
    process.env.CFX_STAGING_DIR = path.join(dir, "staging");
    process.env.CFX_BACKUP_DIR = path.join(dir, "backups");
    // Point at a path that does NOT exist — loadCookiesFromFile raises
    // AuthMissingError, which the adapter catches.
    process.env.CFX_COOKIE_FILE = path.join(dir, "does-not-exist.cookies.json");
    // Force FRESH gate decision: zero TTL means any prior timestamp is stale.
    process.env.CFX_RATE_LIMIT_TTL_MS = "0";
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.CFX_RATE_LIMIT_TTL_MS;
  });

  it("proceeds with log-only signal when cookies are missing (AuthMissingError)", async () => {
    // Empty mapping so scanner has something to load; no pre-polled timestamp
    // means the gate decides FRESH and the adapter runs, hitting AuthMissingError.
    const state = {
      version: 3,
      rateLimit: {},
      assets: {},
    };
    writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state));

    const mapping: MappingFile = {
      version: 3,
      approvedAt: new Date().toISOString(),
      entries: {},
      newInstalls: [],
      orphaned: [],
    };
    writeFileSync(
      path.join(stateDir, "cfx-sync-map.json"),
      JSON.stringify(mapping)
    );

    const { cfx_scan_updates } = await import("../../../src/mcp/tools/scan_updates.js");
    const result = await cfx_scan_updates({
      logLines: ["Started resource cd_dispatch", "some other log line"],
    });

    const parsed = ScanUpdatesOutput.parse(result);
    // Portal path failed gracefully → portalPolled false, fromCache true.
    expect(parsed.portalPolled).toBe(false);
    expect(parsed.portalFromCache).toBe(true);
    // Log scanning still ran.
    expect(parsed.scannedLogLines).toBe(2);
    expect(parsed.logHasStartupBoundary).toBe(true);
  });

  it("does NOT bump state.lastPolledAt when the portal fetch failed", async () => {
    // Start with NO lastPolledAt. If the failed fetch wrongly bumped it,
    // the next assertion would see a timestamp where there was none.
    const state = {
      version: 3,
      rateLimit: {},
      assets: {},
    };
    writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state));

    const mapping: MappingFile = {
      version: 3,
      approvedAt: new Date().toISOString(),
      entries: {},
      newInstalls: [],
      orphaned: [],
    };
    writeFileSync(
      path.join(stateDir, "cfx-sync-map.json"),
      JSON.stringify(mapping)
    );

    const { cfx_scan_updates } = await import("../../../src/mcp/tools/scan_updates.js");
    await cfx_scan_updates({ logLines: [] });

    // Re-read state.json — lastPolledAt must still be absent (failed poll
    // must NOT count against the rate-limit gate).
    const after = JSON.parse(readFileSync(path.join(stateDir, "state.json"), "utf8")) as {
      rateLimit?: Record<string, { lastPolledAt?: string }>;
    };
    expect(after.rateLimit?.local?.lastPolledAt).toBeUndefined();
  });
});
