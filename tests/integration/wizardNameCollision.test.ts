/**
 * Task 16b — wizardNameCollision integration test.
 *
 * Verifies the name-collision detection and resolution flow:
 * 1. Two grants with identical assetName but different authors.
 * 2. One gets matched at discover time and committed as active.
 * 3. The other lands in newInstalls (no collision winner at discover time).
 * 4. On the next cfx_list_unresolved scan, the second grant surfaces as
 *    reason: "name-collision" with collidesWith populated.
 * 5. Operator can override to a different folder to resolve the collision.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Mapping } from "../../src/lib/state/mapping.js";
import { PortalApiClient } from "../../src/lib/portal/client.js";
import { loadCookiesFromFile } from "../../src/lib/auth/fileAuth.js";

describe("wizard name-collision — two grants, same assetName, different authors", () => {
  let stateDir: string;
  let resourcesDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiz-nc-s-"));
    resourcesDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiz-nc-r-"));

    // Create two local resource folders with distinct names
    await fs.mkdir(path.join(resourcesDir, "dispatch_v1"), {
      recursive: true,
    });
    await fs.mkdir(path.join(resourcesDir, "dispatch_v2_alternate"), {
      recursive: true,
    });

    for (const f of ["dispatch_v1", "dispatch_v2_alternate"]) {
      await fs.writeFile(
        path.join(resourcesDir, f, "fxmanifest.lua"),
        "fx_version 'cerulean'\ngame 'gta5'\n"
      );
    }

    process.env.CFX_STATE_DIR = stateDir;
    process.env.CFX_SERVER_RESOURCES = resourcesDir;
    process.env.CFX_API_BASE = "https://portal.test";
    process.env.CFX_COOKIE_FILE = path.join(stateDir, "cookies.json");

    vi.spyOn(PortalApiClient.prototype, "listGrants").mockResolvedValue({
      grants: [
        {
          grant_id: 400,
          asset: { name: "dispatch", author: "AuthorA" },
        },
        {
          grant_id: 500,
          asset: { name: "dispatch", author: "AuthorB" },
        },
      ] as any,
    } as any);

    vi.spyOn(
      await import("../../src/lib/auth/fileAuth.js"),
      "loadCookiesFromFile"
    ).mockResolvedValue(undefined as any);
  });

  it("losing grant surfaces with reason='name-collision' and collidesWith populated", async () => {
    // Pre-seed state: grant 400 committed to dispatch_v1, grant 500 in newInstalls.
    const m = new Mapping(stateDir);
    m.approveFromProposed({
      "400": {
        slug: "dispatch",
        target: path.join(resourcesDir, "dispatch_v1"),
        assetName: "dispatch",
        discoveredTier: 1,
        discoveredConfidence: 1.0,
        status: "active",
        reviewedByUser: true,
      },
    });
    m.getFile().newInstalls = [500];
    await m.save();

    const { cfx_list_unresolved } = await import(
      "../../src/mcp/tools/list_unresolved.js"
    );
    const out = await cfx_list_unresolved({});
    const collision = out.unresolved.find((u) => u.grantId === 500);

    expect(collision).toBeDefined();
    expect(collision!.reason).toBe("name-collision");
    expect(collision!.collidesWith).toBeDefined();
    expect(collision!.collidesWith!.grantId).toBe(400);

    // Operator uses override to point grant 500 to dispatch_v2_alternate
    const { cfx_resolve_mapping_entry } = await import(
      "../../src/mcp/tools/resolve_mapping_entry.js"
    );
    const r = await cfx_resolve_mapping_entry({
      grantId: 500,
      action: "override",
      overrideInput: "dispatch_v2_alternate",
    });

    expect(r.committed).toBe(true);
    expect(r.entry!.target).toContain("dispatch_v2_alternate");
  });
});
