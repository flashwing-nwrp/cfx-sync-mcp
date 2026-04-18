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
});
