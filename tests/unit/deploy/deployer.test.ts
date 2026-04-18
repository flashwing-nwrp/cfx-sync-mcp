import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { deploy } from "../../../src/lib/deploy/deployer.js";
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
  });

  it("backs up existing + swaps new", async () => {
    const target = path.join(srv, "qs-inventory");
    mkdirSync(target);
    writeFileSync(path.join(target, "fxmanifest.lua"), "old manifest");
    const r = await deploy({ stagingRoot: staging, targetPath: target, backupDir: backups, slug: "qs_inventory", dryRun: false, backupRetain: 5 });
    expect(readFileSync(path.join(target, "fxmanifest.lua"), "utf8")).toBe("name 'qs-inventory'");
    expect(r.backupPath).not.toBeNull();
    expect(readFileSync(path.join(r.backupPath!, "fxmanifest.lua"), "utf8")).toBe("old manifest");
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
});
