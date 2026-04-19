/**
 * Security-critical URL allowlist helper.
 *
 * Used by the log scraper to decide whether a URL extracted from a vendor
 * notice is safe to surface as `releaseNotesUrl` or should be demoted to a
 * plain `severityNote` string.
 *
 * Anchoring: EXACT HOST EQUALITY after lowercasing and trailing-dot strip.
 * No subdomain trust, no prefix match, no suffix match.
 *
 *   trustedDomains=['docs.codesign.pro']  ← matches only 'docs.codesign.pro'
 *                                          ← rejects 'foo.docs.codesign.pro'
 *                                          ← rejects 'evil-docs.codesign.pro'
 *                                          ← rejects 'docs.codesign.pro.attacker.com'
 *
 * Rejects outright (before allowlist comparison):
 *  - Malformed URLs (URL constructor throws)
 *  - IPv4 literal hosts (e.g. http://192.168.1.1/path)
 *  - IPv6 literal hosts (e.g. http://[::1]/path) — url.hostname still contains colons
 *  - IDN / non-ASCII hosts (any code point > 127) — prevents visual spoofing attacks
 *
 * Preserves query string + fragment on success.
 */

export type UrlCheckResult =
  | { ok: true; url: URL }
  | { ok: false; reason: UrlRejectReason };

export type UrlRejectReason =
  | "malformed"
  | "ipv4-literal"
  | "ipv6-literal"
  | "idn-unicode"
  | "not-in-allowlist";

/** Matches bare IPv4 addresses: 1-3 digits dot-separated in four octets. */
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * Check a URL string against a trusted-domains allowlist.
 *
 * Decision flow:
 *  1. Parse with `new URL(raw)` — catch → "malformed"
 *  2. Extract hostname (URL strips brackets from IPv6; colons remain)
 *  3. IPv6 check: hostname contains ':' → "ipv6-literal"
 *  4. IPv4 check: hostname matches /^(\d{1,3}\.){3}\d{1,3}$/ → "ipv4-literal"
 *  5. IDN check: any code point > 127 → "idn-unicode"
 *  6. Normalize: lowercase + strip trailing dot
 *  7. Exact-equality check against normalised allowlist entries → pass or "not-in-allowlist"
 */
export function checkUrl(raw: string, trustedDomains: string[]): UrlCheckResult {
  // Step 1: parse
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // Step 2: extract hostname (URL constructor removes brackets from IPv6 but
  // leaves colons, so `[::1]` → hostname `::1`; `192.168.1.1` stays as-is)
  const hostname = parsed.hostname;

  // Step 3: IPv6 literal — colons are never present in valid domain names
  if (hostname.includes(":")) {
    return { ok: false, reason: "ipv6-literal" };
  }

  // Step 4: IPv4 literal
  if (IPV4_RE.test(hostname)) {
    return { ok: false, reason: "ipv4-literal" };
  }

  // Step 5: IDN / non-ASCII detection.
  //
  // The URL constructor Punycode-encodes non-ASCII hostnames before we see
  // them, so `url.hostname` is always ASCII even for inputs like
  // "docs.codesign.рro" (Cyrillic р → Punycode "docs.codesign.xn--ro-kmc").
  //
  // Detection strategy: any label that begins with the ACE prefix "xn--" is
  // a Punycode-encoded label, proving the raw input contained non-ASCII
  // characters.  Split on "." and check each label.
  const labels = hostname.split(".");
  if (labels.some((label) => label.toLowerCase().startsWith("xn--"))) {
    return { ok: false, reason: "idn-unicode" };
  }

  // Step 6: normalize — lowercase and strip trailing dot
  const normalizedHost = hostname.toLowerCase().replace(/\.$/, "");

  // Step 7: exact-equality match against normalized allowlist
  const normalizedAllowlist = trustedDomains.map((d) =>
    d.toLowerCase().replace(/\.$/, "")
  );

  if (normalizedAllowlist.includes(normalizedHost)) {
    return { ok: true, url: parsed };
  }

  return { ok: false, reason: "not-in-allowlist" };
}
