/**
 * Integration tests for Task 19 — 3 adversarial scenarios.
 *
 * These exercise the full cfx_deploy_asset entry point against malicious
 * pack inputs. The unzipper unit tests (tests/unit/deploy/unzipper.test.ts)
 * already prove the low-level refusals; these assert that the refusals
 * propagate cleanly through the MCP tool boundary.
 *
 * Scenarios:
 *   1. Symlink entry — unzipper skips it; `plan.packValidationFailures[]`
 *      (and the top-level `packValidationFailures` output field) surfaces
 *      the refusal to the operator. Deploy continues for the rest of the pack.
 *
 *   2. Path-traversal entry (zip-slip, `../../escape.lua`) — unzipper
 *      refuses hard via `ValidationFailedError`. The error is typed and no
 *      file lands outside the staging root.
 *
 *   3. Version metadata mismatch (pack fxmanifest.lua version ≠ portal
 *      reported version) — deferred. The deploy pipeline does NOT inspect
 *      fxmanifest version today, and there's no `warnings: []` output field
 *      to carry a non-blocking warning. See TODO in the `.todo` test below.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import * as JSZipModule from "jszip";
import { cfx_deploy_asset } from "../../src/mcp/tools/deploy_asset.js";
import type { AssetState } from "../../src/lib/state/state.js";
import type { MappingFile, MappingEntry } from "../../src/lib/state/mapping.js";
import { ValidationFailedError } from "../../src/lib/errors.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const JSZip: any = (JSZipModule as any).default ?? JSZipModule;

// ---------------------------------------------------------------------------
// Fixture helpers (same pattern as preservation.test.ts / recovery.test.ts)
// ---------------------------------------------------------------------------

interface Fixture {
  tmp: string;
  stateDir: string;
  srvDir: string;
  target: string;
  cacheDir: string;
  stagingDir: string;
  backupDir: string;
  pristineDir: string;
  pristineHistoryDir: string;
  conflictDir: string;
}

function setupEnv(f: Fixture): void {
  process.env.CFX_SERVER_RESOURCES = f.srvDir;
  process.env.CFX_STATE_DIR = f.stateDir;
  process.env.CFX_CACHE_DIR = f.cacheDir;
  process.env.CFX_STAGING_DIR = f.stagingDir;
  process.env.CFX_BACKUP_DIR = f.backupDir;
  process.env.CFX_COOKIE_FILE = path.join(f.tmp, ".cookies.json");
  process.env.CFX_PRISTINE_DIR = f.pristineDir;
  process.env.CFX_PRISTINE_HISTORY_DIR = f.pristineHistoryDir;
  process.env.CFX_CONFLICT_DIR = f.conflictDir;
  delete process.env.CFX_SYNC_PRESERVE;
}

function mkFixture(): Fixture {
  const tmp = mkdtempSync(path.join(tmpdir(), "cfx-adv-int-"));
  const stateDir = path.join(tmp, "state");
  const srvDir = path.join(tmp, "srv", "[category]");
  const target = path.join(srvDir, "my_asset");
  const f: Fixture = {
    tmp,
    stateDir,
    srvDir,
    target,
    cacheDir: path.join(tmp, "cache"),
    stagingDir: path.join(tmp, "staging"),
    backupDir: path.join(tmp, "backups"),
    pristineDir: path.join(tmp, "pristine"),
    pristineHistoryDir: path.join(tmp, "pristine-history"),
    conflictDir: path.join(tmp, "conflicts"),
  };
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(srvDir, { recursive: true });
  mkdirSync(f.cacheDir, { recursive: true });
  mkdirSync(f.stagingDir, { recursive: true });
  return f;
}

function writeMapping(stateDir: string, entries: Record<string, MappingEntry>): void {
  const file: MappingFile = {
    version: 3,
    approvedAt: new Date().toISOString(),
    entries,
    newInstalls: [],
    orphaned: [],
  };
  writeFileSync(path.join(stateDir, "cfx-sync-map.json"), JSON.stringify(file, null, 2));
}

function writeState(stateDir: string, assets: AssetState[]): void {
  const data = {
    version: 3,
    rateLimit: {},
    assets: Object.fromEntries(assets.map((a) => [String(a.grantId), a])),
  };
  writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(data, null, 2));
}

function makeEntry(target: string, slug = "my_asset"): MappingEntry {
  return {
    slug,
    target,
    disabled: false,
    assetName: "My Asset",
    discoveredTier: 1,
    discoveredConfidence: 1.0,
  };
}

function makeAssetState(
  grantId: number,
  zipPath: string,
  target: string,
  overrides: Partial<AssetState> = {}
): AssetState {
  return {
    grantId,
    assetId: grantId,
    slug: "my_asset",
    assetName: "My Asset",
    versionId: 10,
    packId: 1,
    updatedAt: "2026-04-18T00:00:00.000Z",
    sha256: "deadbeef",
    cachedZipPath: zipPath,
    deployedPath: target,
    deployedAt: "",
    backups: [],
    pristineVersionId: null,
    pristineCapturedAt: null,
    pristineHashes: null,
    ...overrides,
  };
}

/**
 * Build a zip that contains symlink entries. Matches the pattern in the
 * unzipper unit tests: unixPermissions with S_IFLNK bits (0o120000) + UNIX
 * platform makes yauzl see the entry as a symlink.
 */
async function buildSymlinkZip(
  files: Record<string, string>,
  symlinks: Record<string, string>
): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  for (const [name, target] of Object.entries(symlinks)) {
    zip.file(name, target, { unixPermissions: 0o120777 });
  }
  return zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
}

/**
 * Build a zip with raw entry names — no sanitization. This is the adversarial
 * path: we want to produce `../../escape.lua` literally in the central
 * directory so yauzl's validateFilenames catches it.
 */
async function buildRawZip(entries: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("integration: cfx_deploy_asset — adversarial packs", () => {
  let f: Fixture;
  const grantId = 42;

  beforeEach(() => {
    f = mkFixture();
  });

  afterEach(() => {
    delete process.env.CFX_SYNC_PRESERVE;
    delete process.env.CFX_PRISTINE_DIR;
    delete process.env.CFX_PRISTINE_HISTORY_DIR;
    delete process.env.CFX_CONFLICT_DIR;
    rmSync(f.tmp, { recursive: true, force: true });
  });

  // ---- Scenario 1: symlink entry surfaces in validationFailures ----------
  // The pack contains a valid fxmanifest.lua + one symlink entry. The
  // unzipper skips the symlink (doesn't write it to disk) and records it
  // in validationFailures. Dry-run should return without throwing, and
  // the symlink refusal must be visible on BOTH the top-level
  // `packValidationFailures` field AND `plan.packValidationFailures`.
  it("Scenario 1: symlink refusal surfaces in packValidationFailures (dryRun)", async () => {
    setupEnv(f);

    // Build pack: valid manifest + a malicious symlink to /etc/passwd.
    const buf = await buildSymlinkZip(
      { "my_asset/fxmanifest.lua": "name 'my_asset'", "my_asset/client.lua": "x" },
      { "my_asset/evil-link.lua": "/etc/passwd" }
    );
    const zipPath = path.join(f.cacheDir, "my_asset-symlink.zip");
    writeFileSync(zipPath, buf);

    writeMapping(f.stateDir, { [String(grantId)]: makeEntry(f.target) });
    // Seed live so this is a layer-2 run (plan populated). Also seed pristine
    // matching live so the diff is clean except for the pack-level failure.
    const baseline = { "fxmanifest.lua": "name 'my_asset'", "client.lua": "x" };
    mkdirSync(f.target, { recursive: true });
    for (const [rel, body] of Object.entries(baseline)) {
      writeFileSync(path.join(f.target, rel), body);
    }
    mkdirSync(path.join(f.pristineDir, String(grantId)), { recursive: true });
    for (const [rel, body] of Object.entries(baseline)) {
      writeFileSync(path.join(f.pristineDir, String(grantId), rel), body);
    }
    // Hashes for pristine matching baseline (sha256 of each body). We rely on
    // the hash mismatch NOT mattering because we dryRun the deploy — the
    // assertion target is the validationFailures passthrough, not the plan
    // decisions. But state's pristineHashes must be non-null to land us in
    // layer-2 mode. Use crypto to compute real hashes so computeDeployPlan
    // treats live == pristine.
    const crypto = await import("node:crypto");
    const pristineHashes: Record<string, string> = {};
    for (const [rel, body] of Object.entries(baseline)) {
      pristineHashes[rel] = crypto.createHash("sha256").update(body).digest("hex");
    }

    writeState(f.stateDir, [
      makeAssetState(grantId, zipPath, f.target, {
        versionId: 11,
        deployedAt: "2026-04-17T00:00:00.000Z",
        pristineVersionId: 10,
        pristineCapturedAt: "2026-04-17T00:00:00.000Z",
        pristineHashes,
      }),
    ]);

    const out = await cfx_deploy_asset({ grantId, dryRun: true });

    // Top-level passthrough: the operator sees the refusal without inspecting
    // plan internals.
    // `path` is the raw zip entry name — the unzipper records it before the
    // single-top-dir flatten step, so the slug-dir prefix is preserved. That's
    // fine for operator display: the message is "a symlink with this name was
    // in the pack" rather than a repo-relative post-flatten path.
    expect(out.packValidationFailures).toBeDefined();
    expect(out.packValidationFailures).toHaveLength(1);
    expect(out.packValidationFailures![0]).toEqual({
      path: "my_asset/evil-link.lua",
      reason: "symlink-refused",
    });

    // Plan also carries the failure under packValidationFailures. Layer 2 is
    // active (pristine seeded) so plan is non-null.
    expect(out.preservationMode).toBe("layer-2");
    expect(out.plan).not.toBeNull();
    expect(out.plan!.packValidationFailures).toEqual([
      { path: "my_asset/evil-link.lua", reason: "symlink-refused" },
    ]);

    // Dry-run: no live mutation, pristine untouched, no symlink written.
    expect(readFileSync(path.join(f.target, "fxmanifest.lua"), "utf8")).toBe(
      "name 'my_asset'"
    );
    expect(existsSync(path.join(f.target, "evil-link.lua"))).toBe(false);
  });

  // ---- Scenario 2: path-traversal entry is refused hard ------------------
  // The pack contains `../../escape.lua`. The unzipper's zip-slip guard
  // (or yauzl's validateFilenames) must throw ValidationFailedError. No
  // files land outside the staging root; staging is cleaned up on failure.
  it("Scenario 2: zip-slip path-traversal throws ValidationFailedError; no external writes", async () => {
    setupEnv(f);

    // Build pack: valid manifest inside slug-dir + a `../../` escape entry.
    // Putting valid files first ensures the traversal entry is reached mid-loop,
    // exercising the cleanup path.
    const buf = await buildRawZip({
      "my_asset/fxmanifest.lua": "name 'my_asset'",
      "my_asset/client.lua": "x",
      "../../escape.lua": "rm -rf /",
    });
    const zipPath = path.join(f.cacheDir, "my_asset-zipslip.zip");
    writeFileSync(zipPath, buf);

    writeMapping(f.stateDir, { [String(grantId)]: makeEntry(f.target) });
    writeState(f.stateDir, [makeAssetState(grantId, zipPath, f.target)]);

    // Snapshot every file under tmp BEFORE the call so we can prove nothing
    // new landed outside staging after the refusal.
    const snapshot = (root: string): string[] => {
      const out: string[] = [];
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const abs = path.join(dir, name);
          const st = statSync(abs);
          if (st.isDirectory()) walk(abs);
          else out.push(abs);
        }
      };
      walk(root);
      return out.sort();
    };
    const before = snapshot(f.tmp);

    await expect(cfx_deploy_asset({ grantId, dryRun: true })).rejects.toBeInstanceOf(
      ValidationFailedError
    );

    // No new files outside staging. Staging's extract-* dir was cleaned up
    // by the unzipper's failure-cleanup branch. The exact filesystem state
    // may differ from `before` only inside the cache/staging dirs (lockfile,
    // etc.) — but crucially, NOTHING should exist under the tmp root with the
    // name `escape.lua` anywhere.
    const after = snapshot(f.tmp);
    const escaped = after.filter((p) => path.basename(p) === "escape.lua");
    expect(escaped).toEqual([]);

    // Defense-in-depth: check well-known escape targets directly. If yauzl's
    // normalization did land `escape.lua` in the tmp parent or staging's
    // parent, we'd catch it here.
    expect(existsSync(path.join(f.tmp, "escape.lua"))).toBe(false);
    expect(existsSync(path.join(path.dirname(f.tmp), "escape.lua"))).toBe(false);
    expect(existsSync(path.join(f.stagingDir, "..", "escape.lua"))).toBe(false);

    // Live was never touched (deploy didn't run).
    expect(existsSync(f.target)).toBe(false);

    // `before` snapshot is purely informational — just confirming fixture
    // setup didn't accidentally create an escape.lua.
    expect(before.filter((p) => path.basename(p) === "escape.lua")).toEqual([]);
  });

  // ---- Scenario 3: version metadata mismatch -----------------------------
  // TODO: The current deploy pipeline does not inspect `fxmanifest.lua`
  // version metadata, and the output schema (DeployAssetOutput) has no
  // `warnings: []` field to carry a non-blocking warning. Implementing this
  // would require:
  //   1. A version-compare helper in `src/lib/deploy/` that reads
  //      `fxmanifest.lua` from the staging root and parses `version 'X.Y.Z'`.
  //   2. A new `warnings: z.array(z.object({...}))` field on
  //      DeployAssetOutput (and corresponding plumbing in the three runLegacy
  //      / runFirstDeploy / runLayer2 paths).
  //   3. A Cfx portal-reported version to compare against — currently the
  //      `AssetState` carries `versionId: number` (a Cfx internal pack
  //      version id), not a semver. The comparison would need a new field
  //      or a semver-lift from `versionId`.
  // The plan explicitly labels this as a "non-blocking warning field" not
  // yet in the codebase. Deferred per scope guidance.
  it.todo(
    "Scenario 3: pack fxmanifest.lua version mismatch surfaces as non-blocking warning"
  );
});
