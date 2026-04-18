import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import * as JSZipModule from "jszip";
const JSZip: any = (JSZipModule as any).default ?? JSZipModule;
import { cfx_list_grants } from "../../src/mcp/tools/list_grants.js";
import { cfx_download_asset } from "../../src/mcp/tools/download_asset.js";
import { cfx_deploy_asset } from "../../src/mcp/tools/deploy_asset.js";
import { cfx_approve_mapping } from "../../src/mcp/tools/approve_mapping.js";

describe("integration: full sync pipeline", () => {
  let tmp: string;
  let saved: any;
  let mock: MockAgent;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "cfx-int-"));
    mkdirSync(path.join(tmp, "state"), { recursive: true });
    mkdirSync(path.join(tmp, "cache"), { recursive: true });
    mkdirSync(path.join(tmp, "staging"), { recursive: true });
    mkdirSync(path.join(tmp, "srv", "[qs]"), { recursive: true });

    process.env.CFX_SERVER_RESOURCES = path.join(tmp, "srv");
    process.env.CFX_STATE_DIR = path.join(tmp, "state");
    process.env.CFX_CACHE_DIR = path.join(tmp, "cache");
    process.env.CFX_STAGING_DIR = path.join(tmp, "staging");
    process.env.CFX_BACKUP_DIR = path.join(tmp, "backups");
    process.env.CFX_COOKIE_FILE = path.join(tmp, ".cookies.json");
    process.env.CFX_API_BASE = "https://portal-api.cfx.re";

    // Valid cookie file
    writeFileSync(
      path.join(tmp, ".cookies.json"),
      JSON.stringify([
        {
          name: "session", value: "abc", domain: ".cfx.re",
          path: "/", expires: Math.floor(Date.now() / 1000) + 3600,
          httpOnly: true, secure: true, sameSite: "Lax",
        },
      ])
    );

    saved = getGlobalDispatcher();
    mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);

    const pool = mock.get("https://portal-api.cfx.re");
    pool.intercept({ path: /\/v1\/me\/asset-grants/, method: "GET" }).reply(200, {
      grants: [
        {
          grant_id: 1, transferable: true, updated_since_last_download: false,
          download_url: "TBA", received_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z",
          asset: {
            id: 555, author: "Quasar", name: "qs-inventory", state: "active",
            is_disabled: false, disabled_reason: null,
            versions: [{ id: 9001, packs: [{ id: 700 }] }],
          },
        },
      ],
      page: 1, page_count: 1, item_count: 1,
    }).persist();  // persist so multiple fetches work

    const zip = await new JSZip()
      .file("qs-inventory/fxmanifest.lua", "name 'qs-inventory'")
      .file("qs-inventory/server.lua", "print('qs-inventory')")
      .generateAsync({ type: "nodebuffer" });
    pool
      .intercept({ path: "/v1/asset-grants/1/versions/9001/packs/700/download", method: "GET" })
      .reply(200, zip, { headers: { "content-type": "application/zip" } });
  });

  afterEach(() => {
    setGlobalDispatcher(saved);
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.CFX_API_BASE;
  });

  it("lists → approves mapping → downloads → deploys", async () => {
    // 1. list grants (fresh)
    const list = await cfx_list_grants({ force: true });
    expect(list.grants).toHaveLength(1);
    expect(list.grants[0]!.assetName).toBe("qs-inventory");

    // 2. simulate a discover → approve
    await cfx_approve_mapping({
      proposed: {
        version: 1,
        generatedAt: new Date().toISOString(),
        entries: {
          "1": {
            slug: "qs_inventory",
            target: path.join(tmp, "srv", "[qs]", "qs-inventory"),
            disabled: false,
            assetName: "qs-inventory",
            discoveredTier: 1,
            discoveredConfidence: 1.0,
          },
        },
        newInstalls: [], orphaned: [], caveats: [],
      },
    });

    // 3. download
    const dl = await cfx_download_asset({ grantId: 1 });
    expect(dl.sha256).toHaveLength(64);
    expect(existsSync(dl.cachedZipPath)).toBe(true);

    // 4. deploy (dryRun first)
    const preview = await cfx_deploy_asset({ grantId: 1, dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(existsSync(path.join(tmp, "srv", "[qs]", "qs-inventory"))).toBe(false);

    // 5. deploy for real
    const deployed = await cfx_deploy_asset({ grantId: 1, dryRun: false });
    expect(deployed.dryRun).toBe(false);
    expect(existsSync(path.join(tmp, "srv", "[qs]", "qs-inventory", "fxmanifest.lua"))).toBe(true);
    // slug from mapping entry drives the restart command
    expect(deployed.suggestedRestartCommand).toBe("restart qs_inventory");
  });
});
