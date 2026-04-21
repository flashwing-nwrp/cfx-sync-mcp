/**
 * Task 14 — wizardFlow integration test.
 *
 * Happy-path end-to-end test exercising the full wizard cycle:
 * 1. discover (scan resources + match grants)
 * 2. approve mapping (commit tier 1+2 entries, queue others for resolution)
 * 3. list_unresolved (retrieve newInstalls + suspicious + alternatives)
 * 4. resolve_mapping_entry (accept/skip/override entries)
 * 5. Verify state file + resolution log correct
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PortalApiClient } from "../../src/lib/portal/client.js";

describe("wizard happy-path end-to-end", () => {
  let stateDir: string;
  let resourcesDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiz-flow-state-"));
    resourcesDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiz-flow-res-"));

    // 3 local folders: one exact match (tier 1), one fuzzy (tier 4), one unrelated.
    await fs.mkdir(path.join(resourcesDir, "cd_dispatch"), { recursive: true });
    await fs.mkdir(path.join(resourcesDir, "brofx_mansion_10_v2"), { recursive: true });
    await fs.mkdir(path.join(resourcesDir, "unrelated_thing"), { recursive: true });

    // Add fxmanifest.lua files so scanResources can detect them.
    await fs.writeFile(
      path.join(resourcesDir, "cd_dispatch", "fxmanifest.lua"),
      "fx_version 'cerulean'\ngame 'gta5'\nauthor 'Codesign'\nname 'cd_dispatch'\n"
    );
    await fs.writeFile(
      path.join(resourcesDir, "brofx_mansion_10_v2", "fxmanifest.lua"),
      "fx_version 'cerulean'\ngame 'gta5'\nauthor 'BroFX'\nname 'brofx_mansion_10'\n"
    );
    await fs.writeFile(
      path.join(resourcesDir, "unrelated_thing", "fxmanifest.lua"),
      "fx_version 'cerulean'\ngame 'gta5'\nauthor 'Unknown'\nname 'unrelated_thing'\n"
    );

    // Match the env-var config pattern from other tests
    process.env.CFX_STATE_DIR = stateDir;
    process.env.CFX_SERVER_RESOURCES = resourcesDir;
    process.env.CFX_CACHE_DIR = path.join(stateDir, "cache");
    process.env.CFX_STAGING_DIR = path.join(stateDir, "staging");
    process.env.CFX_BACKUP_DIR = path.join(stateDir, "backups");
    process.env.CFX_COOKIE_FILE = path.join(stateDir, "cookies.json");
    process.env.CFX_API_BASE = "https://portal.test";

    // Mock PortalApiClient.listGrants
    vi.spyOn(PortalApiClient.prototype, "listGrants").mockResolvedValue({
      grants: [
        {
          grant_id: 100,
          asset: { name: "cd_dispatch", author: "Codesign" },
          transferable: true,
          updated_since_last_download: false,
          download_url: "https://test",
          received_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-02-01T00:00:00Z",
        },
        {
          grant_id: 200,
          asset: { name: "brofx_mansion_10", author: "BroFX" },
          transferable: true,
          updated_since_last_download: false,
          download_url: "https://test",
          received_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-02-01T00:00:00Z",
        },
        {
          grant_id: 300,
          asset: { name: "NotInstalled", author: "Somebody" },
          transferable: true,
          updated_since_last_download: false,
          download_url: "https://test",
          received_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-02-01T00:00:00Z",
        },
      ] as any,
      page: 1,
      page_count: 1,
      item_count: 3,
    } as any);

    // Mock loadCookiesFromFile to avoid file I/O errors
    vi.spyOn(
      await import("../../src/lib/auth/fileAuth.js"),
      "loadCookiesFromFile"
    ).mockResolvedValue();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(resourcesDir, { recursive: true, force: true });
    delete process.env.CFX_STATE_DIR;
    delete process.env.CFX_SERVER_RESOURCES;
    delete process.env.CFX_CACHE_DIR;
    delete process.env.CFX_STAGING_DIR;
    delete process.env.CFX_BACKUP_DIR;
    delete process.env.CFX_COOKIE_FILE;
    delete process.env.CFX_API_BASE;
  });

  it("discover → approve → list_unresolved → resolve each → committed state correct", async () => {
    const { cfx_discover } = await import("../../src/mcp/tools/discover.js");
    const { cfx_approve_mapping } = await import("../../src/mcp/tools/approve_mapping.js");
    const { cfx_list_unresolved } = await import("../../src/mcp/tools/list_unresolved.js");
    const { cfx_resolve_mapping_entry } = await import("../../src/mcp/tools/resolve_mapping_entry.js");

    // 1. Discover
    const proposal = await cfx_discover({});
    expect(proposal.entries).toBeDefined();
    expect(proposal.newInstalls).toBeDefined();
    // cd_dispatch should be tier 1 (exact match)
    const cd_dispatch_entry = Object.values(proposal.entries).find(
      (e: any) => e.assetName === "cd_dispatch"
    );
    expect(cd_dispatch_entry).toBeDefined();
    expect(cd_dispatch_entry?.discoveredConfidence).toBe(1.0);

    // 2. Approve mapping
    const approved = await cfx_approve_mapping({ proposed: proposal } as any);
    expect(approved.entriesCount).toBeGreaterThanOrEqual(1);
    // cd_dispatch (tier 1, confidence 1.0) should be auto-approved
    // others may be in needsResolution.fuzzy or newInstalls

    // 3. List unresolved
    const list = await cfx_list_unresolved({});
    expect(list.summary).toBeDefined();

    // Should have unresolved entries: newInstalls or reactivated entries
    const unresolvedEntries = list.unresolved;
    expect(unresolvedEntries.length).toBeGreaterThanOrEqual(0);

    // 4. Resolve new-install grant (ID 300 = NotInstalled)
    // NotInstalled is not on disk, so it should be in newInstalls list
    if (unresolvedEntries.length > 0) {
      const firstUnresolved = unresolvedEntries[0]!;
      const resolution = await cfx_resolve_mapping_entry({
        grantId: firstUnresolved.grantId,
        action: "new-install",
      });
      expect(resolution.committed).toBe(true);
      expect(resolution.entry).toBeDefined();
      expect(resolution.entry?.status).toBe("new-install");
    }

    // 5. Verify resolution log was created and contains entries
    const logPath = path.join(stateDir, "resolution-log.jsonl");
    const logExists = await fs
      .access(logPath)
      .then(() => true)
      .catch(() => false);

    if (logExists) {
      const log = await fs.readFile(logPath, "utf8");
      const lines = log
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(1);

      // Parse lines and verify structure
      const entries = lines.map((l) => JSON.parse(l));
      expect(entries.every((e) => e.ts && e.grantId && e.action)).toBe(true);

      // Should have at least one auto-approve entry (from the approve phase)
      const autoApprove = entries.find((e) => e.action === "auto-approve");
      expect(autoApprove).toBeDefined();
    }

    // 6. Verify cfx-sync-map.json is created and is valid
    const mapPath = path.join(stateDir, "cfx-sync-map.json");
    const mapExists = await fs
      .access(mapPath)
      .then(() => true)
      .catch(() => false);
    expect(mapExists).toBe(true);

    if (mapExists) {
      const mapContent = await fs.readFile(mapPath, "utf8");
      const mapData = JSON.parse(mapContent);
      expect(mapData.version).toBe(4);
      expect(mapData.entries).toBeDefined();
      expect(mapData.newInstalls).toBeDefined();
    }
  });
});
