/**
 * Task 15 — wizardRemap integration test.
 *
 * Verifies the suspicious-bucket → accept → remap lifecycle:
 * 1. Pre-commit a tier-4 entry with reviewedByUser=false (suspicious state).
 * 2. cfx_list_unresolved surfaces it in the suspicious bucket.
 * 3. accept flips reviewedByUser=true without changing target.
 * 4. pick without allowRemapOver is rejected (remap-requires-confirmation guard).
 * 5. pick WITH matching allowRemapOver commits and logs action: "remap".
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Mapping } from "../../src/lib/state/mapping.js";
import { PortalApiClient } from "../../src/lib/portal/client.js";

describe("wizard remap — suspicious bucket + allowRemapOver guard", () => {
  let stateDir: string;
  let resourcesDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiz-remap-s-"));
    resourcesDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiz-remap-r-"));

    // Create local folders with fxmanifest.lua files
    await fs.mkdir(path.join(resourcesDir, "brofx_church"), { recursive: true });
    await fs.mkdir(path.join(resourcesDir, "brofx_mansion_10_v2"), { recursive: true });

    for (const folder of ["brofx_church", "brofx_mansion_10_v2"]) {
      await fs.writeFile(
        path.join(resourcesDir, folder, "fxmanifest.lua"),
        "fx_version 'cerulean'\ngame 'gta5'\n"
      );
    }

    // Set up environment variables
    process.env.CFX_STATE_DIR = stateDir;
    process.env.CFX_SERVER_RESOURCES = resourcesDir;
    process.env.CFX_API_BASE = "https://portal.test";
    process.env.CFX_COOKIE_FILE = path.join(stateDir, "cookies.json");

    // Mock PortalApiClient.listGrants to return grant 200 (brofx_mansion_10)
    vi.spyOn(PortalApiClient.prototype, "listGrants").mockResolvedValue({
      grants: [
        {
          grant_id: 200,
          asset: { name: "brofx_mansion_10", author: "BroFX" },
          transferable: true,
          updated_since_last_download: false,
          download_url: "https://test",
          received_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-02-01T00:00:00Z",
        },
      ] as any,
      page: 1,
      page_count: 1,
      item_count: 1,
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
    delete process.env.CFX_API_BASE;
    delete process.env.CFX_COOKIE_FILE;
  });

  it("suspicious entries surface → accept flips reviewedByUser → pick without allowRemapOver blocks → with allowRemapOver commits", async () => {
    // Step 1: Seed pre-existing tier-4 committed entry with reviewedByUser=false
    const m = new Mapping(stateDir);
    m.approveFromProposed({
      "200": {
        slug: "brofx_mansion_10",
        target: path.join(resourcesDir, "brofx_church"),
        assetName: "brofx_mansion_10",
        discoveredTier: 4,
        discoveredConfidence: 0.82,
        status: "active",
        reviewedByUser: false,
        preservePaths: null,
        preservePathsSource: null,
        ignoreUpstreamUpdates: false,
      },
    });
    await m.save();

    const { cfx_list_unresolved } = await import("../../src/mcp/tools/list_unresolved.js");
    const { cfx_resolve_mapping_entry } = await import("../../src/mcp/tools/resolve_mapping_entry.js");

    // Step 2: Verify entry surfaces in suspicious bucket
    const list1 = await cfx_list_unresolved({});
    expect(list1.suspicious.map((s) => s.grantId)).toEqual([200]);
    expect(list1.suspicious[0]!.currentTarget).toContain("brofx_church");
    expect(list1.suspicious[0]!.tierAtCommit).toBe(4);
    expect(list1.suspicious[0]!.confidenceAtCommit).toBe(0.82);

    // Step 3: Accept: flips reviewedByUser=true, target unchanged
    const acc = await cfx_resolve_mapping_entry({ grantId: 200, action: "accept" });
    expect(acc.committed).toBe(true);
    expect(acc.entry!.reviewedByUser).toBe(true);
    expect(acc.entry!.target).toContain("brofx_church");
    expect(acc.entry!.discoveredTier).toBe(4);

    // Step 4: After acceptance, pick without allowRemapOver must reject with remap-requires-confirmation
    // Try pickIndex 0 (which will be brofx_mansion_10_v2, the top match)
    const bad = await cfx_resolve_mapping_entry({ grantId: 200, action: "pick", pickIndex: 0 });
    expect(bad.committed).toBe(false);
    expect(bad.error).toBe("remap-requires-confirmation");
    expect(bad.expectedBasename).toBe("brofx_church");

    // Step 5: With matching allowRemapOver, remap commits and logs action: "remap"
    // Since the current target is brofx_church, we need to provide that to allowRemapOver
    const good = await cfx_resolve_mapping_entry({
      grantId: 200,
      action: "pick",
      pickIndex: 0,
      allowRemapOver: "brofx_church",
    });
    expect(good.committed).toBe(true);
    expect(good.entry!.status).toBe("active");
    expect(good.entry!.reviewedByUser).toBe(true);
    // The chosen target should be pickIndex 0, which is the best match (brofx_mansion_10_v2)
    expect(good.entry!.target).toContain("brofx_mansion_10_v2");

    // Step 6: Verify resolution log was written and contains remap action
    const logPath = path.join(stateDir, "resolution-log.jsonl");
    const log = await fs.readFile(logPath, "utf8");
    const lines = log
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    // Should have accept entry from step 3
    const acceptEntry = lines.find((e) => e.action === "accept");
    expect(acceptEntry).toBeDefined();
    expect(acceptEntry.grantId).toBe(200);

    // Should have remap entry from step 5
    const remapEntry = lines.find((e) => e.action === "remap");
    expect(remapEntry).toBeDefined();
    expect(remapEntry.grantId).toBe(200);
    expect(remapEntry.chosenBasename).toBe("brofx_mansion_10_v2");

    // Step 7: Verify entry is no longer in suspicious bucket
    const list2 = await cfx_list_unresolved({});
    expect(list2.suspicious.map((s) => s.grantId)).not.toContain(200);
  });
});
