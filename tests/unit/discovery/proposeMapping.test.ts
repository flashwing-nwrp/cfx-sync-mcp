import { describe, it, expect } from "vitest";
import { proposeMapping } from "../../../src/lib/discovery/proposeMapping.js";
import type { Grant } from "../../../src/lib/portal/types.js";

const mkGrant = (id: number, name: string): Grant => ({
  grant_id: id, transferable: true, updated_since_last_download: false,
  download_url: "TBA", received_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z",
  asset: { id, name, author: "x", state: "active", is_disabled: false, disabled_reason: null, versions: [{ id: 1, packs: [{ id: 1 }] }] },
});

describe("proposeMapping", () => {
  it("returns empty but valid structure for zero grants + zero resources", () => {
    const out = proposeMapping({ matches: [], newInstalls: [], orphaned: [] }, []);
    expect(out.entries).toEqual({});
    expect(out.newInstalls).toEqual([]);
    expect(out.orphaned).toEqual([]);
    expect(out.caveats).toContain("Grants pre-dating the 2025-10-15 portal migration");
  });

  it("populates entries for matched grants", () => {
    const grants = [mkGrant(1, "qs-inventory")];
    const out = proposeMapping(
      {
        matches: [{ grantId: 1, matchedPath: "/srv/qs-inventory", matchTier: 1, confidence: 1, alternatives: [] }],
        newInstalls: [],
        orphaned: [],
      },
      grants
    );
    expect(out.entries["1"]!.slug).toBe("qs_inventory");
    expect(out.entries["1"]!.target).toBe("/srv/qs-inventory");
    expect(out.entries["1"]!.discoveredTier).toBe(1);
  });

  it("surfaces 'new installs' bucket for unmatched grants", () => {
    const grants = [mkGrant(7, "new_thing")];
    const out = proposeMapping({ matches: [], newInstalls: [7], orphaned: [] }, grants);
    expect(out.newInstalls).toEqual([7]);
  });
});
