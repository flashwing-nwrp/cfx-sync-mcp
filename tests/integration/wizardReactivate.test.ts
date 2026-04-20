/**
 * Task 16a — wizardReactivate integration test.
 *
 * Verifies the new-install → reactivated lifecycle:
 * 1. Pre-approve a new-install entry (resource owned but not installed yet).
 * 2. cfx_list_unresolved initially finds no match (no resource on disk yet).
 * 3. Operator installs the resource on disk.
 * 4. cfx_list_unresolved runs again and surfaces the entry as reason: "reactivated"
 *    with a proposed target.
 * 5. accept action commits the reactivated entry.
 * 6. Verify that reactivate action on non-new-install entries is rejected.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Mapping } from "../../src/lib/state/mapping.js";
import { PortalApiClient } from "../../src/lib/portal/client.js";
import { loadCookiesFromFile } from "../../src/lib/auth/fileAuth.js";

describe("wizard reactivate — new-install → installed later", () => {
  let stateDir: string;
  let resourcesDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiz-rea-s-"));
    resourcesDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiz-rea-r-"));

    process.env.CFX_STATE_DIR = stateDir;
    process.env.CFX_SERVER_RESOURCES = resourcesDir;
    process.env.CFX_API_BASE = "https://portal.test";
    process.env.CFX_COOKIE_FILE = path.join(stateDir, "cookies.json");

    vi.spyOn(PortalApiClient.prototype, "listGrants").mockResolvedValue({
      grants: [
        {
          grant_id: 300,
          asset: { name: "brofx_pendingasset", author: "BroFX" },
        },
      ] as any,
    } as any);

    vi.spyOn(
      await import("../../src/lib/auth/fileAuth.js"),
      "loadCookiesFromFile"
    ).mockResolvedValue(undefined as any);
  });

  it("entry absent → install → reactivated bucket → pick selects proposed target", async () => {
    // Create a dummy resource first so detectLayout can work
    await fs.mkdir(
      path.join(resourcesDir, "dummy_resource"),
      { recursive: true }
    );
    await fs.writeFile(
      path.join(resourcesDir, "dummy_resource", "fxmanifest.lua"),
      "fx_version 'cerulean'\ngame 'gta5'\n"
    );

    // Seed: grant 300 is status:"new-install" (operator owns it, not installed yet).
    // Start with reviewedByUser: false (as it would be from a fresh new-install creation)
    const m = new Mapping(stateDir);
    m.approveFromProposed({
      "300": {
        slug: "brofx_pendingasset",
        target: "",
        assetName: "brofx_pendingasset",
        discoveredTier: 0,
        discoveredConfidence: 0,
        status: "new-install",
        reviewedByUser: false,
      },
    });
    await m.save();

    const { cfx_list_unresolved } = await import(
      "../../src/mcp/tools/list_unresolved.js"
    );
    const list1 = await cfx_list_unresolved({});
    // No folder exists on disk yet; matcher finds nothing; entry stays new-install.
    expect(list1.unresolved.some((u) => u.grantId === 300)).toBe(false);

    // Now operator installs the resource under a matcher-friendly name.
    await fs.mkdir(
      path.join(resourcesDir, "brofx_pendingasset"),
      { recursive: true }
    );
    await fs.writeFile(
      path.join(resourcesDir, "brofx_pendingasset", "fxmanifest.lua"),
      "fx_version 'cerulean'\ngame 'gta5'\n"
    );

    const list2 = await cfx_list_unresolved({});
    const reactivated = list2.unresolved.find((u) => u.grantId === 300);
    expect(reactivated).toBeDefined();
    expect(reactivated!.reason).toBe("reactivated");
    expect(reactivated!.proposed).not.toBeNull();

    const { cfx_resolve_mapping_entry } = await import(
      "../../src/mcp/tools/resolve_mapping_entry.js"
    );
    // Use pick action with pickIndex 0 to select the proposed match
    const r = await cfx_resolve_mapping_entry({ grantId: 300, action: "pick", pickIndex: 0 });
    expect(r.committed).toBe(true);
    expect(r.entry!.status).toBe("active");
    expect(r.entry!.target).toContain("brofx_pendingasset");
  });

  it("reactivate action on non-new-install entry → reactivate-invalid-state", async () => {
    // Create a resource folder first
    await fs.mkdir(path.join(resourcesDir, "x"), { recursive: true });

    const m = new Mapping(stateDir);
    m.approveFromProposed({
      "300": {
        slug: "x",
        target: path.join(resourcesDir, "x"),
        assetName: "X",
        discoveredTier: 1,
        discoveredConfidence: 1.0,
        status: "active",
        reviewedByUser: true,
      },
    });
    await m.save();

    const { cfx_resolve_mapping_entry } = await import(
      "../../src/mcp/tools/resolve_mapping_entry.js"
    );
    const out = await cfx_resolve_mapping_entry({
      grantId: 300,
      action: "reactivate",
    });
    expect(out.committed).toBe(false);
    expect(out.error).toBe("reactivate-invalid-state");
  });
});
