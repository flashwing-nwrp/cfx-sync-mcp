import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { rollback } from "../../../src/lib/deploy/rollback.js";
import { NotFoundError } from "../../../src/lib/errors.js";

describe("rollback", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(path.join(tmpdir(), "cfx-rb-")); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("restores the most recent backup", async () => {
    const target = path.join(tmp, "srv", "[qs]", "qs-inventory");
    const backups = path.join(tmp, "backups", "qs_inventory");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "fxmanifest.lua"), "current");
    const bk = path.join(backups, "2026-02-01T00-00-00-000Z");
    mkdirSync(bk, { recursive: true });
    writeFileSync(path.join(bk, "fxmanifest.lua"), "old");
    const r = await rollback({ targetPath: target, backupDir: path.join(tmp, "backups"), slug: "qs_inventory" });
    expect(readFileSync(path.join(target, "fxmanifest.lua"), "utf8")).toBe("old");
    expect(existsSync(r.newRollingBackup)).toBe(true);
  });

  it("throws NotFound when no backups exist", async () => {
    await expect(
      rollback({ targetPath: "/x", backupDir: path.join(tmp, "backups"), slug: "nothing" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
