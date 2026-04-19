/**
 * Integration tests for Task 15 — cfx_deploy_asset with Phase 1.5 preservation.
 *
 * These exercise the full orchestration through the MCP tool entry point,
 * hitting real filesystems + real zips. Task 17 will extend this file with
 * the 8-scenario suite; these 6 cover the core branches:
 *
 *   1. First deploy captures pristine (no prior baseline)
 *   2. Subsequent clean deploy (live unchanged) rotates pristine cleanly
 *   3. Second deploy preserves user-modified file (row 3)
 *   4. Second deploy throws ConflictsUnresolvedError when live + pack both changed
 *   5. Passing conflictResolutions resolves the conflict
 *   6. CFX_SYNC_PRESERVE=0 takes the legacy path, never captures pristine
 *   7. dryRun on layer-2 returns the full plan without mutating disk
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import * as JSZipModule from "jszip";
import { cfx_deploy_asset } from "../../src/mcp/tools/deploy_asset.js";
import type { AssetState } from "../../src/lib/state/state.js";
import type { MappingFile, MappingEntry } from "../../src/lib/state/mapping.js";
import { ConflictsUnresolvedError } from "../../src/lib/errors.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const JSZip: any = (JSZipModule as any).default ?? JSZipModule;

// ---------------------------------------------------------------------------
// Fixture helpers
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

function setupEnv(f: Fixture, opts: { preserve?: boolean } = {}): void {
  process.env.CFX_SERVER_RESOURCES = f.srvDir;
  process.env.CFX_STATE_DIR = f.stateDir;
  process.env.CFX_CACHE_DIR = f.cacheDir;
  process.env.CFX_STAGING_DIR = f.stagingDir;
  process.env.CFX_BACKUP_DIR = f.backupDir;
  process.env.CFX_COOKIE_FILE = path.join(f.tmp, ".cookies.json");
  process.env.CFX_PRISTINE_DIR = f.pristineDir;
  process.env.CFX_PRISTINE_HISTORY_DIR = f.pristineHistoryDir;
  process.env.CFX_CONFLICT_DIR = f.conflictDir;
  if (opts.preserve === false) {
    process.env.CFX_SYNC_PRESERVE = "0";
  } else {
    delete process.env.CFX_SYNC_PRESERVE;
  }
}

function mkFixture(): Fixture {
  const tmp = mkdtempSync(path.join(tmpdir(), "cfx-preserve-int-"));
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
    version: 2,
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

function readState(stateDir: string): { assets: Record<string, AssetState> } {
  return JSON.parse(readFileSync(path.join(stateDir, "state.json"), "utf8")) as {
    assets: Record<string, AssetState>;
  };
}

async function makePackZip(
  cacheDir: string,
  slug: string,
  files: Record<string, string>
): Promise<string> {
  const zip = new JSZip();
  for (const [rel, content] of Object.entries(files)) {
    zip.file(`${slug}/${rel}`, content);
  }
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const out = path.join(cacheDir, `${slug}-${Date.now()}-${Math.random()}.zip`);
  writeFileSync(out, buf);
  return out;
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function hashesFrom(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rel, body] of Object.entries(files)) out[rel] = sha256(body);
  return out;
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

// Populate live dir + zip for a fresh pack deploy.
function seedLive(target: string, files: Record<string, string>): void {
  mkdirSync(target, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(target, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("integration: cfx_deploy_asset preservation orchestration", () => {
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

  it("first deploy captures pristine and sets preservationMode=first-deploy", async () => {
    setupEnv(f);
    const v1Files = { "fxmanifest.lua": "v1", "server.lua": "print('v1')" };
    const zipPath = await makePackZip(f.cacheDir, "my_asset", v1Files);

    writeMapping(f.stateDir, { [String(grantId)]: makeEntry(f.target) });
    writeState(f.stateDir, [makeAssetState(grantId, zipPath, f.target)]);

    // Explicit dryRun:false — default behavior for a never-deployed asset is
    // auto-dryRun-first (stateEntry.deployedAt is empty).
    const out = await cfx_deploy_asset({ grantId, dryRun: false });

    expect(out.preservationMode).toBe("first-deploy");
    expect(out.pristineCaptured).toBe(true);
    expect(out.dryRun).toBe(false);
    // Live contains pack content
    expect(readFileSync(path.join(f.target, "fxmanifest.lua"), "utf8")).toBe("v1");
    // Pristine baseline captured under CFX_PRISTINE_DIR/<grantId>/
    expect(existsSync(path.join(f.pristineDir, String(grantId), "fxmanifest.lua"))).toBe(true);
    // State updated with pristine fields
    const onDisk = readState(f.stateDir);
    expect(onDisk.assets[String(grantId)]!.pristineVersionId).toBe(10);
    expect(onDisk.assets[String(grantId)]!.pristineHashes).not.toBeNull();
    expect(Object.keys(onDisk.assets[String(grantId)]!.pristineHashes!)).toContain(
      "fxmanifest.lua"
    );
  });

  it("second deploy with unchanged live runs Layer 2 and rotates pristine", async () => {
    setupEnv(f);
    const v1Files = { "fxmanifest.lua": "v1", "server.lua": "print('v1')" };
    // Seed a completed prior deploy: live + pristine both = v1.
    seedLive(f.target, v1Files);
    mkdirSync(path.join(f.pristineDir, String(grantId)), { recursive: true });
    for (const [rel, body] of Object.entries(v1Files)) {
      writeFileSync(path.join(f.pristineDir, String(grantId), rel), body);
    }

    // New pack ships v2 of server.lua, manifest unchanged.
    const v2Files = { "fxmanifest.lua": "v1", "server.lua": "print('v2')" };
    const zipPath = await makePackZip(f.cacheDir, "my_asset", v2Files);

    writeMapping(f.stateDir, { [String(grantId)]: makeEntry(f.target) });
    writeState(f.stateDir, [
      makeAssetState(grantId, zipPath, f.target, {
        versionId: 11, // new pack version
        deployedAt: "2026-04-17T00:00:00.000Z",
        pristineVersionId: 10,
        pristineCapturedAt: "2026-04-17T00:00:00.000Z",
        pristineHashes: hashesFrom(v1Files),
      }),
    ]);

    const out = await cfx_deploy_asset({ grantId });

    expect(out.preservationMode).toBe("layer-2");
    expect(out.pristineCaptured).toBe(true);
    // Plan has 2 rows (one unchanged row 1 take-newPack + one row 2 take-newPack)
    expect(out.plan).not.toBeNull();
    expect(out.plan!.rows.length).toBeGreaterThan(0);
    expect(out.plan!.conflicts).toHaveLength(0);
    expect(out.plan!.blockers).toHaveLength(0);
    // Live = v2
    expect(readFileSync(path.join(f.target, "server.lua"), "utf8")).toBe("print('v2')");
    // Pristine rotated
    expect(readFileSync(path.join(f.pristineDir, String(grantId), "server.lua"), "utf8")).toBe(
      "print('v2')"
    );
    // State bumped
    const onDisk = readState(f.stateDir);
    expect(onDisk.assets[String(grantId)]!.pristineVersionId).toBe(11);
  });

  it("preserves user-modified file (row 3) across deploy", async () => {
    setupEnv(f);
    const pristineFiles = { "fxmanifest.lua": "v1", "config.lua": "BASE_CONFIG" };
    const liveFiles = { "fxmanifest.lua": "v1", "config.lua": "USER_EDITED" };
    seedLive(f.target, liveFiles);
    mkdirSync(path.join(f.pristineDir, String(grantId)), { recursive: true });
    for (const [rel, body] of Object.entries(pristineFiles)) {
      writeFileSync(path.join(f.pristineDir, String(grantId), rel), body);
    }

    // Pack ships v1 — same as pristine, config.lua unchanged. Row 3 preserves live.
    const packFiles = { "fxmanifest.lua": "v2", "config.lua": "BASE_CONFIG" };
    const zipPath = await makePackZip(f.cacheDir, "my_asset", packFiles);

    writeMapping(f.stateDir, { [String(grantId)]: makeEntry(f.target) });
    writeState(f.stateDir, [
      makeAssetState(grantId, zipPath, f.target, {
        versionId: 11,
        deployedAt: "2026-04-17T00:00:00.000Z",
        pristineVersionId: 10,
        pristineCapturedAt: "2026-04-17T00:00:00.000Z",
        pristineHashes: hashesFrom(pristineFiles),
      }),
    ]);

    const out = await cfx_deploy_asset({ grantId });

    expect(out.preservationMode).toBe("layer-2");
    // Live fxmanifest updated to v2 (row 2 take-newPack since user didn't touch it)
    expect(readFileSync(path.join(f.target, "fxmanifest.lua"), "utf8")).toBe("v2");
    // Live config preserved (row 3 preserve-live since pack didn't change it)
    expect(readFileSync(path.join(f.target, "config.lua"), "utf8")).toBe("USER_EDITED");
    // Confirm a preserve-live row was emitted
    expect(out.plan!.rows.some((r) => r.decision === "preserve-live")).toBe(true);
  });

  it("throws ConflictsUnresolvedError when live + pack both changed (row 4)", async () => {
    setupEnv(f);
    const pristineFiles = { "fxmanifest.lua": "v1", "config.lua": "BASE" };
    const liveFiles = { "fxmanifest.lua": "v1", "config.lua": "USER_EDIT" };
    seedLive(f.target, liveFiles);
    mkdirSync(path.join(f.pristineDir, String(grantId)), { recursive: true });
    for (const [rel, body] of Object.entries(pristineFiles)) {
      writeFileSync(path.join(f.pristineDir, String(grantId), rel), body);
    }

    // Pack also changed config.lua → row 4 conflict.
    const packFiles = { "fxmanifest.lua": "v1", "config.lua": "VENDOR_CHANGE" };
    const zipPath = await makePackZip(f.cacheDir, "my_asset", packFiles);

    writeMapping(f.stateDir, { [String(grantId)]: makeEntry(f.target) });
    writeState(f.stateDir, [
      makeAssetState(grantId, zipPath, f.target, {
        versionId: 11,
        deployedAt: "2026-04-17T00:00:00.000Z",
        pristineVersionId: 10,
        pristineCapturedAt: "2026-04-17T00:00:00.000Z",
        pristineHashes: hashesFrom(pristineFiles),
      }),
    ]);

    await expect(cfx_deploy_asset({ grantId })).rejects.toBeInstanceOf(
      ConflictsUnresolvedError
    );
    // Live untouched after failure
    expect(readFileSync(path.join(f.target, "config.lua"), "utf8")).toBe("USER_EDIT");
    // Pristine untouched
    expect(readFileSync(path.join(f.pristineDir, String(grantId), "config.lua"), "utf8")).toBe(
      "BASE"
    );
  });

  it("resolves conflict when conflictResolutions provided (take-live)", async () => {
    setupEnv(f);
    const pristineFiles = { "fxmanifest.lua": "v1", "config.lua": "BASE" };
    const liveFiles = { "fxmanifest.lua": "v1", "config.lua": "USER_EDIT" };
    seedLive(f.target, liveFiles);
    mkdirSync(path.join(f.pristineDir, String(grantId)), { recursive: true });
    for (const [rel, body] of Object.entries(pristineFiles)) {
      writeFileSync(path.join(f.pristineDir, String(grantId), rel), body);
    }

    const packFiles = { "fxmanifest.lua": "v1", "config.lua": "VENDOR_CHANGE" };
    const zipPath = await makePackZip(f.cacheDir, "my_asset", packFiles);

    writeMapping(f.stateDir, { [String(grantId)]: makeEntry(f.target) });
    writeState(f.stateDir, [
      makeAssetState(grantId, zipPath, f.target, {
        versionId: 11,
        deployedAt: "2026-04-17T00:00:00.000Z",
        pristineVersionId: 10,
        pristineCapturedAt: "2026-04-17T00:00:00.000Z",
        pristineHashes: hashesFrom(pristineFiles),
      }),
    ]);

    const out = await cfx_deploy_asset({
      grantId,
      conflictResolutions: { "config.lua": "take-live" },
    });

    expect(out.preservationMode).toBe("layer-2");
    // take-live → config.lua keeps USER_EDIT
    expect(readFileSync(path.join(f.target, "config.lua"), "utf8")).toBe("USER_EDIT");
    // Plan should show conflict rewritten to preserve-live
    const configRow = out.plan!.rows.find((r) => r.path === "config.lua");
    expect(configRow?.decision).toBe("preserve-live");
  });

  it("CFX_SYNC_PRESERVE=0 takes legacy path and never captures pristine", async () => {
    setupEnv(f, { preserve: false });
    const v1Files = { "fxmanifest.lua": "v1", "server.lua": "print('v1')" };
    const zipPath = await makePackZip(f.cacheDir, "my_asset", v1Files);

    writeMapping(f.stateDir, { [String(grantId)]: makeEntry(f.target) });
    writeState(f.stateDir, [makeAssetState(grantId, zipPath, f.target)]);

    const out = await cfx_deploy_asset({ grantId, dryRun: false });

    expect(out.preservationMode).toBe("legacy");
    expect(out.pristineCaptured).toBe(false);
    expect(out.plan).toBeNull();
    // Live deployed
    expect(readFileSync(path.join(f.target, "fxmanifest.lua"), "utf8")).toBe("v1");
    // Pristine dir NOT created for this grant
    expect(existsSync(path.join(f.pristineDir, String(grantId)))).toBe(false);
    // State has no pristine fields set
    const onDisk = readState(f.stateDir);
    expect(onDisk.assets[String(grantId)]!.pristineVersionId).toBeNull();
    expect(onDisk.assets[String(grantId)]!.pristineHashes).toBeNull();
  });

  it("dryRun on layer-2 returns plan without mutating disk", async () => {
    setupEnv(f);
    const pristineFiles = { "fxmanifest.lua": "v1", "config.lua": "BASE" };
    const liveFiles = { "fxmanifest.lua": "v1", "config.lua": "USER_EDIT" };
    seedLive(f.target, liveFiles);
    mkdirSync(path.join(f.pristineDir, String(grantId)), { recursive: true });
    for (const [rel, body] of Object.entries(pristineFiles)) {
      writeFileSync(path.join(f.pristineDir, String(grantId), rel), body);
    }
    const packFiles = { "fxmanifest.lua": "v2", "config.lua": "BASE" };
    const zipPath = await makePackZip(f.cacheDir, "my_asset", packFiles);

    writeMapping(f.stateDir, { [String(grantId)]: makeEntry(f.target) });
    writeState(f.stateDir, [
      makeAssetState(grantId, zipPath, f.target, {
        versionId: 11,
        deployedAt: "2026-04-17T00:00:00.000Z",
        pristineVersionId: 10,
        pristineCapturedAt: "2026-04-17T00:00:00.000Z",
        pristineHashes: hashesFrom(pristineFiles),
      }),
    ]);

    const priorPristine = readFileSync(
      path.join(f.pristineDir, String(grantId), "fxmanifest.lua"),
      "utf8"
    );

    const out = await cfx_deploy_asset({ grantId, dryRun: true });

    expect(out.dryRun).toBe(true);
    expect(out.preservationMode).toBe("layer-2");
    expect(out.plan).not.toBeNull();
    expect(out.plan!.rows.length).toBeGreaterThan(0);
    expect(out.pristineCaptured).toBe(false);
    // Live untouched
    expect(readFileSync(path.join(f.target, "fxmanifest.lua"), "utf8")).toBe("v1");
    expect(readFileSync(path.join(f.target, "config.lua"), "utf8")).toBe("USER_EDIT");
    // Pristine untouched
    expect(
      readFileSync(path.join(f.pristineDir, String(grantId), "fxmanifest.lua"), "utf8")
    ).toBe(priorPristine);
    // State pristineVersionId unchanged
    const onDisk = readState(f.stateDir);
    expect(onDisk.assets[String(grantId)]!.pristineVersionId).toBe(10);
  });
});
