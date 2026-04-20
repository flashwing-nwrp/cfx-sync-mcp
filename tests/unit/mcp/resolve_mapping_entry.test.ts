/**
 * Task 10 — cfx_resolve_mapping_entry basic actions tests.
 *
 * Five core cases:
 *  1. action=accept  → flips reviewedByUser=true, committed=true.
 *  2. action=skip    → committed=false (no-op).
 *  3. action=new-install → commits status='new-install', target='', committed=true.
 *  4. action=pick with out-of-range pickIndex → committed=false, error='pick-index-out-of-range'.
 *  5. action=new-install with unexpected pickIndex → committed=false, error='unexpected-field'.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Mapping } from "../../../src/lib/state/mapping.js";
import { PortalApiClient } from "../../../src/lib/portal/client.js";

describe("cfx_resolve_mapping_entry — basic actions", () => {
  let stateDir: string;
  let resourcesDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "rme-state-"));
    resourcesDir = await fs.mkdtemp(path.join(os.tmpdir(), "rme-res-"));

    // Set up env vars so loadConfig() works without throwing.
    process.env.CFX_STATE_DIR = stateDir;
    process.env.CFX_SERVER_RESOURCES = resourcesDir;
    process.env.CFX_CACHE_DIR = path.join(stateDir, "cache");
    process.env.CFX_STAGING_DIR = path.join(stateDir, "staging");
    process.env.CFX_BACKUP_DIR = path.join(stateDir, "backups");
    process.env.CFX_COOKIE_FILE = path.join(stateDir, ".cookies.json");

    // Default portal stub — returns the FuzzyAsset grant.
    vi.spyOn(PortalApiClient.prototype, "listGrants").mockResolvedValue({
      grants: [{ grant_id: 50, asset: { name: "FuzzyAsset", author: "BroFX" } }] as any,
      page: 1,
      page_count: 1,
      item_count: 1,
    } as any);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(resourcesDir, { recursive: true, force: true });
  });

  /**
   * Seeds a single fuzzy (tier 4, reviewedByUser=false) mapping entry for grant 50.
   * The target directory is created on disk so that accept/pick actions can resolve it.
   */
  async function seedFuzzyEntry(): Promise<void> {
    const m = new Mapping(stateDir);
    const target = path.join(resourcesDir, "brofx_thing");
    await fs.mkdir(target, { recursive: true });
    m.approveFromProposed({
      "50": {
        slug: "fuzzy",
        target,
        assetName: "FuzzyAsset",
        discoveredTier: 4,
        discoveredConfidence: 0.82,
        status: "active",
        reviewedByUser: false,
      },
    });
    await m.save();
  }

  it("action=accept flips reviewedByUser=true without changing target", async () => {
    await seedFuzzyEntry();
    // Dynamic import so each test gets a fresh module evaluation (avoids module-cache cross-test bleed).
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({ grantId: 50, action: "accept" });
    expect(out.committed).toBe(true);
    expect(out.entry).not.toBeNull();
    expect(out.entry!.reviewedByUser).toBe(true);
    // target should be unchanged
    expect(out.entry!.target).toBe(path.join(resourcesDir, "brofx_thing"));
  });

  it("action=skip does not commit", async () => {
    await seedFuzzyEntry();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({ grantId: 50, action: "skip" });
    expect(out.committed).toBe(false);
  });

  it("action=new-install commits status='new-install' with empty target", async () => {
    const m = new Mapping(stateDir);
    m.approveFromProposed({});
    // Seed grant 50 as a newInstall (not yet mapped to a folder).
    m.getFile().newInstalls = [50];
    await m.save();

    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({ grantId: 50, action: "new-install" });
    expect(out.committed).toBe(true);
    expect(out.entry).not.toBeNull();
    expect(out.entry!.status).toBe("new-install");
    expect(out.entry!.target).toBe("");
  });

  it("returns pick-index-out-of-range when pickIndex exceeds alternatives", async () => {
    await seedFuzzyEntry();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({ grantId: 50, action: "pick", pickIndex: 99 });
    expect(out.committed).toBe(false);
    expect(out.error).toBe("pick-index-out-of-range");
  });

  it("returns unexpected-field when pickIndex is passed with action=new-install", async () => {
    const m = new Mapping(stateDir);
    m.approveFromProposed({});
    m.getFile().newInstalls = [50];
    await m.save();

    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({ grantId: 50, action: "new-install", pickIndex: 0 });
    expect(out.committed).toBe(false);
    expect(out.error).toBe("unexpected-field");
  });
});

describe("cfx_resolve_mapping_entry — override", () => {
  // Reuse beforeEach from the basic-actions block.
  let stateDir: string;
  let resourcesDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "rme-state-"));
    resourcesDir = await fs.mkdtemp(path.join(os.tmpdir(), "rme-res-"));

    // Set up env vars so loadConfig() works without throwing.
    process.env.CFX_STATE_DIR = stateDir;
    process.env.CFX_SERVER_RESOURCES = resourcesDir;
    process.env.CFX_CACHE_DIR = path.join(stateDir, "cache");
    process.env.CFX_STAGING_DIR = path.join(stateDir, "staging");
    process.env.CFX_BACKUP_DIR = path.join(stateDir, "backups");
    process.env.CFX_COOKIE_FILE = path.join(stateDir, ".cookies.json");

    // Default portal stub — returns the FuzzyAsset grant.
    vi.spyOn(PortalApiClient.prototype, "listGrants").mockResolvedValue({
      grants: [{ grant_id: 50, asset: { name: "FuzzyAsset", author: "BroFX" } }] as any,
      page: 1,
      page_count: 1,
      item_count: 1,
    } as any);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(resourcesDir, { recursive: true, force: true });
  });

  it("commits with overrideResolved when input has exactly one ≥0.9 match", async () => {
    await fs.mkdir(path.join(resourcesDir, "brofx_mansion_10_v2"), { recursive: true });
    await fs.mkdir(path.join(resourcesDir, "unrelated_one"), { recursive: true });
    await fs.mkdir(path.join(resourcesDir, "unrelated_two"), { recursive: true });
    const m = new Mapping(stateDir);
    m.approveFromProposed({});
    m.getFile().newInstalls = [50];
    await m.save();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 50, action: "override", overrideInput: "brofx_mansion_10_v2",
    });
    expect(out.committed).toBe(true);
    expect(out.overrideResolved).toBeDefined();
    expect(out.entry!.target).toContain("brofx_mansion_10_v2");
  });

  it("returns overrideAmbiguous when input matches 0 folders ≥0.9", async () => {
    await fs.mkdir(path.join(resourcesDir, "aaa"), { recursive: true });
    await fs.mkdir(path.join(resourcesDir, "bbb"), { recursive: true });
    const m = new Mapping(stateDir); m.approveFromProposed({});
    m.getFile().newInstalls = [50]; await m.save();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 50, action: "override", overrideInput: "zzz_nowhere_near",
    });
    expect(out.committed).toBe(false);
    expect(out.overrideAmbiguous).toBeDefined();
    expect(out.overrideAmbiguous!.candidates.length).toBeGreaterThan(0);
  });

  it("returns overrideAmbiguous when input matches 2+ folders ≥0.9", async () => {
    await fs.mkdir(path.join(resourcesDir, "mansion_01"), { recursive: true });
    await fs.mkdir(path.join(resourcesDir, "mansion_02"), { recursive: true });
    await fs.mkdir(path.join(resourcesDir, "mansion_03"), { recursive: true });
    const m = new Mapping(stateDir); m.approveFromProposed({});
    m.getFile().newInstalls = [50]; await m.save();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 50, action: "override", overrideInput: "mansion",
    });
    expect(out.committed).toBe(false);
    expect(out.overrideAmbiguous).toBeDefined();
    expect(out.overrideAmbiguous!.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it("commits with filesystem-canonical casing even when overrideInput is different case", async () => {
    await fs.mkdir(path.join(resourcesDir, "BroFX_Mansion_10"), { recursive: true });
    const m = new Mapping(stateDir); m.approveFromProposed({});
    m.getFile().newInstalls = [50]; await m.save();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 50, action: "override", overrideInput: "brofx_mansion_10",
    });
    expect(out.committed).toBe(true);
    expect(path.basename(out.entry!.target)).toBe("BroFX_Mansion_10");
  });

  it("rejects when target is already consumed by another grant", async () => {
    await fs.mkdir(path.join(resourcesDir, "shared_folder"), { recursive: true });
    const m = new Mapping(stateDir);
    m.approveFromProposed({
      "99": { slug: "owner", target: path.join(resourcesDir, "shared_folder"), assetName: "Owner",
              discoveredTier: 1, discoveredConfidence: 1.0,
              status: "active", reviewedByUser: true },
    });
    m.getFile().newInstalls = [50]; await m.save();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 50, action: "override", overrideInput: "shared_folder",
    });
    expect(out.committed).toBe(false);
    expect(out.error).toBe("target-owned-by-other-grant");
    expect(out.ownedBy).toBe(99);
  });
});

describe("cfx_resolve_mapping_entry — reactivate", () => {
  // Reuse beforeEach from the basic-actions block.
  let stateDir: string;
  let resourcesDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "rme-state-"));
    resourcesDir = await fs.mkdtemp(path.join(os.tmpdir(), "rme-res-"));

    // Set up env vars so loadConfig() works without throwing.
    process.env.CFX_STATE_DIR = stateDir;
    process.env.CFX_SERVER_RESOURCES = resourcesDir;
    process.env.CFX_CACHE_DIR = path.join(stateDir, "cache");
    process.env.CFX_STAGING_DIR = path.join(stateDir, "staging");
    process.env.CFX_BACKUP_DIR = path.join(stateDir, "backups");
    process.env.CFX_COOKIE_FILE = path.join(stateDir, ".cookies.json");

    // Default portal stub — returns the FuzzyAsset grant.
    vi.spyOn(PortalApiClient.prototype, "listGrants").mockResolvedValue({
      grants: [{ grant_id: 50, asset: { name: "FuzzyAsset", author: "BroFX" } }] as any,
      page: 1,
      page_count: 1,
      item_count: 1,
    } as any);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(resourcesDir, { recursive: true, force: true });
  });

  it("flips status 'new-install' → 'active' and clears reviewedByUser", async () => {
    const m = new Mapping(stateDir);
    m.approveFromProposed({
      "50": { slug: "x", target: "", assetName: "FuzzyAsset",
              discoveredTier: 0, discoveredConfidence: 0,
              status: "new-install", reviewedByUser: true },
    });
    await m.save();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({ grantId: 50, action: "reactivate" });
    expect(out.committed).toBe(true);
    expect(out.entry!.status).toBe("active");
    expect(out.entry!.reviewedByUser).toBe(false);
  });

  it("returns reactivate-invalid-state for a non-new-install entry", async () => {
    const m = new Mapping(stateDir);
    m.approveFromProposed({
      "50": { slug: "x", target: path.join(resourcesDir, "x"), assetName: "X",
              discoveredTier: 1, discoveredConfidence: 1.0,
              status: "active", reviewedByUser: true },
    });
    await m.save();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({ grantId: 50, action: "reactivate" });
    expect(out.committed).toBe(false);
    expect(out.error).toBe("reactivate-invalid-state");
  });
});
