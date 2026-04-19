import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { deploy } from "../../../src/lib/deploy/deployer.js";
import { rollback } from "../../../src/lib/deploy/rollback.js";
import type { BackupManifest } from "../../../src/lib/deploy/deployer.js";
import { NotFoundError, IoError } from "../../../src/lib/errors.js";

describe("rollback", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), "cfx-rb-")); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("restores the most recent backup (new layout: <iso>/resource/)", async () => {
    const target = path.join(tmp, "srv", "[qs]", "qs-inventory");
    const slugBackups = path.join(tmp, "backups", "qs_inventory");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "fxmanifest.lua"), "current");
    const bk = path.join(slugBackups, "2026-02-01T00-00-00-000Z");
    mkdirSync(path.join(bk, "resource"), { recursive: true });
    writeFileSync(path.join(bk, "resource", "fxmanifest.lua"), "old");
    const minimalManifest: BackupManifest = {
      slug: "qs_inventory",
      grantId: null,
      backedUpAt: "2026-02-01T00:00:00.000Z",
      pristineVersionIdAtBackupTime: null,
      pristineSnapshotPath: null,
      pristineHashesAtBackupTime: null,
      pristineCapturedAtAtBackupTime: null,
    };
    writeFileSync(path.join(bk, "manifest.json"), JSON.stringify(minimalManifest));

    const r = await rollback({ targetPath: target, backupDir: path.join(tmp, "backups"), slug: "qs_inventory" });
    expect(readFileSync(path.join(target, "fxmanifest.lua"), "utf8")).toBe("old");
    expect(existsSync(r.newRollingBackup)).toBe(true);
    expect(r.restoredPristine).toBeNull();
  });

  it("restores legacy-layout backups (no manifest.json) — backwards compat", async () => {
    const target = path.join(tmp, "srv", "[qs]", "qs-inventory");
    const slugBackups = path.join(tmp, "backups", "qs_inventory");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "fxmanifest.lua"), "current");
    // Legacy: <iso>/ IS the resource — no manifest.json.
    const bk = path.join(slugBackups, "2026-02-01T00-00-00-000Z");
    mkdirSync(bk, { recursive: true });
    writeFileSync(path.join(bk, "fxmanifest.lua"), "old");

    const r = await rollback({ targetPath: target, backupDir: path.join(tmp, "backups"), slug: "qs_inventory" });
    expect(readFileSync(path.join(target, "fxmanifest.lua"), "utf8")).toBe("old");
    expect(r.restoredPristine).toBeNull();
  });

  it("throws NotFound when no backups exist", async () => {
    await expect(
      rollback({ targetPath: "/x", backupDir: path.join(tmp, "backups"), slug: "nothing" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rotates pristine to backup-time version when grantId + pristineDir supplied", async () => {
    // Full flow via deploy() so we exercise the real manifest writer.
    const srv = path.join(tmp, "srv", "[qs]");
    const target = path.join(srv, "qs-inventory");
    const backups = path.join(tmp, "backups");
    const pristineDir = path.join(tmp, "pristine");
    const pristineHistoryDir = path.join(tmp, "pristine-history");
    mkdirSync(srv, { recursive: true });

    // Seed live target (v1) + pristine (v100).
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "fxmanifest.lua"), "live-v1");
    mkdirSync(path.join(pristineDir, "42"), { recursive: true });
    writeFileSync(path.join(pristineDir, "42", "fxmanifest.lua"), "pristine-v100");

    // Deploy v2: backs up live-v1 + snapshots pristine v100.
    const staging = path.join(tmp, "staging", "pkg");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "fxmanifest.lua"), "live-v2");

    const deployRes = await deploy({
      stagingRoot: staging, targetPath: target, backupDir: backups,
      slug: "qs_inventory", dryRun: false, backupRetain: 5,
      pristine: {
        grantId: 42, currentPristineVersionId: 100,
        pristineDir, pristineHistoryDir,
        currentPristineHashes: { "fxmanifest.lua": "hash-of-pristine-v100" },
        currentPristineCapturedAt: "2026-04-01T00:00:00.000Z",
      },
    });
    expect(deployRes.pristineSnapshotPath).toBe(path.join(pristineHistoryDir, "42", "100"));

    // Simulate caller rotating pristine to v200 after deploy — the "current"
    // pristine no longer matches backup time.
    writeFileSync(path.join(pristineDir, "42", "fxmanifest.lua"), "pristine-v200");

    // Rollback — should restore live-v1 AND rotate pristine back to v100.
    const r = await rollback({
      targetPath: target, backupDir: backups, slug: "qs_inventory",
      grantId: 42, pristineDir,
    });
    expect(readFileSync(path.join(target, "fxmanifest.lua"), "utf8")).toBe("live-v1");
    expect(readFileSync(path.join(pristineDir, "42", "fxmanifest.lua"), "utf8")).toBe("pristine-v100");
    expect(r.restoredPristine).not.toBeNull();
    expect(r.restoredPristine!.pristineVersionId).toBe(100);
    expect(r.restoredPristine!.pristineHashes).toEqual({ "fxmanifest.lua": "hash-of-pristine-v100" });
    expect(r.restoredPristine!.pristineCapturedAt).toBe("2026-04-01T00:00:00.000Z");
  });

  it("leaves pristine alone when manifest has no snapshot (first-deploy backup)", async () => {
    const srv = path.join(tmp, "srv", "[qs]");
    const target = path.join(srv, "qs-inventory");
    const backups = path.join(tmp, "backups");
    const pristineDir = path.join(tmp, "pristine");
    const pristineHistoryDir = path.join(tmp, "pristine-history");
    mkdirSync(srv, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "fxmanifest.lua"), "live-v1");

    const staging = path.join(tmp, "staging", "pkg");
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "fxmanifest.lua"), "live-v2");

    // Deploy with pristine opts but no PRIOR pristine (first-capture scenario).
    await deploy({
      stagingRoot: staging, targetPath: target, backupDir: backups,
      slug: "qs_inventory", dryRun: false, backupRetain: 5,
      pristine: {
        grantId: 42, currentPristineVersionId: null,
        pristineDir, pristineHistoryDir,
        currentPristineHashes: null,
        currentPristineCapturedAt: null,
      },
    });

    // Now seed a "current" pristine (post-capture) so we can detect whether
    // rollback touches it.
    mkdirSync(path.join(pristineDir, "42"), { recursive: true });
    writeFileSync(path.join(pristineDir, "42", "fxmanifest.lua"), "pristine-current");

    const r = await rollback({
      targetPath: target, backupDir: backups, slug: "qs_inventory",
      grantId: 42, pristineDir,
    });
    expect(r.restoredPristine).toBeNull();
    // Pristine on disk should be untouched.
    expect(readFileSync(path.join(pristineDir, "42", "fxmanifest.lua"), "utf8")).toBe("pristine-current");
  });

  it("throws IO error when manifest references a pruned pristine snapshot", async () => {
    const target = path.join(tmp, "srv", "[qs]", "qs-inventory");
    const slugBackups = path.join(tmp, "backups", "qs_inventory");
    const pristineDir = path.join(tmp, "pristine");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "fxmanifest.lua"), "current");
    const bk = path.join(slugBackups, "2026-02-01T00-00-00-000Z");
    mkdirSync(path.join(bk, "resource"), { recursive: true });
    writeFileSync(path.join(bk, "resource", "fxmanifest.lua"), "old");
    const ghostSnapshot = path.join(tmp, "pristine-history", "42", "100");
    // Manifest points at a path that was never created / has been pruned.
    const manifest: BackupManifest = {
      slug: "qs_inventory",
      grantId: 42,
      backedUpAt: "2026-02-01T00:00:00.000Z",
      pristineVersionIdAtBackupTime: 100,
      pristineSnapshotPath: ghostSnapshot,
      pristineHashesAtBackupTime: { "fxmanifest.lua": "h" },
      pristineCapturedAtAtBackupTime: "2026-02-01T00:00:00.000Z",
    };
    writeFileSync(path.join(bk, "manifest.json"), JSON.stringify(manifest));

    await expect(
      rollback({
        targetPath: target, backupDir: path.join(tmp, "backups"), slug: "qs_inventory",
        grantId: 42, pristineDir,
      })
    ).rejects.toBeInstanceOf(IoError);
  });

  it("skips -rollback rolling-backup dirs when choosing newest", async () => {
    const target = path.join(tmp, "srv", "[qs]", "qs-inventory");
    const slugBackups = path.join(tmp, "backups", "qs_inventory");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "fxmanifest.lua"), "current");

    // An older regular backup.
    const bk1 = path.join(slugBackups, "2026-01-01T00-00-00-000Z");
    mkdirSync(path.join(bk1, "resource"), { recursive: true });
    writeFileSync(path.join(bk1, "resource", "fxmanifest.lua"), "old-v1");
    const m: BackupManifest = {
      slug: "qs_inventory", grantId: null, backedUpAt: "2026-01-01T00:00:00Z",
      pristineVersionIdAtBackupTime: null, pristineSnapshotPath: null,
      pristineHashesAtBackupTime: null, pristineCapturedAtAtBackupTime: null,
    };
    writeFileSync(path.join(bk1, "manifest.json"), JSON.stringify(m));

    // A newer rolling backup (should be ignored by default rollback).
    const bk2 = path.join(slugBackups, "2026-03-01T00-00-00-000Z-rollback");
    mkdirSync(path.join(bk2, "resource"), { recursive: true });
    writeFileSync(path.join(bk2, "resource", "fxmanifest.lua"), "rolling-stale");
    writeFileSync(path.join(bk2, "manifest.json"), JSON.stringify(m));

    const r = await rollback({ targetPath: target, backupDir: path.join(tmp, "backups"), slug: "qs_inventory" });
    expect(r.fromBackup).toBe("2026-01-01T00-00-00-000Z");
    expect(readFileSync(path.join(target, "fxmanifest.lua"), "utf8")).toBe("old-v1");
  });
});
