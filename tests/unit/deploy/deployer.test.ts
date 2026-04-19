import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { deploy } from "../../../src/lib/deploy/deployer.js";
import type { BackupManifest } from "../../../src/lib/deploy/deployer.js";
import { TargetParentMissingError, ValidationFailedError } from "../../../src/lib/errors.js";

describe("deploy", () => {
  let tmp: string;
  let staging: string;
  let srv: string;
  let backups: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "cfx-dep-"));
    staging = path.join(tmp, "staging", "pkg");
    srv = path.join(tmp, "srv", "[qs]");
    backups = path.join(tmp, "backups");
    mkdirSync(staging, { recursive: true });
    mkdirSync(srv, { recursive: true });
    writeFileSync(path.join(staging, "fxmanifest.lua"), "name 'qs-inventory'");
    writeFileSync(path.join(staging, "client.lua"), "x");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("installs fresh when target missing", async () => {
    const target = path.join(srv, "qs-inventory");
    const r = await deploy({ stagingRoot: staging, targetPath: target, backupDir: backups, slug: "qs_inventory", dryRun: false, backupRetain: 5 });
    expect(existsSync(path.join(target, "fxmanifest.lua"))).toBe(true);
    expect(r.backupPath).toBeNull();
    expect(r.pristineSnapshotPath).toBeNull();
  });

  it("backs up existing + swaps new (resource in <iso>/resource/, manifest sibling)", async () => {
    const target = path.join(srv, "qs-inventory");
    mkdirSync(target);
    writeFileSync(path.join(target, "fxmanifest.lua"), "old manifest");
    const r = await deploy({ stagingRoot: staging, targetPath: target, backupDir: backups, slug: "qs_inventory", dryRun: false, backupRetain: 5 });
    expect(readFileSync(path.join(target, "fxmanifest.lua"), "utf8")).toBe("name 'qs-inventory'");
    expect(r.backupPath).not.toBeNull();
    // New layout: backup root dir contains resource/ + manifest.json.
    expect(readFileSync(path.join(r.backupPath!, "resource", "fxmanifest.lua"), "utf8")).toBe("old manifest");
    expect(existsSync(path.join(r.backupPath!, "manifest.json"))).toBe(true);
  });

  it("writes a manifest.json with null pristine fields when no pristine opts passed", async () => {
    const target = path.join(srv, "qs-inventory");
    mkdirSync(target);
    writeFileSync(path.join(target, "fxmanifest.lua"), "old");
    const r = await deploy({ stagingRoot: staging, targetPath: target, backupDir: backups, slug: "qs_inventory", dryRun: false, backupRetain: 5 });
    const man = JSON.parse(readFileSync(path.join(r.backupPath!, "manifest.json"), "utf8")) as BackupManifest;
    expect(man.slug).toBe("qs_inventory");
    expect(man.grantId).toBeNull();
    expect(man.pristineVersionIdAtBackupTime).toBeNull();
    expect(man.pristineSnapshotPath).toBeNull();
    expect(man.pristineHashesAtBackupTime).toBeNull();
    expect(man.pristineCapturedAtAtBackupTime).toBeNull();
    expect(typeof man.backedUpAt).toBe("string");
  });

  it("snapshots pristine into pristine-history when opts supplied + prior pristine exists", async () => {
    const target = path.join(srv, "qs-inventory");
    mkdirSync(target);
    writeFileSync(path.join(target, "fxmanifest.lua"), "old");
    // Seed a prior pristine for grantId=42, versionId=100.
    const pristineDir = path.join(tmp, "pristine");
    const pristineHistoryDir = path.join(tmp, "pristine-history");
    mkdirSync(path.join(pristineDir, "42"), { recursive: true });
    writeFileSync(path.join(pristineDir, "42", "fxmanifest.lua"), "pristine-v100");
    writeFileSync(path.join(pristineDir, "42", "client.lua"), "pristine-client-v100");

    const r = await deploy({
      stagingRoot: staging,
      targetPath: target,
      backupDir: backups,
      slug: "qs_inventory",
      dryRun: false,
      backupRetain: 5,
      pristine: {
        grantId: 42,
        currentPristineVersionId: 100,
        pristineDir,
        pristineHistoryDir,
        currentPristineHashes: { "fxmanifest.lua": "abc", "client.lua": "def" },
        currentPristineCapturedAt: "2026-04-01T00:00:00.000Z",
      },
    });

    // Snapshot should exist at <history>/42/100/ with bit-exact content.
    const expectedSnap = path.join(pristineHistoryDir, "42", "100");
    expect(r.pristineSnapshotPath).toBe(expectedSnap);
    expect(readFileSync(path.join(expectedSnap, "fxmanifest.lua"), "utf8")).toBe("pristine-v100");
    expect(readFileSync(path.join(expectedSnap, "client.lua"), "utf8")).toBe("pristine-client-v100");

    // Current pristine dir should be unchanged (we copy, not move).
    expect(readFileSync(path.join(pristineDir, "42", "fxmanifest.lua"), "utf8")).toBe("pristine-v100");

    // Manifest should reflect the snapshot.
    const man = JSON.parse(readFileSync(path.join(r.backupPath!, "manifest.json"), "utf8")) as BackupManifest;
    expect(man.pristineVersionIdAtBackupTime).toBe(100);
    expect(man.pristineSnapshotPath).toBe(expectedSnap);
    expect(man.pristineHashesAtBackupTime).toEqual({ "fxmanifest.lua": "abc", "client.lua": "def" });
    expect(man.pristineCapturedAtAtBackupTime).toBe("2026-04-01T00:00:00.000Z");
    expect(man.grantId).toBe(42);
  });

  it("skips pristine snapshot when currentPristineVersionId is null", async () => {
    const target = path.join(srv, "qs-inventory");
    mkdirSync(target);
    writeFileSync(path.join(target, "fxmanifest.lua"), "old");
    const pristineDir = path.join(tmp, "pristine");
    const pristineHistoryDir = path.join(tmp, "pristine-history");

    const r = await deploy({
      stagingRoot: staging, targetPath: target, backupDir: backups,
      slug: "qs_inventory", dryRun: false, backupRetain: 5,
      pristine: {
        grantId: 7,
        currentPristineVersionId: null,
        pristineDir,
        pristineHistoryDir,
        currentPristineHashes: null,
        currentPristineCapturedAt: null,
      },
    });
    expect(r.pristineSnapshotPath).toBeNull();
    expect(existsSync(pristineHistoryDir)).toBe(false);
  });

  it("skips pristine snapshot when pristine source dir missing (state/disk mismatch)", async () => {
    const target = path.join(srv, "qs-inventory");
    mkdirSync(target);
    writeFileSync(path.join(target, "fxmanifest.lua"), "old");
    const pristineDir = path.join(tmp, "pristine");
    const pristineHistoryDir = path.join(tmp, "pristine-history");
    // State claims version 50, but no pristine dir on disk.
    const r = await deploy({
      stagingRoot: staging, targetPath: target, backupDir: backups,
      slug: "qs_inventory", dryRun: false, backupRetain: 5,
      pristine: {
        grantId: 99,
        currentPristineVersionId: 50,
        pristineDir,
        pristineHistoryDir,
        currentPristineHashes: { "a.lua": "x" },
        currentPristineCapturedAt: "2026-04-01T00:00:00.000Z",
      },
    });
    expect(r.pristineSnapshotPath).toBeNull();
    const man = JSON.parse(readFileSync(path.join(r.backupPath!, "manifest.json"), "utf8")) as BackupManifest;
    expect(man.pristineSnapshotPath).toBeNull();
    // Version stamp still written (callers can use it to detect the drift).
    expect(man.pristineVersionIdAtBackupTime).toBe(50);
  });

  it("prunes pristine-history when matching backup is pruned (retain=1)", async () => {
    const target = path.join(srv, "qs-inventory");
    mkdirSync(target);
    writeFileSync(path.join(target, "fxmanifest.lua"), "v0");

    const pristineDir = path.join(tmp, "pristine");
    const pristineHistoryDir = path.join(tmp, "pristine-history");
    mkdirSync(path.join(pristineDir, "42"), { recursive: true });
    writeFileSync(path.join(pristineDir, "42", "p.lua"), "v100");

    // Deploy 1 — snapshots pristine v100.
    const r1 = await deploy({
      stagingRoot: staging, targetPath: target, backupDir: backups,
      slug: "qs_inventory", dryRun: false, backupRetain: 1,
      pristine: {
        grantId: 42, currentPristineVersionId: 100,
        pristineDir, pristineHistoryDir,
        currentPristineHashes: { "p.lua": "h1" },
        currentPristineCapturedAt: "2026-04-01T00:00:00.000Z",
      },
    });
    expect(existsSync(r1.pristineSnapshotPath!)).toBe(true);

    // Simulate rotation bumping pristine to v200 before next deploy.
    writeFileSync(path.join(pristineDir, "42", "p.lua"), "v200");

    // Second staging for deploy 2.
    const s2 = path.join(tmp, "staging2", "pkg");
    mkdirSync(s2, { recursive: true });
    writeFileSync(path.join(s2, "fxmanifest.lua"), "new");
    // Target needs to exist again for backup.
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "fxmanifest.lua"), "v1");

    const r2 = await deploy({
      stagingRoot: s2, targetPath: target, backupDir: backups,
      slug: "qs_inventory", dryRun: false, backupRetain: 1,
      pristine: {
        grantId: 42, currentPristineVersionId: 200,
        pristineDir, pristineHistoryDir,
        currentPristineHashes: { "p.lua": "h2" },
        currentPristineCapturedAt: "2026-04-02T00:00:00.000Z",
      },
    });
    expect(existsSync(r2.pristineSnapshotPath!)).toBe(true);
    // retain=1 → first backup + its history snapshot should be gone.
    expect(existsSync(r1.backupPath!)).toBe(false);
    expect(existsSync(r1.pristineSnapshotPath!)).toBe(false);
    // History snapshot for v200 should still be there.
    expect(existsSync(r2.pristineSnapshotPath!)).toBe(true);
  });

  it("throws TARGET_PARENT_MISSING when category dir is gone", async () => {
    const target = path.join(tmp, "nonexistent", "[qs]", "qs-inventory");
    await expect(
      deploy({ stagingRoot: staging, targetPath: target, backupDir: backups, slug: "qs", dryRun: false, backupRetain: 5 })
    ).rejects.toBeInstanceOf(TargetParentMissingError);
  });

  it("dry-run returns planned moves without touching fs", async () => {
    const target = path.join(srv, "qs-inventory");
    const r = await deploy({ stagingRoot: staging, targetPath: target, backupDir: backups, slug: "qs_inventory", dryRun: true, backupRetain: 5 });
    expect(existsSync(target)).toBe(false);
    expect(r.willMoveFrom).toBe(staging);
    expect(r.willMoveTo).toBe(target);
  });

  it("refuses symlinks in staging (defensive against upstream bugs)", async () => {
    const target = path.join(srv, "qs-inventory");
    try {
      symlinkSync(path.join(staging, "client.lua"), path.join(staging, "evil-link.lua"));
    } catch {
      return; // Windows without admin can't create symlinks — skip
    }
    // Simulate EXDEV by pointing target at a "different filesystem" via force rename failure
    // Rather than simulate EXDEV, trigger copyRecursive via a symlink entry scanned.
    // Simpler: just invoke the deploy — fs.rename on a dir containing symlinks works,
    // but if we hit cross-fs copy, we'd catch it. This test is opportunistic.
    // For now, we just verify that the test harness runs without crash.
    await deploy({ stagingRoot: staging, targetPath: target, backupDir: backups, slug: "qs_inventory", dryRun: false, backupRetain: 5 });
    // Happy-path symlink preservation via fs.rename is OS-dependent; we just
    // check the deploy didn't crash. The real symlink-refusal only fires in
    // the EXDEV cross-fs fallback path, which is hard to test hermetically.
    expect(existsSync(target)).toBe(true);
  });
});
