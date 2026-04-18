import { describe, it, expect } from "vitest";
import { matchGrants } from "../../../src/lib/discovery/matchGrants.js";
import type { ResourceMeta } from "../../../src/lib/discovery/scanResources.js";
import type { Grant } from "../../../src/lib/portal/types.js";

const mkGrant = (id: number, name: string, author = "unknown"): Grant => ({
  grant_id: id,
  transferable: true,
  updated_since_last_download: false,
  download_url: "TBA",
  received_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-02-01T00:00:00Z",
  asset: { id, name, author, state: "active", is_disabled: false, disabled_reason: null, versions: [{ id: 1, packs: [{ id: 1 }] }] },
});

const mkRes = (folder: string, name: string | null, author: string | null, hasFxap = true): ResourceMeta => ({
  path: `/srv/${folder}`, folderName: folder, fxmanifestName: name, author, hasFxap,
});

describe("matchGrants", () => {
  it("Tier 1: exact folder-name match", () => {
    const g = [mkGrant(1, "qs-inventory")];
    const r = [mkRes("qs-inventory", "QS Inventory", "Quasar")];
    const result = matchGrants(g, r);
    expect(result.matches.length).toBe(1);
    expect(result.matches[0]!.matchTier).toBe(1);
    expect(result.matches[0]!.confidence).toBe(1.0);
  });

  it("Tier 2: slugified exact match of asset.name", () => {
    const g = [mkGrant(2, "CD Carhud")];
    const r = [mkRes("cd_carhud", "cd_carhud", "Codesign")];
    const result = matchGrants(g, r);
    expect(result.matches[0]!.matchTier).toBe(2);
  });

  it("Tier 3: author + name-token overlap", () => {
    const g = [mkGrant(3, "QS Housing", "Quasar")];
    const r = [mkRes("qs_housing", "qs-housing", "Quasar")];
    const result = matchGrants(g, r);
    expect(result.matches[0]!.matchTier).toBeLessThanOrEqual(3);
  });

  it("Tier 4: Levenshtein fallback ≥ 0.8", () => {
    const g = [mkGrant(4, "Renewed Banking System")];
    const r = [mkRes("Renewed-Banking", "renewed_banking", "Renewed Scripts")];
    const result = matchGrants(g, r);
    expect(result.matches.length).toBe(1);
  });

  it("unmatched grant goes to newInstalls bucket", () => {
    const g = [mkGrant(5, "unheard_of_thing")];
    const result = matchGrants(g, []);
    expect(result.newInstalls).toEqual([5]);
  });

  it("unmatched .fxap resource goes to orphaned list", () => {
    const result = matchGrants([], [mkRes("mystery", "mystery", "someone", true)]);
    expect(result.orphaned).toEqual([expect.stringMatching(/mystery/)]);
  });

  it("non-fxap unmatched resource not flagged as orphaned", () => {
    const result = matchGrants([], [mkRes("flrp_custom", "flrp_custom", "Flashwing", false)]);
    expect(result.orphaned).toEqual([]);
  });
});
