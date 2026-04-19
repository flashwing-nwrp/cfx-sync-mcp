import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { deploy } from "../../src/lib/deploy/deployer.js";
import { rollback } from "../../src/lib/deploy/rollback.js";

describe("integration: deploy → rollback → redeploy", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), "cfx-rbint-")); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("round-trips through two deploys and one rollback", async () => {
    const srv = path.join(tmp, "srv", "[qs]");
    const target = path.join(srv, "qs-inventory");
    const backups = path.join(tmp, "backups");
    mkdirSync(srv, { recursive: true });

    // Deploy v1
    const s1 = path.join(tmp, "stage1", "pkg");
    mkdirSync(s1, { recursive: true });
    writeFileSync(path.join(s1, "fxmanifest.lua"), "v1");
    await deploy({ stagingRoot: s1, targetPath: target, backupDir: backups, slug: "qs_inventory", dryRun: false, backupRetain: 5 });
    expect(readFileSync(path.join(target, "fxmanifest.lua"), "utf8")).toBe("v1");

    // Deploy v2 (backs up v1)
    const s2 = path.join(tmp, "stage2", "pkg");
    mkdirSync(s2, { recursive: true });
    writeFileSync(path.join(s2, "fxmanifest.lua"), "v2");
    await deploy({ stagingRoot: s2, targetPath: target, backupDir: backups, slug: "qs_inventory", dryRun: false, backupRetain: 5 });
    expect(readFileSync(path.join(target, "fxmanifest.lua"), "utf8")).toBe("v2");

    // Rollback to v1
    await rollback({ targetPath: target, backupDir: backups, slug: "qs_inventory" });
    expect(readFileSync(path.join(target, "fxmanifest.lua"), "utf8")).toBe("v1");

    // Deploy v3 (backs up post-rollback state)
    const s3 = path.join(tmp, "stage3", "pkg");
    mkdirSync(s3, { recursive: true });
    writeFileSync(path.join(s3, "fxmanifest.lua"), "v3");
    await deploy({ stagingRoot: s3, targetPath: target, backupDir: backups, slug: "qs_inventory", dryRun: false, backupRetain: 5 });
    expect(readFileSync(path.join(target, "fxmanifest.lua"), "utf8")).toBe("v3");
  });

  it("deploy-deploy-rollback cycle tracks pristineVersionId to backup state", async () => {
    const srv = path.join(tmp, "srv", "[qs]");
    const target = path.join(srv, "qs-inventory");
    const backups = path.join(tmp, "backups");
    const pristineDir = path.join(tmp, "pristine");
    const pristineHistoryDir = path.join(tmp, "pristine-history");
    mkdirSync(srv, { recursive: true });

    // --- Deploy v1 (first deploy — no prior pristine). Also seed the
    // pristine AFTER deploy, as rotatePristine would in production.
    const s1 = path.join(tmp, "stage1", "pkg");
    mkdirSync(s1, { recursive: true });
    writeFileSync(path.join(s1, "fxmanifest.lua"), "v1");
    const r1 = await deploy({
      stagingRoot: s1, targetPath: target, backupDir: backups,
      slug: "qs_inventory", dryRun: false, backupRetain: 5,
      pristine: {
        grantId: 7, currentPristineVersionId: null,
        pristineDir, pristineHistoryDir,
        currentPristineHashes: null, currentPristineCapturedAt: null,
      },
    });
    expect(r1.pristineSnapshotPath).toBeNull();
    // Simulate rotatePristine: pristine now == v1.
    mkdirSync(path.join(pristineDir, "7"), { recursive: true });
    writeFileSync(path.join(pristineDir, "7", "fxmanifest.lua"), "v1");
    const v1Hashes = { "fxmanifest.lua": "h-v1" };

    // --- Deploy v2. Backup carries pristine v1 snapshot into history.
    const s2 = path.join(tmp, "stage2", "pkg");
    mkdirSync(s2, { recursive: true });
    writeFileSync(path.join(s2, "fxmanifest.lua"), "v2");
    const r2 = await deploy({
      stagingRoot: s2, targetPath: target, backupDir: backups,
      slug: "qs_inventory", dryRun: false, backupRetain: 5,
      pristine: {
        grantId: 7, currentPristineVersionId: 1,
        pristineDir, pristineHistoryDir,
        currentPristineHashes: v1Hashes,
        currentPristineCapturedAt: "2026-04-01T00:00:00.000Z",
      },
    });
    expect(r2.pristineSnapshotPath).toBe(path.join(pristineHistoryDir, "7", "1"));
    // Simulate rotatePristine bumping to v2.
    writeFileSync(path.join(pristineDir, "7", "fxmanifest.lua"), "v2");

    // --- Rollback. Should restore live=v1 AND pristine=v1.
    const rb = await rollback({
      targetPath: target, backupDir: backups, slug: "qs_inventory",
      grantId: 7, pristineDir,
    });
    expect(readFileSync(path.join(target, "fxmanifest.lua"), "utf8")).toBe("v1");
    expect(readFileSync(path.join(pristineDir, "7", "fxmanifest.lua"), "utf8")).toBe("v1");
    expect(rb.restoredPristine?.pristineVersionId).toBe(1);
    expect(rb.restoredPristine?.pristineHashes).toEqual(v1Hashes);

    // --- Third deploy. Now both live and pristine are v1, so backing up
    // live-v1 alongside a snapshot of pristine-v1 should succeed without the
    // "user-modified forever" false positive — manifest records v1 as the
    // pristine that was current at backup time (matching live).
    const s3 = path.join(tmp, "stage3", "pkg");
    mkdirSync(s3, { recursive: true });
    writeFileSync(path.join(s3, "fxmanifest.lua"), "v3");
    const r3 = await deploy({
      stagingRoot: s3, targetPath: target, backupDir: backups,
      slug: "qs_inventory", dryRun: false, backupRetain: 5,
      pristine: {
        grantId: 7, currentPristineVersionId: 1,
        pristineDir, pristineHistoryDir,
        currentPristineHashes: v1Hashes,
        currentPristineCapturedAt: "2026-04-01T00:00:00.000Z",
      },
    });
    // Third deploy's snapshot lives at history/7/1 (same version as current
    // pristine). Confirm deploy didn't blow up on the pre-existing path.
    expect(r3.pristineSnapshotPath).toBe(path.join(pristineHistoryDir, "7", "1"));
    expect(existsSync(r3.pristineSnapshotPath!)).toBe(true);
    expect(readFileSync(path.join(target, "fxmanifest.lua"), "utf8")).toBe("v3");
  });
});
