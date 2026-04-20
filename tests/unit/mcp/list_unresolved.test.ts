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
});
