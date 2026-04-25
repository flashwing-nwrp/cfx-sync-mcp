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

  // Test 7 — category format
  it("rejects category with missing brackets", async () => {
    await seedNewInstallQueue();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "maps",
    });
    expect((out as any).error).toBe("category-invalid");
  });

  it("rejects category with traversal segments", async () => {
    await seedNewInstallQueue();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]/..",
    });
    expect((out as any).error).toBe("category-invalid");
  });

  it("rejects absolute category path", async () => {
    await seedNewInstallQueue();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "/etc",
    });
    expect((out as any).error).toBe("category-invalid");
  });

  // Test 8 — category not on disk
  it("rejects category that does not exist on disk", async () => {
    await seedNewInstallQueue();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[nonexistent]",
    });
    expect((out as any).error).toBe("category-not-found");
  });

  // Test 9 — slug regex
  it("rejects slug with path separator", async () => {
    await seedNewInstallQueue();
    await ensureMapsCategory();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]", slug: "a/b",
    });
    expect((out as any).error).toBe("slug-invalid");
  });

  it("rejects slug with leading underscore", async () => {
    await seedNewInstallQueue();
    await ensureMapsCategory();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]", slug: "_bad",
    });
    expect((out as any).error).toBe("slug-invalid");
  });

  it("rejects slug exceeding 60 chars", async () => {
    await seedNewInstallQueue();
    await ensureMapsCategory();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]", slug: "a".repeat(61),
    });
    expect((out as any).error).toBe("slug-invalid");
  });

  // Test 10 — slug derivation failed
  it("rejects when auto-derived slug is empty", async () => {
    await seedNewInstallQueue();
    await ensureMapsCategory();
    // Override the default portal mock — grant whose name slugifies to "".
    vi.spyOn(PortalApiClient.prototype, "listGrants").mockResolvedValue({
      grants: [{ grant_id: 100, asset: { name: "!!!", author: "BroFX" } }] as any,
      page: 1, page_count: 1, item_count: 1,
    } as any);
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]",
    });
    expect((out as any).error).toBe("slug-derivation-failed");
  });

  // Test 1 — case A, auto-derived slug
  it("creates entry with auto-derived slug for grantId in newInstalls", async () => {
    await seedNewInstallQueue();
    await ensureMapsCategory();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]",
    });
    expect(out.committed).toBe(true);
    expect(out.entry).not.toBeNull();
    expect(out.entry!.slug).toBe("brofx_mansion_10");
    expect(out.entry!.target).toBe(path.join(resourcesDir, "[maps]", "brofx_mansion_10"));
    expect(out.entry!.status).toBe("active");
    expect(out.entry!.reviewedByUser).toBe(true);
    expect(out.entry!.discoveredConfidence).toBe(1);

    // newInstalls drained
    const m = new Mapping(stateDir);
    await m.load();
    expect(m.getFile().newInstalls).not.toContain(100);

    // resolution log row exists
    const log = await fs.readFile(path.join(stateDir, "resolution-log.jsonl"), "utf8");
    const rows = log.trim().split("\n").map((l) => JSON.parse(l));
    const installRow = rows.find((r: any) => r.action === "install-to");
    expect(installRow).toBeDefined();
    expect(installRow.grantId).toBe(100);
    expect(installRow.category).toBe("[maps]");
    expect(installRow.chosenBasename).toBe("brofx_mansion_10");
  });

  // Test 2 — case A, operator slug override
  it("uses operator-supplied slug when provided", async () => {
    await seedNewInstallQueue();
    await ensureMapsCategory();
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]", slug: "custom_name",
    });
    expect(out.committed).toBe(true);
    expect(out.entry!.slug).toBe("custom_name");
    expect(out.entry!.target).toBe(path.join(resourcesDir, "[maps]", "custom_name"));
  });

  // Test 3 — case A, nested category
  it("supports nested bracket categories", async () => {
    await seedNewInstallQueue();
    await fs.mkdir(path.join(resourcesDir, "[maps]", "[apollo]"), { recursive: true });
    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]/[apollo]",
    });
    expect(out.committed).toBe(true);
    expect(out.entry!.target).toBe(path.join(resourcesDir, "[maps]", "[apollo]", "brofx_mansion_10"));
  });

  // Test 4 — case B, entry exists with status:new-install
  it("upgrades existing new-install entry to active and preserves ignoreUpstreamUpdates", async () => {
    const m = new Mapping(stateDir);
    m.approveFromProposed({});
    m.setEntry(100, {
      slug: "previously_set",
      target: "",
      assetName: "BroFX Mansion 10",
      discoveredTier: 0,
      discoveredConfidence: 0,
      status: "new-install",
      reviewedByUser: true,
      ignoreUpstreamUpdates: true,
      ignoreUpstreamUpdatesReason: "preexisting",
      ignoreUpstreamUpdatesSetAt: "2026-04-01T00:00:00Z",
    });
    await m.save();
    await ensureMapsCategory();

    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]",
    });
    expect(out.committed).toBe(true);
    expect(out.entry!.status).toBe("active");
    expect(out.entry!.target).toBe(path.join(resourcesDir, "[maps]", "brofx_mansion_10"));
    // ignoreUpstreamUpdates fields preserved
    expect(out.entry!.ignoreUpstreamUpdates).toBe(true);
    expect(out.entry!.ignoreUpstreamUpdatesReason).toBe("preexisting");
    expect(out.entry!.ignoreUpstreamUpdatesSetAt).toBe("2026-04-01T00:00:00Z");
  });

  // Test 5 — reject when entry is already active
  it("rejects install-to when entry status is 'active'", async () => {
    const m = new Mapping(stateDir);
    const existingTarget = path.join(resourcesDir, "[maps]", "already_here");
    await fs.mkdir(existingTarget, { recursive: true });
    m.approveFromProposed({
      "100": {
        slug: "already_here",
        target: existingTarget,
        assetName: "BroFX Mansion 10",
        discoveredTier: 1,
        discoveredConfidence: 1,
        status: "active",
        reviewedByUser: true,
      },
    });
    await m.save();
    await ensureMapsCategory();

    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]",
    });
    expect(out.committed).toBe(false);
    expect((out as any).error).toBe("install-to-requires-new-install");
  });

  // Test 6 — reject when no entry and grantId not in newInstalls
  it("rejects install-to when grantId is neither mapped nor in newInstalls", async () => {
    const m = new Mapping(stateDir);
    m.approveFromProposed({});
    // No newInstalls, no entries — but the portal stub still returns grant 100.
    await m.save();
    await ensureMapsCategory();

    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]",
    });
    expect(out.committed).toBe(false);
    expect((out as any).error).toBe("grantId-not-in-mapping");
  });

  // Test 11 — reject when target is already owned by another active grant
  it("rejects install-to when computed target is owned by another active grant", async () => {
    const otherTarget = path.join(resourcesDir, "[maps]", "brofx_mansion_10");
    await fs.mkdir(otherTarget, { recursive: true });

    const m = new Mapping(stateDir);
    m.approveFromProposed({
      // grant 999 already owns the target install-to would compute for grant 100
      "999": {
        slug: "brofx_mansion_10",
        target: otherTarget,
        assetName: "Some Other Asset",
        discoveredTier: 1,
        discoveredConfidence: 1,
        status: "active",
        reviewedByUser: true,
      },
    });
    m.getFile().newInstalls = [100];
    await m.save();

    const { cfx_resolve_mapping_entry } = await import("../../../src/mcp/tools/resolve_mapping_entry.js");
    const out = await cfx_resolve_mapping_entry({
      grantId: 100, action: "install-to", category: "[maps]",
    });
    expect(out.committed).toBe(false);
    expect((out as any).error).toBe("target-owned-by-other-grant");
    expect((out as any).ownedBy).toBe(999);
  });
});
