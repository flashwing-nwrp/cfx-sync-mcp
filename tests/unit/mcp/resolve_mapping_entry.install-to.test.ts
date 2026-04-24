/**
 * cfx_resolve_mapping_entry — install-to action tests.
 *
 * Covers the 4-case decision tree (entry-create / entry-upgrade / two reject
 * cases), category + slug validation, ownership conflict, and cross-field
 * field-matrix enforcement. See spec at
 * docs/superpowers/specs/2026-04-24-install-to-action-design.md.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Mapping } from "../../../src/lib/state/mapping.js";
import { PortalApiClient } from "../../../src/lib/portal/client.js";

describe("cfx_resolve_mapping_entry — install-to action", () => {
  let stateDir: string;
  let resourcesDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "rme-it-state-"));
    resourcesDir = await fs.mkdtemp(path.join(os.tmpdir(), "rme-it-res-"));

    process.env.CFX_STATE_DIR = stateDir;
    process.env.CFX_SERVER_RESOURCES = resourcesDir;
    process.env.CFX_CACHE_DIR = path.join(stateDir, "cache");
    process.env.CFX_STAGING_DIR = path.join(stateDir, "staging");
    process.env.CFX_BACKUP_DIR = path.join(stateDir, "backups");
    process.env.CFX_COOKIE_FILE = path.join(stateDir, ".cookies.json");
    await fs.writeFile(process.env.CFX_COOKIE_FILE, "{}");

    // Default portal stub — grant 100 is "BroFX Mansion 10" by BroFX.
    vi.spyOn(PortalApiClient.prototype, "listGrants").mockResolvedValue({
      grants: [{ grant_id: 100, asset: { name: "BroFX Mansion 10", author: "BroFX" } }] as any,
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

  /** Seed an empty mapping with grantId 100 in newInstalls (no MappingEntry row). */
  async function seedNewInstallQueue(): Promise<void> {
    const m = new Mapping(stateDir);
    m.approveFromProposed({});
    m.getFile().newInstalls = [100];
    await m.save();
  }

  /** Create the [maps] category dir on disk so category-not-found doesn't trigger. */
  async function ensureMapsCategory(): Promise<void> {
    await fs.mkdir(path.join(resourcesDir, "[maps]"), { recursive: true });
  }

  // Test 12 — fields on wrong action
  it("rejects category on non-install-to action", async () => {
    await seedNewInstallQueue();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100,
      action: "skip",
      category: "[maps]",
    } as any);
    expect(out.committed).toBe(false);
    expect((out as any).error).toBe("unexpected-field");
  });

  it("rejects slug on non-install-to action", async () => {
    await seedNewInstallQueue();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100,
      action: "accept",
      slug: "x",
    } as any);
    expect(out.committed).toBe(false);
    expect((out as any).error).toBe("unexpected-field");
  });

  it("rejects pickIndex on install-to action", async () => {
    await seedNewInstallQueue();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100,
      action: "install-to",
      category: "[maps]",
      pickIndex: 0,
    } as any);
    expect(out.committed).toBe(false);
    expect((out as any).error).toBe("unexpected-field");
  });
});
