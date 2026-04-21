import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { cfx_approve_mapping } from "../../../src/mcp/tools/approve_mapping.js";

describe("cfx_approve_mapping", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cfx-am-"));
    mkdirSync(path.join(dir, "state"), { recursive: true });
    process.env.CFX_SERVER_RESOURCES = dir;
    process.env.CFX_STATE_DIR = path.join(dir, "state");
    process.env.CFX_CACHE_DIR = path.join(dir, "cache");
    process.env.CFX_STAGING_DIR = path.join(dir, "staging");
    process.env.CFX_BACKUP_DIR = path.join(dir, "backups");
    process.env.CFX_COOKIE_FILE = path.join(dir, ".cookies.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes cfx-sync-map.json with proposed entries", async () => {
    const result = await cfx_approve_mapping({
      proposed: {
        version: 1,
        generatedAt: "2026-04-17T10:30:00.000Z",
        entries: {
          "12345": {
            slug: "qs_inventory",
            target: "/srv/[qs]/qs-inventory",
            status: "active",
            reviewedByUser: true,
            assetName: "QS Inventory",
            discoveredTier: 1,
            discoveredConfidence: 1.0,
          },
        },
        newInstalls: [],
        orphaned: [],
        caveats: [],
      },
    });

    expect(result.entriesCount).toBe(1);
    expect(
      existsSync(path.join(dir, "state", "cfx-sync-map.json"))
    ).toBe(true);

    const onDisk = JSON.parse(
      readFileSync(path.join(dir, "state", "cfx-sync-map.json"), "utf8")
    );
    expect(onDisk.entries["12345"].slug).toBe("qs_inventory");
  });
});
