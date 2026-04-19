import { describe, it, expect, beforeEach } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import { GetOnlyClient } from "../../../src/lib/portal/getOnlyClient.js";

describe("GetOnlyClient", () => {
  let mockAgent: MockAgent;

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  it("performs GET requests", async () => {
    const pool = mockAgent.get("https://example.com");
    pool.intercept({ path: "/foo", method: "GET" }).reply(200, { ok: true });
    const client = new GetOnlyClient();
    const res = await client.get("https://example.com/foo");
    expect(res.statusCode).toBe(200);
  });

  it("exposes no mutation methods on the instance", () => {
    const client = new GetOnlyClient();
    // Verifying absence of mutation methods — intentionally inspecting unknown keys.
    const c = client as unknown as Record<string, unknown>;
    expect(c.post).toBeUndefined();
    expect(c.put).toBeUndefined();
    expect(c.patch).toBeUndefined();
    expect(c.delete).toBeUndefined();
    expect(c.request).toBeUndefined();
  });

  it("passes custom headers through", async () => {
    const pool = mockAgent.get("https://example.com");
    pool
      .intercept({
        path: "/v1/me",
        method: "GET",
        headers: (h: Record<string, string>) => h["x-test"] === "abc",
      })
      .reply(200, {});
    const client = new GetOnlyClient();
    const res = await client.get("https://example.com/v1/me", {
      headers: { "X-Test": "abc" },
    });
    expect(res.statusCode).toBe(200);
  });
});
