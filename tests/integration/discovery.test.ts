import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { detectLayout } from "../../src/lib/discovery/detectLayout.js";
import { scanResources } from "../../src/lib/discovery/scanResources.js";
import { matchGrants } from "../../src/lib/discovery/matchGrants.js";

describe("integration: discovery on FLRP-shaped tree", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "cfx-disc-"));
    for (const cat of ["[standalone]", "[qs]", "[vehicles]", "[housing]", "[flrp]"]) {
      mkdirSync(path.join(tmp, cat), { recursive: true });
    }
    mkdirSync(path.join(tmp, "[standalone]", "cd_carhud"), { recursive: true });
    writeFileSync(path.join(tmp, "[standalone]", "cd_carhud", "fxmanifest.lua"), "name 'cd_carhud'\nauthor 'Codesign'");
    writeFileSync(path.join(tmp, "[standalone]", "cd_carhud", "core.fxap"), "encrypted");
    mkdirSync(path.join(tmp, "[qs]", "qs-inventory"), { recursive: true });
    writeFileSync(path.join(tmp, "[qs]", "qs-inventory", "fxmanifest.lua"), "name 'qs-inventory'\nauthor 'Quasar'");
    writeFileSync(path.join(tmp, "[qs]", "qs-inventory", "server.fxap"), "encrypted");
    mkdirSync(path.join(tmp, "[housing]", "qs-housing"), { recursive: true });
    writeFileSync(path.join(tmp, "[housing]", "qs-housing", "fxmanifest.lua"), "name 'qs-housing'\nauthor 'Quasar'");
    writeFileSync(path.join(tmp, "[housing]", "qs-housing", "housing.fxap"), "encrypted");
    mkdirSync(path.join(tmp, "[flrp]", "flrp_banking"), { recursive: true });
    writeFileSync(path.join(tmp, "[flrp]", "flrp_banking", "fxmanifest.lua"), "name 'flrp_banking'\nauthor 'Flashwing'");
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("detects categorized layout + scans all 4 resources + matches Tier 1", () => {
    expect(detectLayout(tmp)).toBe("categorized");
    const resources = scanResources(tmp, "categorized");
    expect(resources.map((r) => r.folderName).sort()).toEqual(
      ["cd_carhud", "flrp_banking", "qs-housing", "qs-inventory"]
    );

    const grants = [
      mkGrant(1, "cd_carhud", "Codesign"),
      mkGrant(2, "qs-inventory", "Quasar"),
      mkGrant(3, "qs-housing", "Quasar"),
    ];
    const result = matchGrants(grants, resources);
    expect(result.matches.length).toBe(3);
    for (const m of result.matches) expect(m.matchTier).toBe(1);
    expect(result.orphaned).toEqual([]);
  });
});

function mkGrant(id: number, name: string, author: string) {
  return {
    grant_id: id, transferable: true, updated_since_last_download: false,
    download_url: "TBA", received_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z",
    asset: { id, name, author, state: "active", is_disabled: false, disabled_reason: null,
      versions: [{ id: 1, packs: [{ id: 1 }] }] },
  };
}
