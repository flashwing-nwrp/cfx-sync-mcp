import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Mapping } from "../../src/lib/state/mapping.js";

describe("downstream consumer filtering (new-install entries must be skipped)", () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "downstream-filter-"));
  });

  it("getActiveEntries() skips new-install and disabled entries", async () => {
    const m = new Mapping(stateDir);
    m.approveFromProposed({
      "1": {
        slug: "a",
        target: "/tmp/a",
        assetName: "A",
        discoveredTier: 1,
        discoveredConfidence: 1.0,
        status: "active",
        reviewedByUser: true
      },
      "2": {
        slug: "b",
        target: "",
        assetName: "B",
        discoveredTier: 1,
        discoveredConfidence: 1.0,
        status: "new-install",
        reviewedByUser: true
      },
      "3": {
        slug: "c",
        target: "/tmp/c",
        assetName: "C",
        discoveredTier: 1,
        discoveredConfidence: 1.0,
        status: "disabled",
        reviewedByUser: true
      },
    });
    const active = m.getActiveEntries();
    expect(Object.keys(active)).toEqual(["1"]);
  });

  it("cfx_deploy_asset rejects new-install entry with helpful error", async () => {
    // Seed mapping with a new-install entry
    const m = new Mapping(stateDir);
    m.approveFromProposed({
      "99": {
        slug: "pending",
        target: "",
        assetName: "PendingAsset",
        discoveredTier: 3,
        discoveredConfidence: 0.85,
        status: "new-install",
        reviewedByUser: true
      },
    });
    await m.save();

    const { cfx_deploy_asset } = await import("../../src/mcp/tools/deploy_asset.js");
    const configMod = await import("../../src/lib/config.js");
    const loadConfigSpy = vi.spyOn(configMod, "loadConfig")
      .mockReturnValue({ stateDir, serverResources: stateDir } as any);

    try {
      await expect(cfx_deploy_asset({ grantId: 99, dryRun: true } as any)).rejects.toThrow(
        /new-install.*not installed locally/i
      );
    } finally {
      loadConfigSpy.mockRestore();
    }
  });
});
