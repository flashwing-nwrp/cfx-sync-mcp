/**
 * Task 8 — cfx_list_unresolved query implementation tests.
 *
 * Four core cases:
 *  1. No approved mapping → notice returned, empty buckets.
 *  2. Suspicious bucket: active entries with discoveredTier >= 3 + reviewedByUser=false.
 *  3. Unresolved bucket: newInstalls surfaced with reason "new-install".
 *  4. Name-collision: newInstall shares assetName with an active entry → reason "name-collision".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Mapping } from "../../../src/lib/state/mapping.js";
import { PortalApiClient } from "../../../src/lib/portal/client.js";

describe("cfx_list_unresolved", () => {
  let stateDir: string;
  let resourcesDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "lu-state-"));
    resourcesDir = await fs.mkdtemp(path.join(os.tmpdir(), "lu-res-"));

    // Set up env vars so loadConfig() works without throwing.
    process.env.CFX_STATE_DIR = stateDir;
    process.env.CFX_SERVER_RESOURCES = resourcesDir;
    process.env.CFX_CACHE_DIR = path.join(stateDir, "cache");
    process.env.CFX_STAGING_DIR = path.join(stateDir, "staging");
    process.env.CFX_BACKUP_DIR = path.join(stateDir, "backups");
    process.env.CFX_COOKIE_FILE = path.join(stateDir, ".cookies.json");

    // Default: portal is unreachable (no cookie file) — most tests don't need it.
    vi.spyOn(PortalApiClient.prototype, "listGrants").mockResolvedValue({
      grants: [],
      page: 1,
      page_count: 1,
      item_count: 0,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(resourcesDir, { recursive: true, force: true });
  });

  it("returns notice when mapping file is absent", async () => {
    const { cfx_list_unresolved } = await import("../../../src/mcp/tools/list_unresolved.js");
    const out = await cfx_list_unresolved({});
    expect(out.notice).toMatch(/cfx_discover/);
    expect(out.unresolved).toEqual([]);
    expect(out.suspicious).toEqual([]);
  });

  it("surfaces pre-existing reviewedByUser=false entries in suspicious bucket", async () => {
    const m = new Mapping(stateDir);
    m.approveFromProposed({
      "1": {
        slug: "a",
        target: path.join(resourcesDir, "a"),
        assetName: "A",
        discoveredTier: 3,
        discoveredConfidence: 0.85,
        status: "active",
        reviewedByUser: false,
      },
      "2": {
        slug: "b",
        target: path.join(resourcesDir, "b"),
        assetName: "B",
        discoveredTier: 1,
        discoveredConfidence: 1.0,
        status: "active",
        reviewedByUser: true,
      },
    });
    await m.save();

    const { cfx_list_unresolved } = await import("../../../src/mcp/tools/list_unresolved.js");
    const out = await cfx_list_unresolved({});
    expect(out.suspicious.map((s) => s.grantId)).toEqual([1]);
    expect(out.summary.suspiciousCount).toBe(1);
  });

  it("surfaces newInstalls as unresolved entries with reason 'new-install'", async () => {
    const m = new Mapping(stateDir);
    m.approveFromProposed({});
    const data = m.getFile();
    data.newInstalls = [99];
    await m.save();

    // Seed a fake listGrants response so the tool can resolve assetName/author.
    vi.spyOn(PortalApiClient.prototype, "listGrants").mockResolvedValue({
      grants: [
        {
          grant_id: 99,
          asset: {
            id: 1,
            name: "Uninstalled",
            author: "Somebody",
            state: "active",
            is_disabled: false,
            disabled_reason: null,
            versions: [],
          },
          transferable: false,
          updated_since_last_download: false,
          download_url: "",
          received_at: "",
          updated_at: "",
        },
      ],
      page: 1,
      page_count: 1,
      item_count: 1,
    });

    const { cfx_list_unresolved } = await import("../../../src/mcp/tools/list_unresolved.js");
    const out = await cfx_list_unresolved({});
    expect(out.unresolved).toHaveLength(1);
    expect(out.unresolved[0]!.reason).toBe("new-install");
    expect(out.unresolved[0]!.proposed).toBeNull();
  });

  it("surfaces name-collision when a newInstall shares assetName with an active entry", async () => {
    // Active entry "400" (AuthorA) is already committed; newInstall grant 500
    // (AuthorB) has the same asset name — classic Cfx name-collision case.
    const m = new Mapping(stateDir);
    m.approveFromProposed({
      "400": {
        slug: "dispatch",
        target: path.join(resourcesDir, "dispatch_authorA"),
        assetName: "dispatch",
        discoveredTier: 1,
        discoveredConfidence: 1.0,
        status: "active",
        reviewedByUser: true,
      },
    });
    m.getFile().newInstalls = [500];
    await m.save();

    vi.spyOn(PortalApiClient.prototype, "listGrants").mockResolvedValue({
      grants: [
        {
          grant_id: 400,
          asset: {
            id: 1,
            name: "dispatch",
            author: "AuthorA",
            state: "active",
            is_disabled: false,
            disabled_reason: null,
            versions: [],
          },
          transferable: false,
          updated_since_last_download: false,
          download_url: "",
          received_at: "",
          updated_at: "",
        },
        {
          grant_id: 500,
          asset: {
            id: 2,
            name: "dispatch",
            author: "AuthorB",
            state: "active",
            is_disabled: false,
            disabled_reason: null,
            versions: [],
          },
          transferable: false,
          updated_since_last_download: false,
          download_url: "",
          received_at: "",
          updated_at: "",
        },
      ],
      page: 1,
      page_count: 1,
      item_count: 2,
    });

    const { cfx_list_unresolved } = await import("../../../src/mcp/tools/list_unresolved.js");
    const out = await cfx_list_unresolved({});
    const collision = out.unresolved.find((u) => u.grantId === 500);
    expect(collision).toBeDefined();
    expect(collision!.reason).toBe("name-collision");
    expect(collision!.collidesWith).toMatchObject({ grantId: 400 });
  });

  it("does NOT surface new-install entries as reactivated when matcher only finds tier 3/4", async () => {
    // Seed a new-install entry. The grant is in entries[] with status:"new-install"
    // but NOT in newInstalls[] — this tests the reactivation loop (b), not the
    // new-install loop (a).
    const m = new Mapping(stateDir);
    m.approveFromProposed({
      "992304": {
        slug: "brofx_mansion_10",
        target: "",
        assetName: "brofx_mansion_10",
        discoveredTier: 0,
        discoveredConfidence: 0,
        status: "new-install",
        reviewedByUser: true,
      },
    });
    await m.save();

    // A resource that author-matches (tier 3) but is NOT an exact or slug match.
    // brofx_mansion_10 vs brofx_church: author "brofx" matches, token "brofx" (len 5)
    // is shared → hits tier 3. Not tier 1 (different folder name), not tier 2 (different slug).
    await fs.mkdir(path.join(resourcesDir, "[maps]", "brofx_church"), { recursive: true });
    await fs.writeFile(
      path.join(resourcesDir, "[maps]", "brofx_church", "fxmanifest.lua"),
      "fx_version 'cerulean'\ngame 'gta5'\nauthor 'brofx'\n"
    );

    vi.spyOn(PortalApiClient.prototype, "listGrants").mockResolvedValue({
      grants: [
        {
          grant_id: 992304,
          asset: {
            id: 1,
            name: "brofx_mansion_10",
            author: "brofx",
            state: "active",
            is_disabled: false,
            disabled_reason: null,
            versions: [],
          },
          transferable: false,
          updated_since_last_download: false,
          download_url: "",
          received_at: "",
          updated_at: "",
        },
      ],
      page: 1,
      page_count: 1,
      item_count: 1,
    });

    const { cfx_list_unresolved } = await import("../../../src/mcp/tools/list_unresolved.js");
    const out = await cfx_list_unresolved({});

    // The new-install entry should NOT appear as reactivated — tier 3 match is filtered.
    const reactivated = out.unresolved.filter((u) => u.reason === "reactivated");
    expect(reactivated).toHaveLength(0);
  });

  it("surfaces new-install entry as reactivated when matcher finds a tier-1 exact match", async () => {
    // Seed a new-install entry (in entries[], not newInstalls[]).
    const m = new Mapping(stateDir);
    m.approveFromProposed({
      "300": {
        slug: "pending_asset",
        target: "",
        assetName: "pending_asset",
        discoveredTier: 0,
        discoveredConfidence: 0,
        status: "new-install",
        reviewedByUser: true,
      },
    });
    await m.save();

    // Folder name exactly equals assetName — tier 1 exact match.
    await fs.mkdir(path.join(resourcesDir, "[standalone]", "pending_asset"), { recursive: true });
    await fs.writeFile(
      path.join(resourcesDir, "[standalone]", "pending_asset", "fxmanifest.lua"),
      "fx_version 'cerulean'\ngame 'gta5'\n"
    );

    vi.spyOn(PortalApiClient.prototype, "listGrants").mockResolvedValue({
      grants: [
        {
          grant_id: 300,
          asset: {
            id: 2,
            name: "pending_asset",
            author: "Anybody",
            state: "active",
            is_disabled: false,
            disabled_reason: null,
            versions: [],
          },
          transferable: false,
          updated_since_last_download: false,
          download_url: "",
          received_at: "",
          updated_at: "",
        },
      ],
      page: 1,
      page_count: 1,
      item_count: 1,
    });

    const { cfx_list_unresolved } = await import("../../../src/mcp/tools/list_unresolved.js");
    const out = await cfx_list_unresolved({});
    const r = out.unresolved.find((u) => u.grantId === 300);
    expect(r?.reason).toBe("reactivated");
  });
});
