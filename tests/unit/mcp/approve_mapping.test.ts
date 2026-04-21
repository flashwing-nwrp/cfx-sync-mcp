import { describe, it, expect, beforeEach } from "vitest";
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
          status: "active" as const,
          reviewedByUser: true,
          assetName: "T1",
          discoveredTier: 1,
          discoveredConfidence: 1.0,
        },
        "2": {
          slug: "tier4_fuzzy",
          target: "/tmp/2",
          status: "active" as const,
          reviewedByUser: false,
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
    expect(out.entriesCount).toBe(1);          // only tier 1+2 count as auto-approved
    expect(out.needsResolution.fuzzy).toBe(1);
    expect(out.needsResolution.newInstalls).toBe(2);
    expect(out.nextStep).toBe("call cfx_list_unresolved");

    const raw = JSON.parse(
      await fs.readFile(path.join(stateDir, "cfx-sync-map.json"), "utf8")
    );
    // Both tier 1 and tier 4 land in entries; tier 4 is provisional (reviewedByUser: false).
    expect(Object.keys(raw.entries).sort()).toEqual(["1", "2"]);
    expect(raw.entries["1"].reviewedByUser).toBe(true);
    expect(raw.entries["1"].status).toBe("active");
    expect(raw.entries["2"].reviewedByUser).toBe(false);   // provisional — surfaces in suspicious bucket
    expect(raw.entries["2"].status).toBe("active");
    expect(raw.entries["2"].discoveredTier).toBe(4);
    // newInstalls stay in the out-of-band queue for the wizard.
    expect(raw.newInstalls).toEqual(expect.arrayContaining([777, 888]));
  });

  it("logs only tier 1+2 as auto-approve; tier 3+4 entries do NOT appear in resolution log", async () => {
    const { cfx_approve_mapping } = await import("../../../src/mcp/tools/approve_mapping.js");

    const proposed = {
      version: 1 as const,
      generatedAt: new Date().toISOString(),
      entries: {
        "10": { slug: "t1", target: "/tmp/10", status: "active" as const, reviewedByUser: true, assetName: "Auto",
                discoveredTier: 1, discoveredConfidence: 1.0 },
        "20": { slug: "t4", target: "/tmp/20", status: "active" as const, reviewedByUser: false, assetName: "Fuzzy",
                discoveredTier: 4, discoveredConfidence: 0.82 },
      },
      newInstalls: [],
      orphaned: [],
      caveats: [],
    };

    await cfx_approve_mapping({ proposed });
    const logRaw = await fs.readFile(path.join(stateDir, "resolution-log.jsonl"), "utf8");
    const lines = logRaw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const autoApproveGrantIds = lines.filter((l) => l.action === "auto-approve").map((l) => l.grantId);
    expect(autoApproveGrantIds).toEqual([10]);  // only tier 1+2 logs
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
          status: "active" as const,
          reviewedByUser: true,
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
