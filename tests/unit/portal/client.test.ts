import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { PortalApiClient } from "../../../src/lib/portal/client.js";
import { CookieJar } from "../../../src/lib/auth/cookieJar.js";
import {
  AuthExpiredError,
  InvalidTargetError,
  ForbiddenError,
  PortalRateLimitError,
} from "../../../src/lib/errors.js";

const BASE = "https://portal-api.cfx.re";

describe("PortalApiClient", () => {
  let mock: MockAgent;
  let saved: any;

  beforeEach(() => {
    saved = getGlobalDispatcher();
    mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
  });

  afterEach(() => {
    setGlobalDispatcher(saved);
  });

  function newClient() {
    const jar = new CookieJar();
    jar.replaceAll([
      { name: "session", value: "abc", domain: ".cfx.re", expires: Date.now() / 1000 + 3600 },
    ]);
    return new PortalApiClient({ apiBase: BASE, cookieJar: jar });
  }

  it("GET /v1/me returns parsed Me on 200", async () => {
    const pool = mock.get(BASE);
    pool.intercept({ path: "/v1/me", method: "GET" }).reply(200, {
      id: 1, username: "u", email: "e", avatar_url: "a",
      groups: [], has_patreon: false, has_portal_subscription: false,
    });
    const me = await newClient().getMe();
    expect(me.username).toBe("u");
  });

  it("GET /v1/me throws AuthExpiredError on 401", async () => {
    const pool = mock.get(BASE);
    pool.intercept({ path: "/v1/me", method: "GET" }).reply(401, "unauthorized");
    await expect(newClient().getMe()).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it("attaches cookies on matching-host requests", async () => {
    const pool = mock.get(BASE);
    pool
      .intercept({
        path: "/v1/me",
        method: "GET",
        headers: (h: any) => String(h.cookie || "").includes("session=abc"),
      })
      .reply(200, {
        id: 1, username: "u", email: "e", avatar_url: "a",
        groups: [], has_patreon: false, has_portal_subscription: false,
      });
    await newClient().getMe();
  });

  it("rejects off-allowlist hosts with InvalidTargetError", async () => {
    const jar = new CookieJar();
    const c = new PortalApiClient({ apiBase: "https://evil.example.com", cookieJar: jar });
    await expect(c.getMe()).rejects.toBeInstanceOf(InvalidTargetError);
  });

  it("throws ForbiddenError on 403", async () => {
    const pool = mock.get(BASE);
    pool.intercept({ path: "/v1/me", method: "GET" }).reply(403, "forbidden");
    await expect(newClient().getMe()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("throws PortalRateLimitError on 429 with retry-after", async () => {
    const pool = mock.get(BASE);
    pool.intercept({ path: "/v1/me", method: "GET" }).reply(429, "rate limited", {
      headers: { "retry-after": "60" },
    });
    try {
      await newClient().getMe();
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PortalRateLimitError);
      expect((e as Error).message).toContain("60s");
    }
  });

  it("handles empty grants (page_count=0) without looping", async () => {
    const pool = mock.get(BASE);
    pool
      .intercept({ path: /\/v1\/me\/asset-grants/, method: "GET" })
      .reply(200, { grants: [], page: 1, page_count: 0, item_count: 0 });
    const out = await newClient().listGrants({});
    expect(out.grants).toEqual([]);
  });

  it("off-allowlist host never sends a request (fails before any network call)", async () => {
    // The MockAgent has net-connect disabled, so any real request attempt
    // would fail with a characteristic error. InvalidTargetError thrown
    // synchronously means we never reached the network layer.
    const jar = new CookieJar();
    jar.replaceAll([
      { name: "session", value: "SECRET", domain: ".cfx.re", expires: Date.now() / 1000 + 3600 },
    ]);
    const c = new PortalApiClient({ apiBase: "https://evil.example.com", cookieJar: jar });
    await expect(c.getMe()).rejects.toBeInstanceOf(InvalidTargetError);
    // The cookie jar was never queried (indirectly verified: InvalidTargetError
    // is thrown before headerFor() runs — see client.ts:request()).
  });

  it("listGrants paginates fully (no short-circuit)", async () => {
    const pool = mock.get(BASE);
    pool
      .intercept({
        path: /\/v1\/me\/asset-grants\?.*page=1/,
        method: "GET",
      })
      .reply(200, { grants: [mkGrant(1)], page: 1, page_count: 2, item_count: 2 });
    pool
      .intercept({
        path: /\/v1\/me\/asset-grants\?.*page=2/,
        method: "GET",
      })
      .reply(200, { grants: [mkGrant(2)], page: 2, page_count: 2, item_count: 2 });

    const all = await newClient().listGrants({});
    expect(all.grants.length).toBe(2);
    expect(all.grants.map((g) => g.grant_id)).toEqual([1, 2]);
  });
});

function mkGrant(id: number) {
  return {
    grant_id: id,
    transferable: true,
    updated_since_last_download: false,
    download_url: "TBA",
    received_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-02-01T00:00:00Z",
    asset: {
      id, author: "a", name: `asset-${id}`, state: "active",
      is_disabled: false, disabled_reason: null,
      versions: [{ id: 9000 + id, packs: [{ id: 100 + id }] }],
    },
  };
}
