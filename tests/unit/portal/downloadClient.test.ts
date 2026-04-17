import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { DownloadClient } from "../../../src/lib/portal/downloadClient.js";
import { CookieJar } from "../../../src/lib/auth/cookieJar.js";
import { InvalidTargetError } from "../../../src/lib/errors.js";

const PORTAL = "https://portal-api.cfx.re";

describe("DownloadClient", () => {
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

  function mkClient() {
    const jar = new CookieJar();
    jar.replaceAll([
      { name: "session", value: "SECRET", domain: ".cfx.re", expires: Date.now() / 1000 + 3600 },
    ]);
    return new DownloadClient({ apiBase: PORTAL, cookieJar: jar });
  }

  it("chain-origin must be portal-api; other origin rejected", async () => {
    const client = mkClient();
    await expect(
      client.streamDownload(new URL("https://evil.example.com/pack.zip"))
    ).rejects.toBeInstanceOf(InvalidTargetError);
  });

  it("attaches cookies on first request to portal-api", async () => {
    const pool = mock.get(PORTAL);
    pool
      .intercept({
        path: "/v1/asset-grants/1/versions/2/packs/3/download",
        method: "GET",
        headers: (h: any) => String(h.cookie || "").includes("session=SECRET"),
      })
      .reply(200, "zipdata");
    const res = await mkClient().streamDownload(
      new URL(`${PORTAL}/v1/asset-grants/1/versions/2/packs/3/download`)
    );
    expect(res.statusCode).toBe(200);
  });

  it("strips cookies on redirect to non-cfx.re host", async () => {
    // This test is structurally awkward with MockAgent; the real assertion
    // is in the implementation comments + integration test.
    // Here we simulate by checking that `buildFollowHeaders` omits Cookie
    // when the redirect target is not a cfx.re host.
    const client = mkClient();
    const follow = (client as any).buildFollowHeaders(
      new URL("https://cdn.example.com/signed?sig=abc")
    ) as Record<string, string>;
    expect(follow.Cookie).toBeUndefined();
  });

  it("keeps cookies on redirect to another cfx.re host", async () => {
    const client = mkClient();
    const follow = (client as any).buildFollowHeaders(
      new URL("https://portal.cfx.re/some-other-endpoint")
    ) as Record<string, string>;
    expect(follow.Cookie).toMatch(/session=SECRET/);
  });
});
