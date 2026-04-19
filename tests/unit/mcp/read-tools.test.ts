import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { cfx_list_grants } from "../../../src/mcp/tools/list_grants.js";
import { cfx_check_updates } from "../../../src/mcp/tools/check_updates.js";
import { State } from "../../../src/lib/state/state.js";

function setEnv(dir: string) {
  process.env.CFX_SERVER_RESOURCES = dir;
  process.env.CFX_STATE_DIR = path.join(dir, "state");
  process.env.CFX_CACHE_DIR = path.join(dir, "cache");
  process.env.CFX_STAGING_DIR = path.join(dir, "staging");
  process.env.CFX_BACKUP_DIR = path.join(dir, "backups");
  process.env.CFX_COOKIE_FILE = path.join(dir, ".cookies.json");
  // Use very long TTL so "recent" poll triggers STALE path reliably.
  process.env.CFX_RATE_LIMIT_TTL_MS = "86400000"; // 24h
}

describe("cfx_list_grants (stale-cache path)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cfx-lg-"));
    setEnv(dir);
    mkdirSync(path.join(dir, "state"), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.CFX_RATE_LIMIT_TTL_MS;
  });

  it("returns stale: true and cached assets when within TTL", async () => {
    // Seed state with a recent lastPolledAt + one asset
    const stateDir = path.join(dir, "state");
    const state = new State(stateDir);
    await state.load();
    state.upsert({
      grantId: 111, assetId: 555, slug: "qs_inventory", assetName: "QS Inventory",
      versionId: 1, packId: 1,
      updatedAt: "2026-02-01T00:00:00Z", sha256: "",
      cachedZipPath: "", deployedPath: "", deployedAt: "", backups: [],
      pristineVersionId: null, pristineCapturedAt: null, pristineHashes: null,
    });
    state.setLastPolledAt("local", new Date().toISOString());
    await state.save();

    const r = await cfx_list_grants({ force: false });
    expect(r.stale).toBe(true);
    expect(r.grants.length).toBe(1);
    expect(r.grants[0]!.assetName).toBe("QS Inventory"); // not the slug!
  });
});

describe("cfx_check_updates (stale-cache path)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cfx-cu-"));
    setEnv(dir);
    mkdirSync(path.join(dir, "state"), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.CFX_RATE_LIMIT_TTL_MS;
  });

  it("returns stale: true with empty updated[] when within TTL", async () => {
    const state = new State(path.join(dir, "state"));
    await state.load();
    state.setLastPolledAt("local", new Date().toISOString());
    await state.save();

    const r = await cfx_check_updates({ force: false });
    expect(r.stale).toBe(true);
    expect(r.updated).toEqual([]);
  });
});
