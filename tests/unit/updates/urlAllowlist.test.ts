import { describe, it, expect } from "vitest";
import { checkUrl } from "../../../src/lib/updates/urlAllowlist.js";
import type { UrlCheckResult } from "../../../src/lib/updates/urlAllowlist.js";

// Default trusted domains used by most tests
const TRUSTED = ["docs.codesign.pro"];

describe("checkUrl", () => {
  // ---------------------------------------------------------------------------
  // 11 adversarial cases from spec § Test plan urlAllowlist
  // ---------------------------------------------------------------------------

  it("case 1: exact host match → ok", () => {
    const result: UrlCheckResult = checkUrl(
      "https://docs.codesign.pro/paid-scripts/bridge/changelog",
      TRUSTED
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.hostname).toBe("docs.codesign.pro");
    }
  });

  it("case 2: host off-allowlist → not-in-allowlist", () => {
    const result = checkUrl("https://evil.tld/changelog", TRUSTED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not-in-allowlist");
    }
  });

  it("case 3: subdomain of allowlisted host → not-in-allowlist (no implicit subdomain trust)", () => {
    const result = checkUrl("https://foo.docs.codesign.pro/changelog", TRUSTED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not-in-allowlist");
    }
  });

  it("case 4: superset attack — docs.codesign.pro.attacker.com → not-in-allowlist", () => {
    const result = checkUrl(
      "https://docs.codesign.pro.attacker.com/changelog",
      TRUSTED
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not-in-allowlist");
    }
  });

  it("case 5: prefix-bleed — evil-docs.codesign.pro → not-in-allowlist", () => {
    const result = checkUrl("https://evil-docs.codesign.pro/changelog", TRUSTED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not-in-allowlist");
    }
  });

  it("case 6: uppercase host is lowercased before compare → ok", () => {
    const result = checkUrl("https://DOCS.codesign.pro/changelog", TRUSTED);
    expect(result.ok).toBe(true);
  });

  it("case 7: trailing dot stripped before compare → ok", () => {
    const result = checkUrl("https://docs.codesign.pro./changelog", TRUSTED);
    expect(result.ok).toBe(true);
  });

  it("case 8: HTTP scheme accepted (schema is pattern-level concern, not allowlist) → ok", () => {
    const result = checkUrl("http://docs.codesign.pro/changelog", TRUSTED);
    expect(result.ok).toBe(true);
  });

  it("case 9: malformed URL → malformed", () => {
    const result = checkUrl("not a valid url", TRUSTED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed");
    }
  });

  it("case 10: IPv4 literal host → ipv4-literal", () => {
    const result = checkUrl("http://192.168.1.1/path", TRUSTED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ipv4-literal");
    }
  });

  it("case 11: IPv6 literal host → ipv6-literal", () => {
    const result = checkUrl("http://[::1]/path", TRUSTED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ipv6-literal");
    }
  });

  // ---------------------------------------------------------------------------
  // Bonus cases from spec
  // ---------------------------------------------------------------------------

  it("bonus 12: Cyrillic IDN spoofing — docs.codesign.рro (р = U+0440) → idn-unicode", () => {
    // The 'р' here is Cyrillic SMALL LETTER ER (U+0440), visually identical to
    // Latin 'p'. This MUST be rejected before the allowlist comparison runs,
    // preventing a visual-spoofing attack against any allowlist entry.
    const cyrillicUrl = "https://docs.codesign.\u0440ro/changelog";
    const result = checkUrl(cyrillicUrl, TRUSTED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("idn-unicode");
    }
  });

  it("bonus 13: query-string + fragment preserved in returned URL object", () => {
    const raw = "https://docs.codesign.pro/path?foo=bar#frag";
    const result = checkUrl(raw, TRUSTED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.search).toBe("?foo=bar");
      expect(result.url.hash).toBe("#frag");
      expect(result.url.pathname).toBe("/path");
    }
  });

  // ---------------------------------------------------------------------------
  // Additional edge cases
  // ---------------------------------------------------------------------------

  it("empty string → malformed", () => {
    const result = checkUrl("", TRUSTED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed");
    }
  });

  it("empty trustedDomains list — even matching host → not-in-allowlist", () => {
    const result = checkUrl("https://docs.codesign.pro/path", []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not-in-allowlist");
    }
  });

  it("allowlist with mixed-case entry — case-normalised before compare → ok", () => {
    const result = checkUrl("https://docs.codesign.pro/path", [
      "DOCS.codesign.PRO",
    ]);
    expect(result.ok).toBe(true);
  });

  it("multiple domains in allowlist — second domain matches → ok", () => {
    const result = checkUrl("https://portal.cfx.re/assets/changelog", [
      "docs.codesign.pro",
      "portal.cfx.re",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.hostname).toBe("portal.cfx.re");
    }
  });

  it("multiple domains in allowlist — none match → not-in-allowlist", () => {
    const result = checkUrl("https://attacker.com/path", [
      "docs.codesign.pro",
      "portal.cfx.re",
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not-in-allowlist");
    }
  });

  it("IPv4 in non-standard port URL is still detected → ipv4-literal", () => {
    const result = checkUrl("http://10.0.0.1:8080/admin", TRUSTED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ipv4-literal");
    }
  });

  it("IPv6 full address → ipv6-literal", () => {
    const result = checkUrl("http://[2001:db8::1]/path", TRUSTED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ipv6-literal");
    }
  });

  it("mixed ASCII + non-ASCII hostname → idn-unicode", () => {
    // Punycode-encoded IDN: the raw Unicode form must be rejected
    const result = checkUrl("https://docs.codesign.\u4e2d\u6587/path", TRUSTED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("idn-unicode");
    }
  });

  it("javascript: URL → malformed (not http/https but still parseable — spec does not restrict scheme, but this URL has no meaningful hostname)", () => {
    // javascript: is parseable by URL constructor but hostname will be empty string
    // which won't match anything in allowlist → not-in-allowlist
    const result = checkUrl("javascript:alert(1)", TRUSTED);
    // Either malformed (if URL throws) or not-in-allowlist (empty host).
    // Both are acceptable security outcomes — the URL must NOT be ok.
    expect(result.ok).toBe(false);
  });

  it("returned URL object on success has correct href", () => {
    const raw = "https://docs.codesign.pro/changelog";
    const result = checkUrl(raw, TRUSTED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url instanceof URL).toBe(true);
      expect(result.url.href).toBe(raw);
    }
  });
});
