import { describe, it, expect } from "vitest";
import { TOOLS, toolNames } from "../../../src/mcp/tools/index.js";
import { dispatch } from "../../../src/mcp/dispatch.js";

describe("MCP tool registry", () => {
  it("exports exactly 16 tools", () => {
    expect(toolNames().length).toBe(16);
  });

  it("contains all expected tools", () => {
    expect(toolNames().sort()).toEqual(
      [
        "cfx_approve_mapping", "cfx_check_updates", "cfx_deploy_asset",
        "cfx_discover", "cfx_download_asset", "cfx_list_grants",
        "cfx_list_unresolved", "cfx_login", "cfx_logout", "cfx_reset_pristine",
        "cfx_rollback", "cfx_scan_configs", "cfx_scan_updates", "cfx_set_fork_mode",
        "cfx_status", "cfx_sync_all",
      ]
    );
  });

  it("contains no mutation-oriented tool names", () => {
    const forbidden = /transfer|gift|revoke|share|purchase|subscribe|upload|publish/i;
    for (const name of toolNames()) {
      expect(forbidden.test(name), `Tool "${name}" looks like a mutation — forbidden`).toBe(false);
    }
  });

  it("every tool has an input + output zod schema", () => {
    for (const t of TOOLS) {
      expect(t.inputSchema).toBeDefined();
      expect(t.outputSchema).toBeDefined();
    }
  });

  it("dispatch handler exists for every registered tool", async () => {
    for (const name of toolNames()) {
      await expect(dispatch(name, {})).rejects.not.toThrow(
        new Error(`Unknown tool "${name}"`)
      );
    }
  });
});
