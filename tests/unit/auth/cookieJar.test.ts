import { describe, it, expect } from "vitest";
import { CookieJar, type CookieEntry } from "../../../src/lib/auth/cookieJar.js";

const cookie = (over: Partial<CookieEntry> = {}): CookieEntry => ({
  name: "session",
  value: "abc",
  domain: ".cfx.re",
  path: "/",
  expires: Math.floor(Date.now() / 1000) + 3600,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  ...over,
});

describe("CookieJar", () => {
  it("counts replaced cookies", () => {
    const jar = new CookieJar();
    jar.replaceAll([cookie(), cookie({ name: "csrf", value: "x" })]);
    expect(jar.count()).toBe(2);
  });

  it("builds a Cookie header for matching host (dotted domain)", () => {
    const jar = new CookieJar();
    jar.replaceAll([cookie({ name: "a", value: "1", domain: ".cfx.re" })]);
    expect(jar.headerFor("https://portal-api.cfx.re/v1/me")).toBe("a=1");
  });

  it("builds a Cookie header for exact-domain match", () => {
    const jar = new CookieJar();
    jar.replaceAll([cookie({ name: "b", value: "2", domain: "portal.cfx.re" })]);
    expect(jar.headerFor("https://portal.cfx.re/x")).toBe("b=2");
  });

  it("excludes cookies for unrelated hosts", () => {
    const jar = new CookieJar();
    jar.replaceAll([cookie({ domain: "example.com" })]);
    expect(jar.headerFor("https://portal.cfx.re/v1/me")).toBe("");
  });

  it("longestExpiry returns max expires over session cookies", () => {
    const jar = new CookieJar();
    const now = Math.floor(Date.now() / 1000);
    jar.replaceAll([
      cookie({ expires: now + 3600 }),
      cookie({ name: "n2", expires: now + 7200 }),
      cookie({ name: "n3", expires: -1 }),
    ]);
    expect(jar.longestExpiry()).toBe(now + 7200);
  });

  it("returns null longestExpiry when all cookies are session-only", () => {
    const jar = new CookieJar();
    jar.replaceAll([cookie({ expires: -1 }), cookie({ name: "n2", expires: undefined as any })]);
    expect(jar.longestExpiry()).toBe(null);
  });

  it("clear() empties the jar", () => {
    const jar = new CookieJar();
    jar.replaceAll([cookie()]);
    jar.clear();
    expect(jar.count()).toBe(0);
    expect(jar.headerFor("https://portal.cfx.re/x")).toBe("");
  });
});
