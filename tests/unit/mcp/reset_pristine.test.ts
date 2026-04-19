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
import { cfx_reset_pristine } from "../../../src/mcp/tools/reset_pristine.js";
import {
  ResetPristineInput,
  ResetPristineOutput,
} from "../../../src/mcp/schemas/index.js";
import { NotFoundError, CfxError } from "../../../src/lib/errors.js";
import type { AssetState } from "../../../src/lib/state/state.js";
import {
  writeInFlightMarker,
  readInFlightMarker,
  markerPath,
} from "../../../src/lib/deploy/inFlight.js";

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

function seedPristineDir(pristineDir: string, grantId: number, files: Record<string, string> = { "fxmanifest.lua": "name 'x'" }): void {
  const dir = path.join(pristineDir, String(grantId));
  mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
}

function seedPristineHistory(
  historyDir: string,
  grantId: number,
  versionId: number,
  files: Record<string, string> = { "fxmanifest.lua": "name 'x'" }
): void {
  const dir = path.join(historyDir, String(grantId), String(versionId));
  mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
}

describe("cfx_reset_pristine", () => {
  let dir: string;
  let stateDir: string;
  let pristineDir: string;
  let pristineHistoryDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cfx-reset-"));
    stateDir = path.join(dir, "state");
    pristineDir = path.join(stateDir, "pristine");
    pristineHistoryDir = path.join(stateDir, "pristine-history");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(path.join(dir, "resources"), { recursive: true });
    process.env.CFX_SERVER_RESOURCES = path.join(dir, "resources");
    process.env.CFX_STATE_DIR = stateDir;
    process.env.CFX_CACHE_DIR = path.join(dir, "cache");
    process.env.CFX_STAGING_DIR = path.join(dir, "staging");
    process.env.CFX_BACKUP_DIR = path.join(dir, "backups");
    process.env.CFX_COOKIE_FILE = path.join(dir, ".cookies.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("grantId: removes only that grant's pristine dir and clears state fields", async () => {
    writeState(stateDir, [
      makeAssetState({
        grantId: 100,
        pristineVersionId: 10,
        pristineCapturedAt: "2026-01-01T00:00:00.000Z",
        pristineHashes: { "fxmanifest.lua": "abc123" },
      }),
      makeAssetState({
        grantId: 200,
        pristineVersionId: 20,
        pristineCapturedAt: "2026-02-02T00:00:00.000Z",
        pristineHashes: { "fxmanifest.lua": "def456" },
      }),
    ]);
    seedPristineDir(pristineDir, 100);
    seedPristineDir(pristineDir, 200);

    const result = await cfx_reset_pristine({ grantId: 100 });
    const parsed = ResetPristineOutput.parse(result);

    expect(parsed.removed).toEqual([100]);
    expect(parsed.orphansGced).toEqual([]);

    // Grant 100's pristine dir gone; grant 200 untouched.
    expect(existsSync(path.join(pristineDir, "100"))).toBe(false);
    expect(existsSync(path.join(pristineDir, "200"))).toBe(true);

    // State: 100 cleared, 200 preserved.
    const onDisk = readState(stateDir);
    expect(onDisk.assets["100"]!.pristineVersionId).toBeNull();
    expect(onDisk.assets["100"]!.pristineCapturedAt).toBeNull();
    expect(onDisk.assets["100"]!.pristineHashes).toBeNull();
    expect(onDisk.assets["200"]!.pristineVersionId).toBe(20);
    expect(onDisk.assets["200"]!.pristineCapturedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(onDisk.assets["200"]!.pristineHashes).toEqual({ "fxmanifest.lua": "def456" });
  });

  it("grantId: throws NotFoundError when grant is not in state", async () => {
    writeState(stateDir, [
      makeAssetState({ grantId: 100, pristineVersionId: 10, pristineHashes: { a: "b" } }),
    ]);

    await expect(cfx_reset_pristine({ grantId: 999 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("grantId: succeeds even when the pristine dir does not exist on disk", async () => {
    writeState(stateDir, [
      makeAssetState({
        grantId: 100,
        pristineVersionId: 10,
        pristineCapturedAt: "2026-01-01T00:00:00.000Z",
        pristineHashes: { a: "b" },
      }),
    ]);
    // No pristine dir seeded.

    const result = await cfx_reset_pristine({ grantId: 100 });
    expect(result.removed).toEqual([100]);
    expect(result.orphansGced).toEqual([]);

    const onDisk = readState(stateDir);
    expect(onDisk.assets["100"]!.pristineVersionId).toBeNull();
    expect(onDisk.assets["100"]!.pristineHashes).toBeNull();
  });

  it("grantId: preserves pristine-history so older backups stay rollback-able", async () => {
    // Spec: reset only drops the CURRENT pristine baseline. pristine-history
    // entries are referenced by backup manifests (pristineVersionIdAtBackupTime)
    // and must survive so cfx_rollback can restore an older baseline.
    writeState(stateDir, [
      makeAssetState({ grantId: 100, pristineVersionId: 10, pristineHashes: { a: "b" } }),
      makeAssetState({ grantId: 200, pristineVersionId: 20, pristineHashes: { c: "d" } }),
    ]);
    seedPristineDir(pristineDir, 100);
    seedPristineDir(pristineDir, 200);
    seedPristineHistory(pristineHistoryDir, 100, 9);
    seedPristineHistory(pristineHistoryDir, 100, 10);
    seedPristineHistory(pristineHistoryDir, 200, 19);

    await cfx_reset_pristine({ grantId: 100 });

    // Current pristine dropped…
    expect(existsSync(path.join(pristineDir, "100"))).toBe(false);
    // …but history is untouched — for both the reset grant AND siblings.
    expect(existsSync(path.join(pristineHistoryDir, "100", "9"))).toBe(true);
    expect(existsSync(path.join(pristineHistoryDir, "100", "10"))).toBe(true);
    expect(existsSync(path.join(pristineHistoryDir, "200", "19"))).toBe(true);
  });

  it("all: true — removes every pristine dir and clears every state entry", async () => {
    writeState(stateDir, [
      makeAssetState({
        grantId: 100,
        pristineVersionId: 10,
        pristineCapturedAt: "2026-01-01T00:00:00.000Z",
        pristineHashes: { a: "b" },
      }),
      makeAssetState({
        grantId: 200,
        pristineVersionId: 20,
        pristineCapturedAt: "2026-02-02T00:00:00.000Z",
        pristineHashes: { c: "d" },
      }),
    ]);
    seedPristineDir(pristineDir, 100);
    seedPristineDir(pristineDir, 200);

    const result = await cfx_reset_pristine({ all: true });
    expect(result.removed.sort((a, b) => a - b)).toEqual([100, 200]);
    expect(result.orphansGced).toEqual([]);

    expect(existsSync(path.join(pristineDir, "100"))).toBe(false);
    expect(existsSync(path.join(pristineDir, "200"))).toBe(false);

    const onDisk = readState(stateDir);
    expect(onDisk.assets["100"]!.pristineVersionId).toBeNull();
    expect(onDisk.assets["100"]!.pristineHashes).toBeNull();
    expect(onDisk.assets["200"]!.pristineVersionId).toBeNull();
    expect(onDisk.assets["200"]!.pristineHashes).toBeNull();
  });

  it("empty {} — equivalent to {all: true}", async () => {
    writeState(stateDir, [
      makeAssetState({ grantId: 100, pristineVersionId: 10, pristineHashes: { a: "b" } }),
    ]);
    seedPristineDir(pristineDir, 100);

    const result = await cfx_reset_pristine({});
    expect(result.removed).toEqual([100]);
    const onDisk = readState(stateDir);
    expect(onDisk.assets["100"]!.pristineHashes).toBeNull();
  });

  it("all: true — GCs orphan pristine dirs that are not in state", async () => {
    writeState(stateDir, [
      makeAssetState({ grantId: 100, pristineVersionId: 10, pristineHashes: { a: "b" } }),
    ]);
    seedPristineDir(pristineDir, 100);
    // Orphan — not in state.
    seedPristineDir(pristineDir, 777);
    seedPristineDir(pristineDir, 888);

    const result = await cfx_reset_pristine({ all: true });

    expect(result.removed).toEqual([100]);
    expect(result.orphansGced.sort((a, b) => a - b)).toEqual([777, 888]);

    expect(existsSync(path.join(pristineDir, "100"))).toBe(false);
    expect(existsSync(path.join(pristineDir, "777"))).toBe(false);
    expect(existsSync(path.join(pristineDir, "888"))).toBe(false);
  });

  it("all: true — leaves pristine-history intact (incl. orphan history dirs)", async () => {
    // Spec: reset does not touch pristine-history. Even orphaned history
    // snapshots stay — they're tied to a backup manifest, not to state.
    writeState(stateDir, [
      makeAssetState({ grantId: 100, pristineVersionId: 10, pristineHashes: { a: "b" } }),
    ]);
    seedPristineDir(pristineDir, 100);
    seedPristineHistory(pristineHistoryDir, 100, 9);
    // Orphan pristine-history — no state entry, no pristine dir either.
    seedPristineHistory(pristineHistoryDir, 555, 1);

    const result = await cfx_reset_pristine({ all: true });

    // orphansGced only reports pristine/ orphans, not pristine-history/.
    expect(result.orphansGced).toEqual([]);
    // Both history dirs survived the reset.
    expect(existsSync(path.join(pristineHistoryDir, "100", "9"))).toBe(true);
    expect(existsSync(path.join(pristineHistoryDir, "555", "1"))).toBe(true);
  });

  it("all: true — succeeds on fresh install with no pristine dir present", async () => {
    writeState(stateDir, []);
    // No pristine dir, no history dir.

    const result = await cfx_reset_pristine({ all: true });
    expect(result.removed).toEqual([]);
    expect(result.orphansGced).toEqual([]);
  });

  it("grantId AND all together is a zod validation error", () => {
    const parsed = ResetPristineInput.safeParse({ grantId: 100, all: true });
    expect(parsed.success).toBe(false);
  });

  it("skips transient .tmp.* and .old.* dirs when GCing orphans", async () => {
    writeState(stateDir, [
      makeAssetState({ grantId: 100, pristineVersionId: 10, pristineHashes: { a: "b" } }),
    ]);
    seedPristineDir(pristineDir, 100);
    // Transient artifacts — should NOT be reported as orphans.
    mkdirSync(path.join(pristineDir, "100.tmp.999.1.2"), { recursive: true });
    mkdirSync(path.join(pristineDir, "100.old.2026-01-01T00-00-00Z"), { recursive: true });
    // Real orphan.
    seedPristineDir(pristineDir, 777);

    const result = await cfx_reset_pristine({ all: true });

    expect(result.orphansGced).toEqual([777]);
    // Grant 100's real dir was removed (state entry); 777 gone (orphan GC).
    expect(existsSync(path.join(pristineDir, "777"))).toBe(false);
  });

  it("result round-trips through ResetPristineOutput schema", async () => {
    writeState(stateDir, [
      makeAssetState({ grantId: 100, pristineVersionId: 10, pristineHashes: { a: "b" } }),
    ]);
    seedPristineDir(pristineDir, 100);
    const result = await cfx_reset_pristine({ grantId: 100 });
    const roundTripped = ResetPristineOutput.parse(result);
    expect(roundTripped).toEqual(result);
  });

  it("NotFoundError is a CfxError (consistent with other tools)", async () => {
    writeState(stateDir, []);
    await expect(cfx_reset_pristine({ grantId: 999 })).rejects.toBeInstanceOf(CfxError);
  });

  // --- Gap #2 fix: reset_pristine clears in-flight marker -----------------
  // When a prior deploy crashed in the rotate-or-save window, the marker is
  // left on disk to flag the torn state. Running `cfx_reset_pristine {grantId}`
  // is the "accept current live, re-baseline pristine" recovery path — it
  // MUST clear the marker so the next deploy is a clean first-deploy rather
  // than throwing DeployInterruptedError again.

  it("grantId: clears the in-flight marker for the targeted grant", async () => {
    writeState(stateDir, [
      makeAssetState({ grantId: 100, pristineVersionId: 10, pristineHashes: { a: "b" } }),
      makeAssetState({ grantId: 200, pristineVersionId: 20, pristineHashes: { c: "d" } }),
    ]);
    seedPristineDir(pristineDir, 100);
    seedPristineDir(pristineDir, 200);
    await writeInFlightMarker(stateDir, {
      grantId: 100,
      stagingPath: "/tmp/staging",
      backupPath: "/tmp/backup",
      startedAt: "2026-04-18T00:00:00.000Z",
    });
    await writeInFlightMarker(stateDir, {
      grantId: 200,
      stagingPath: "/tmp/staging2",
      backupPath: null,
      startedAt: "2026-04-18T00:00:00.000Z",
    });

    await cfx_reset_pristine({ grantId: 100 });

    // Marker for 100 cleared; 200's marker survives (untargeted).
    expect(existsSync(markerPath(stateDir, 100))).toBe(false);
    expect(await readInFlightMarker(stateDir, 100)).toBeNull();
    expect(existsSync(markerPath(stateDir, 200))).toBe(true);
    expect(await readInFlightMarker(stateDir, 200)).not.toBeNull();
  });

  it("grantId: succeeds when no marker exists (ENOENT-tolerant)", async () => {
    // Common case: reset called without any prior crash. clearInFlightMarker
    // must not throw on ENOENT.
    writeState(stateDir, [
      makeAssetState({ grantId: 100, pristineVersionId: 10, pristineHashes: { a: "b" } }),
    ]);
    seedPristineDir(pristineDir, 100);

    await expect(cfx_reset_pristine({ grantId: 100 })).resolves.toBeTruthy();
    expect(existsSync(markerPath(stateDir, 100))).toBe(false);
  });

  it("all: true — clears markers for every reset grant", async () => {
    writeState(stateDir, [
      makeAssetState({ grantId: 100, pristineVersionId: 10, pristineHashes: { a: "b" } }),
      makeAssetState({ grantId: 200, pristineVersionId: 20, pristineHashes: { c: "d" } }),
    ]);
    seedPristineDir(pristineDir, 100);
    seedPristineDir(pristineDir, 200);
    await writeInFlightMarker(stateDir, {
      grantId: 100,
      stagingPath: "/s1",
      backupPath: null,
      startedAt: "2026-04-18T00:00:00.000Z",
    });
    await writeInFlightMarker(stateDir, {
      grantId: 200,
      stagingPath: "/s2",
      backupPath: null,
      startedAt: "2026-04-18T00:00:00.000Z",
    });

    const result = await cfx_reset_pristine({ all: true });
    expect(result.removed.sort((a, b) => a - b)).toEqual([100, 200]);

    expect(existsSync(markerPath(stateDir, 100))).toBe(false);
    expect(existsSync(markerPath(stateDir, 200))).toBe(false);
  });

  it("empty {} — clears markers (equivalent to {all: true})", async () => {
    writeState(stateDir, [
      makeAssetState({ grantId: 100, pristineVersionId: 10, pristineHashes: { a: "b" } }),
    ]);
    seedPristineDir(pristineDir, 100);
    await writeInFlightMarker(stateDir, {
      grantId: 100,
      stagingPath: "/s",
      backupPath: null,
      startedAt: "2026-04-18T00:00:00.000Z",
    });

    await cfx_reset_pristine({});
    expect(existsSync(markerPath(stateDir, 100))).toBe(false);
  });
});
