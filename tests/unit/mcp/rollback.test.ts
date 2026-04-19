import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { cfx_rollback } from "../../../src/mcp/tools/rollback.js";
import { RollbackOutput } from "../../../src/mcp/schemas/index.js";
import type { AssetState } from "../../../src/lib/state/state.js";
import type { MappingEntry } from "../../../src/lib/state/mapping.js";

function makeAssetState(overrides: Partial<AssetState> & { grantId: number }): AssetState {
  return {
    grantId: overrides.grantId,
    assetId: overrides.assetId ?? overrides.grantId,
    slug: overrides.slug ?? `asset-${overrides.grantId}`,
    assetName: overrides.assetName ?? `Asset ${overrides.grantId}`,
    versionId: overrides.versionId ?? 10,
    packId: overrides.packId ?? 1,
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
    sha256: overrides.sha256 ?? "deadbeef",
    cachedZipPath: overrides.cachedZipPath ?? "/tmp/x.zip",
    deployedPath: overrides.deployedPath ?? "/tmp/dest",
    deployedAt: overrides.deployedAt ?? "2026-01-01T00:00:00.000Z",
    backups: overrides.backups ?? [],
    pristineVersionId: overrides.pristineVersionId ?? null,
    pristineCapturedAt: overrides.pristineCapturedAt ?? null,
    pristineHashes: overrides.pristineHashes ?? null,
  };
}

function writeState(stateDir: string, assets: AssetState[]): void {
  const data = {
    version: 3,
    rateLimit: {},
    assets: Object.fromEntries(assets.map((a) => [String(a.grantId), a])),
  };
  writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(data, null, 2));
}

function readState(stateDir: string): { version: number; assets: Record<string, AssetState> } {
  return JSON.parse(readFileSync(path.join(stateDir, "state.json"), "utf8")) as {
    version: number;
    assets: Record<string, AssetState>;
  };
}

function writeMapping(stateDir: string, entries: Record<string, MappingEntry>): void {
  const data = {
    version: 2,
    approvedAt: "2026-01-01T00:00:00.000Z",
    entries,
    newInstalls: [],
    orphaned: [],
  };
  writeFileSync(path.join(stateDir, "cfx-sync-map.json"), JSON.stringify(data, null, 2));
}

/** Copy of the deployer's BackupManifest shape — kept local to avoid cross-import. */
interface BackupManifestShape {
  slug: string;
  grantId: number | null;
  backedUpAt: string;
  pristineVersionIdAtBackupTime: number | null;
  pristineSnapshotPath: string | null;
  pristineHashesAtBackupTime: Record<string, string> | null;
  pristineCapturedAtAtBackupTime: string | null;
}

/** Seed a new-layout backup at <backupDir>/<slug>/<iso>/ with manifest.json + resource/. */
function seedNewBackup(opts: {
  backupDir: string;
  slug: string;
  iso: string;
  resourceFiles: Record<string, string>;
  manifest: BackupManifestShape;
}): string {
  const backupRoot = path.join(opts.backupDir, opts.slug, opts.iso);
  const resourceDir = path.join(backupRoot, "resource");
  mkdirSync(resourceDir, { recursive: true });
  for (const [rel, body] of Object.entries(opts.resourceFiles)) {
    const full = path.join(resourceDir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  writeFileSync(path.join(backupRoot, "manifest.json"), JSON.stringify(opts.manifest, null, 2));
  return backupRoot;
}

/** Seed a legacy v0.1.0 backup at <backupDir>/<slug>/<iso>/ (no manifest; resource at root). */
function seedLegacyBackup(opts: {
  backupDir: string;
  slug: string;
  iso: string;
  files: Record<string, string>;
}): string {
  const backupRoot = path.join(opts.backupDir, opts.slug, opts.iso);
  mkdirSync(backupRoot, { recursive: true });
  for (const [rel, body] of Object.entries(opts.files)) {
    const full = path.join(backupRoot, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return backupRoot;
}

function seedPristineHistory(
  historyDir: string,
  grantId: number,
  versionId: number,
  files: Record<string, string> = { "fxmanifest.lua": "name 'x'" }
): string {
  const dir = path.join(historyDir, String(grantId), String(versionId));
  mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

function seedPristineDir(
  pristineDir: string,
  grantId: number,
  files: Record<string, string>
): string {
  const dir = path.join(pristineDir, String(grantId));
  mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

describe("cfx_rollback", () => {
  let dir: string;
  let stateDir: string;
  let pristineDir: string;
  let pristineHistoryDir: string;
  let backupDir: string;
  let resources: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cfx-rb-mcp-"));
    stateDir = path.join(dir, "state");
    pristineDir = path.join(stateDir, "pristine");
    pristineHistoryDir = path.join(stateDir, "pristine-history");
    backupDir = path.join(dir, "backups");
    resources = path.join(dir, "resources");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(resources, { recursive: true });
    process.env.CFX_SERVER_RESOURCES = resources;
    process.env.CFX_STATE_DIR = stateDir;
    process.env.CFX_CACHE_DIR = path.join(dir, "cache");
    process.env.CFX_STAGING_DIR = path.join(dir, "staging");
    process.env.CFX_BACKUP_DIR = backupDir;
    process.env.CFX_COOKIE_FILE = path.join(dir, ".cookies.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rotates pristine from history + updates state when backup manifest has pristine info", async () => {
    // Set up: grant 7 deployed twice. Current state = pristine v2; backup was
    // taken when pristine was v1 (so backup manifest references history/7/1).
    const target = path.join(resources, "qs-inventory");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "fxmanifest.lua"), "v2");

    // Current pristine = v2.
    seedPristineDir(pristineDir, 7, { "fxmanifest.lua": "v2" });

    // History has v1.
    const v1SnapshotPath = seedPristineHistory(pristineHistoryDir, 7, 1, {
      "fxmanifest.lua": "v1",
    });

    // Backup created at "v1 → v2" deploy → manifest points at v1 snapshot.
    const manifest: BackupManifestShape = {
      slug: "qs_inventory",
      grantId: 7,
      backedUpAt: "2026-03-01T00:00:00.000Z",
      pristineVersionIdAtBackupTime: 1,
      pristineSnapshotPath: v1SnapshotPath,
      pristineHashesAtBackupTime: { "fxmanifest.lua": "sha-v1" },
      pristineCapturedAtAtBackupTime: "2026-02-01T00:00:00.000Z",
    };
    seedNewBackup({
      backupDir,
      slug: "qs_inventory",
      iso: "2026-03-01T00-00-00-000Z",
      resourceFiles: { "fxmanifest.lua": "v1" },
      manifest,
    });

    writeMapping(stateDir, {
      "7": {
        slug: "qs_inventory",
        target,
        disabled: false,
        assetName: "QS Inventory",
        discoveredTier: 1,
        discoveredConfidence: 1.0,
      },
    });
    writeState(stateDir, [
      makeAssetState({
        grantId: 7,
        slug: "qs_inventory",
        deployedPath: target,
        pristineVersionId: 2,
        pristineCapturedAt: "2026-03-01T00:00:00.000Z",
        pristineHashes: { "fxmanifest.lua": "sha-v2" },
      }),
    ]);

    const out = await cfx_rollback({ grantId: 7 });
    const parsed = RollbackOutput.parse(out);

    // Live restored to v1.
    expect(readFileSync(path.join(target, "fxmanifest.lua"), "utf8")).toBe("v1");
    // Pristine dir restored to v1.
    expect(readFileSync(path.join(pristineDir, "7", "fxmanifest.lua"), "utf8")).toBe("v1");
    expect(parsed.pristineRotatedTo).toBe(1);
    expect(parsed.suggestedRestartCommand).toBe("restart qs_inventory");

    // State updated: pristineVersionId back to 1; hashes/capturedAt restored from manifest.
    const onDisk = readState(stateDir);
    expect(onDisk.assets["7"]!.pristineVersionId).toBe(1);
    expect(onDisk.assets["7"]!.pristineCapturedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(onDisk.assets["7"]!.pristineHashes).toEqual({ "fxmanifest.lua": "sha-v1" });
  });

  it("clears state pristine fields when manifest has null pristineVersionIdAtBackupTime (first-deploy backup)", async () => {
    // Backup from a first-deploy: manifest exists but pristine fields are null
    // because there was no prior pristine to snapshot. Rolling back should
    // reset state's pristine to null so the next deploy runs as first-deploy.
    const target = path.join(resources, "qs-inventory");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "fxmanifest.lua"), "v2");

    // Current pristine = v1 (captured during the first deploy).
    seedPristineDir(pristineDir, 7, { "fxmanifest.lua": "v1" });

    const manifest: BackupManifestShape = {
      slug: "qs_inventory",
      grantId: 7,
      backedUpAt: "2026-03-01T00:00:00.000Z",
      pristineVersionIdAtBackupTime: null,
      pristineSnapshotPath: null,
      pristineHashesAtBackupTime: null,
      pristineCapturedAtAtBackupTime: null,
    };
    seedNewBackup({
      backupDir,
      slug: "qs_inventory",
      iso: "2026-03-01T00-00-00-000Z",
      resourceFiles: { "fxmanifest.lua": "v1" },
      manifest,
    });

    writeMapping(stateDir, {
      "7": {
        slug: "qs_inventory",
        target,
        disabled: false,
        assetName: "QS Inventory",
        discoveredTier: 1,
        discoveredConfidence: 1.0,
      },
    });
    writeState(stateDir, [
      makeAssetState({
        grantId: 7,
        slug: "qs_inventory",
        deployedPath: target,
        pristineVersionId: 1,
        pristineCapturedAt: "2026-02-01T00:00:00.000Z",
        pristineHashes: { "fxmanifest.lua": "sha-v1" },
      }),
    ]);

    const out = await cfx_rollback({ grantId: 7 });
    const parsed = RollbackOutput.parse(out);

    expect(readFileSync(path.join(target, "fxmanifest.lua"), "utf8")).toBe("v1");
    expect(parsed.pristineRotatedTo).toBeNull();

    // Pristine dir cleared so it can't mis-match live on next deploy.
    expect(existsSync(path.join(pristineDir, "7"))).toBe(false);

    const onDisk = readState(stateDir);
    expect(onDisk.assets["7"]!.pristineVersionId).toBeNull();
    expect(onDisk.assets["7"]!.pristineCapturedAt).toBeNull();
    expect(onDisk.assets["7"]!.pristineHashes).toBeNull();
  });

  it("clears state pristine fields on legacy (v0.1.0) backup with no manifest", async () => {
    const target = path.join(resources, "qs-inventory");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "fxmanifest.lua"), "v2");

    // Current pristine = v2 (adopted at some point after the legacy backup).
    seedPristineDir(pristineDir, 7, { "fxmanifest.lua": "v2" });

    // Legacy layout: no manifest.json, resource files at the iso-dir root.
    seedLegacyBackup({
      backupDir,
      slug: "qs_inventory",
      iso: "2026-03-01T00-00-00-000Z",
      files: { "fxmanifest.lua": "v1" },
    });

    writeMapping(stateDir, {
      "7": {
        slug: "qs_inventory",
        target,
        disabled: false,
        assetName: "QS Inventory",
        discoveredTier: 1,
        discoveredConfidence: 1.0,
      },
    });
    writeState(stateDir, [
      makeAssetState({
        grantId: 7,
        slug: "qs_inventory",
        deployedPath: target,
        pristineVersionId: 2,
        pristineCapturedAt: "2026-03-01T00:00:00.000Z",
        pristineHashes: { "fxmanifest.lua": "sha-v2" },
      }),
    ]);

    const out = await cfx_rollback({ grantId: 7 });
    const parsed = RollbackOutput.parse(out);

    expect(readFileSync(path.join(target, "fxmanifest.lua"), "utf8")).toBe("v1");
    expect(parsed.pristineRotatedTo).toBeNull();
    expect(existsSync(path.join(pristineDir, "7"))).toBe(false);

    const onDisk = readState(stateDir);
    expect(onDisk.assets["7"]!.pristineVersionId).toBeNull();
    expect(onDisk.assets["7"]!.pristineCapturedAt).toBeNull();
    expect(onDisk.assets["7"]!.pristineHashes).toBeNull();
  });

  it("leaves pristine-history intact so the same rollback can be re-run", async () => {
    const target = path.join(resources, "qs-inventory");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "fxmanifest.lua"), "v2");
    seedPristineDir(pristineDir, 7, { "fxmanifest.lua": "v2" });
    const v1SnapshotPath = seedPristineHistory(pristineHistoryDir, 7, 1, {
      "fxmanifest.lua": "v1",
    });

    const manifest: BackupManifestShape = {
      slug: "qs_inventory",
      grantId: 7,
      backedUpAt: "2026-03-01T00:00:00.000Z",
      pristineVersionIdAtBackupTime: 1,
      pristineSnapshotPath: v1SnapshotPath,
      pristineHashesAtBackupTime: { "fxmanifest.lua": "sha-v1" },
      pristineCapturedAtAtBackupTime: "2026-02-01T00:00:00.000Z",
    };
    seedNewBackup({
      backupDir,
      slug: "qs_inventory",
      iso: "2026-03-01T00-00-00-000Z",
      resourceFiles: { "fxmanifest.lua": "v1" },
      manifest,
    });
    writeMapping(stateDir, {
      "7": {
        slug: "qs_inventory",
        target,
        disabled: false,
        assetName: "QS Inventory",
        discoveredTier: 1,
        discoveredConfidence: 1.0,
      },
    });
    writeState(stateDir, [
      makeAssetState({
        grantId: 7,
        slug: "qs_inventory",
        deployedPath: target,
        pristineVersionId: 2,
        pristineHashes: { "fxmanifest.lua": "sha-v2" },
      }),
    ]);

    await cfx_rollback({ grantId: 7 });

    // pristine-history/7/1 must survive so another rollback to the same
    // version (or the same backup after an accidental redeploy) still works.
    expect(existsSync(v1SnapshotPath)).toBe(true);
    expect(readFileSync(path.join(v1SnapshotPath, "fxmanifest.lua"), "utf8")).toBe("v1");
  });

  it("resolves by slug too", async () => {
    const target = path.join(resources, "qs-inventory");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "fxmanifest.lua"), "v2");

    seedLegacyBackup({
      backupDir,
      slug: "qs_inventory",
      iso: "2026-03-01T00-00-00-000Z",
      files: { "fxmanifest.lua": "v1" },
    });
    writeMapping(stateDir, {
      "7": {
        slug: "qs_inventory",
        target,
        disabled: false,
        assetName: "QS Inventory",
        discoveredTier: 1,
        discoveredConfidence: 1.0,
      },
    });
    writeState(stateDir, [
      makeAssetState({ grantId: 7, slug: "qs_inventory", deployedPath: target }),
    ]);

    const out = await cfx_rollback({ slug: "qs_inventory" });
    expect(readFileSync(path.join(target, "fxmanifest.lua"), "utf8")).toBe("v1");
    expect(out.pristineRotatedTo).toBeNull();
  });
});
