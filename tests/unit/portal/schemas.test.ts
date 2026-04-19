import { describe, it, expect } from "vitest";
import { MeSchema, GrantSchema, GrantsResponseSchema } from "../../../src/lib/portal/schemas.js";

const sampleMe = {
  id: 12345,
  username: "Flashwing",
  email: "x@example.com",
  avatar_url: "https://x/a.png",
  groups: [],
  has_patreon: false,
  has_portal_subscription: false,
};

const sampleGrant = {
  grant_id: 111,
  transferable: true,
  updated_since_last_download: false,
  download_url: "TBA",
  received_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-02-01T00:00:00Z",
  asset: {
    id: 555,
    author: "AuthorName",
    name: "QS Inventory",
    state: "active",
    is_disabled: false,
    disabled_reason: null,
    versions: [
      { id: 5001, packs: [{ id: 700 }] },
    ],
  },
};

describe("portal schemas", () => {
  it("parses a typical /v1/me response", () => {
    const parsed = MeSchema.parse(sampleMe);
    expect(parsed.username).toBe("Flashwing");
  });

  it("parses a typical grant", () => {
    const parsed = GrantSchema.parse(sampleGrant);
    expect(parsed.grant_id).toBe(111);
    expect(parsed.asset.versions[0]!.packs[0]!.id).toBe(700);
  });

  it("STRIPS grant_transfers if present in response body", () => {
    const raw = {
      grants: [sampleGrant],
      grant_transfers: [{ this: "should", not: "appear" }],
      page: 1,
      page_count: 1,
      item_count: 1,
    };
    const parsed = GrantsResponseSchema.parse(raw);
    expect((parsed as unknown as { grant_transfers?: unknown }).grant_transfers).toBeUndefined();
  });

  it("rejects grants missing required fields", () => {
    const bad = { ...sampleGrant, grant_id: "not-a-number" };
    expect(() => GrantSchema.parse(bad)).toThrow();
  });
});
