import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { cfx_logout } from "../../../src/mcp/tools/logout.js";
import { cfx_status } from "../../../src/mcp/tools/status.js";

describe("cfx_logout", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cfx-at-"));
    process.env.CFX_SERVER_RESOURCES = dir;
    process.env.CFX_STATE_DIR = path.join(dir, "state");
    process.env.CFX_CACHE_DIR = path.join(dir, "cache");
    process.env.CFX_STAGING_DIR = path.join(dir, "staging");
    process.env.CFX_BACKUP_DIR = path.join(dir, "backups");
    process.env.CFX_COOKIE_FILE = path.join(dir, ".cookies.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("wipes cookie file", async () => {
    writeFileSync(path.join(dir, ".cookies.json"), "[]");
    const r = await cfx_logout();
    expect(r.wiped).toBe(true);
    expect(existsSync(path.join(dir, ".cookies.json"))).toBe(false);
  });
});

describe("cfx_status", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cfx-st-"));
    process.env.CFX_SERVER_RESOURCES = dir;
    process.env.CFX_STATE_DIR = path.join(dir, "state");
    process.env.CFX_CACHE_DIR = path.join(dir, "cache");
    process.env.CFX_STAGING_DIR = path.join(dir, "staging");
    process.env.CFX_BACKUP_DIR = path.join(dir, "backups");
    process.env.CFX_COOKIE_FILE = path.join(dir, ".cookies.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports cookiesPresent=false, mappingApproved=false on fresh state", async () => {
    const r = await cfx_status();
    expect(r.cookiesPresent).toBe(false);
    expect(r.mappingApproved).toBe(false);
    expect(r.deployedCount).toBe(0);
  });
});
