import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("cfx_approve_mapping — narrowed to confidence===1.0", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "approve-v4-"));
    process.env.CFX_STATE_DIR = stateDir;
    process.env.CFX_SERVER_RESOURCES = stateDir;
    process.env.CFX_CACHE_DIR = path.join(stateDir, "cache");
    process.env.CFX_STAGING_DIR = path.join(stateDir, "staging");
    process.env.CFX_BACKUP_DIR = path.join(stateDir, "backups");
    process.env.CFX_COOKIE_FILE = path.join(stateDir, ".cookies.json");
  });

  it("commits only confidence===1.0 entries; surfaces others in needsResolution", async () => {
    const { cfx_approve_mapping } = await import("../../../src/mcp/tools/approve_mapping.js");

    const proposed = {
      version: 1 as const,
      generatedAt: new Date().toISOString(),
      entries: {
        "1": {
          slug: "tier1",
          target: "/tmp/1",
          disabled: false,
          assetName: "T1",
          discoveredTier: 1,
          discoveredConfidence: 1.0,
        },
        "2": {
          slug: "tier4_fuzzy",
          target: "/tmp/2",
          disabled: false,
          assetName: "T4",
          discoveredTier: 4,
          discoveredConfidence: 0.88,
        },
      },
      newInstalls: [777, 888],
      orphaned: [],
      caveats: [],
    };

    const out = await cfx_approve_mapping({ proposed });
    expect(out.entriesCount).toBe(1);          // only tier 1 / confidence===1.0
    expect(out.needsResolution.fuzzy).toBe(1);
    expect(out.needsResolution.newInstalls).toBe(2);
    expect(out.nextStep).toBe("call cfx_list_unresolved");

    const raw = JSON.parse(
      await fs.readFile(path.join(stateDir, "cfx-sync-map.json"), "utf8")
    );
    expect(Object.keys(raw.entries)).toEqual(["1"]);
    expect(raw.entries["1"].reviewedByUser).toBe(true);
    expect(raw.entries["1"].status).toBe("active");
    // The tier-4 fuzzy entry + newInstalls stay in the out-of-band queue for the wizard.
    expect(raw.newInstalls).toEqual(expect.arrayContaining([777, 888]));
  });

  it("returns no nextStep when all entries are confidence===1.0 and no newInstalls", async () => {
    const { cfx_approve_mapping } = await import("../../../src/mcp/tools/approve_mapping.js");

    const proposed = {
      version: 1 as const,
      generatedAt: new Date().toISOString(),
      entries: {
        "5": {
          slug: "clean_asset",
          target: "/tmp/5",
          disabled: false,
          assetName: "CleanAsset",
          discoveredTier: 2,
          discoveredConfidence: 1.0,
        },
      },
      newInstalls: [],
      orphaned: [],
      caveats: [],
    };

    const out = await cfx_approve_mapping({ proposed });
    expect(out.entriesCount).toBe(1);
    expect(out.needsResolution.fuzzy).toBe(0);
    expect(out.needsResolution.newInstalls).toBe(0);
    expect(out.nextStep).toBeUndefined();
  });
});
