/**
 * Phase 1.6 Task 12 — scan_updates adversarial tests.
 *
 * Covers the 4 attack scenarios from the spec's § Adversarial section and
 * risk register R5 (Forged notice attack).
 *
 * IMPORTANT — defense-in-depth disclaimer (spec line 369 / risk register R5):
 *   The URL allowlist is defense-in-depth, not a hard security boundary.
 *   Any resource with console write access is already INSIDE the trust
 *   boundary — it could impersonate another resource's notice shape wholesale.
 *   What these tests prove is that for the *common and recoverable* cases
 *   (forged URL, fake slug, regex DoS, newline smuggling), the scanner fails
 *   safely: untrusted URLs are demoted to plain text, fake slugs land in
 *   `unmapped` (not `available`), 100KB garbage completes under budget, and
 *   newline-smuggled version fields are rejected by the pattern regex anchors.
 *
 * See `docs/superpowers/specs/2026-04-19-cfx-sync-update-scanner-design.md`
 * § "Adversarial" for the canonical scenario list.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { scanUpdates } from "../../src/lib/updates/scanner.js";
import { parseNotices } from "../../src/lib/updates/logScraper.js";
import { PATTERNS } from "../../src/lib/updates/patterns/index.js";
import type { MappingFile } from "../../src/lib/state/mapping.js";
import type { StateGetter } from "../../src/lib/updates/scanner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadFixture(name: string): string[] {
  const full = path.join(__dirname, "..", "fixtures", "log-snippets", name);
  const txt = readFileSync(full, "utf8");
  const lines = txt.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const EMPTY_MAPPING: MappingFile = {
  version: 3,
  approvedAt: "2025-01-01T00:00:00.000Z",
  newInstalls: [],
  orphaned: [],
  entries: {},
};

const EMPTY_STATE: StateGetter = { get: () => undefined };

const NO_PORTAL_UPDATES = async () => ({
  updated: [],
  stale: false,
  portalFromCache: false,
});

describe("scan_updates adversarial", () => {
  /**
   * Scenario 1 — Forged notice injection (spec line 366 / risk register R5).
   *
   * A compromised (or malicious) resource with console access prints a
   * Codesign-shaped notice block whose Changelog URL points at an
   * attacker-controlled host. The URL allowlist (urlAllowlist.ts + per-pattern
   * `trustedDomains`) must:
   *   - NOT surface the URL as `releaseNotesUrl` (URL field = vouched)
   *   - Demote it to a plain-text fragment inside `severityNote` so operators
   *     can still see what was announced, but the string isn't auto-clickable
   *     as a vouched changelog.
   *
   * Scanner still surfaces the notice — can't tell forgery from legit output.
   * That's by design (see spec disclaimer at module JSDoc).
   */
  it("1. forged notice injection: untrusted Changelog URL demoted to severityNote plain text", async () => {
    const legitFixture = loadFixture("codesign-cd_bridge.log");
    const maliciousNotice = [
      "[  script:cd_evil] ====================================================",
      "[  script:cd_evil] [cd_evil] - New Update Available!",
      "[  script:cd_evil] Current Version: 1.0.0.",
      "[  script:cd_evil] New Version: 2.0.0.",
      "[  script:cd_evil] Notes: Critical security update.",
      "[  script:cd_evil] Changelog: http://attacker.tld/pwn.",
      "[  script:cd_evil] ====================================================",
    ];
    const combined = [...legitFixture, ...maliciousNotice];

    const result = await scanUpdates({
      logLines: combined,
      state: EMPTY_STATE,
      mapping: EMPTY_MAPPING,
      patterns: PATTERNS,
      checkUpdatesFn: NO_PORTAL_UPDATES,
      parseNoticesFn: parseNotices,
    });

    // The forged notice parses (pattern is intentionally slug-permissive) but
    // lands in unmapped since there's no portal mapping for cd_evil.
    const evilEntry = result.unmapped.find((r) => r.slug === "cd_evil");
    expect(evilEntry).toBeDefined();

    // releaseNotesUrl is the "vouched" surface — must be absent because the
    // attacker.tld host is NOT on Codesign's trustedDomains allowlist.
    expect(evilEntry?.releaseNotesUrl).toBeUndefined();

    // severityNote (plain-text escape hatch) must contain the URL as text
    // so operators can still triage what was announced.
    expect(evilEntry?.severityNote ?? "").toContain("attacker.tld");
  });

  /**
   * Scenario 2 — Script-name mismatch / unmapped slug (spec line 370).
   *
   * An otherwise well-formed Codesign notice for a slug that the operator has
   * never mapped. Two acceptable outcomes per spec:
   *   (a) Pattern's canonicalSlug accepts it → lands in `unmapped`
   *   (b) Pattern rejects the slug shape → no row produced
   *
   * In either case, the slug MUST NOT appear in `available` (which would
   * imply a mapped portal upgrade path).
   *
   * Our Codesign pattern's canonicalSlug is deliberately permissive (accepts
   * any `[a-z0-9_-]+`) so we get outcome (a) — verify unmapped, never
   * available.
   */
  it("2. script-name mismatch: fake slug lands in unmapped, never in available", async () => {
    const fakeSlugNotice = [
      "[ script:fake_resource] ====================================================",
      "[ script:fake_resource] [fake_resource] - New Update Available!",
      "[ script:fake_resource] Current Version: 1.0.0.",
      "[ script:fake_resource] New Version: 2.0.0.",
      "[ script:fake_resource] Changelog: https://docs.codesign.pro/whatever.",
      "[ script:fake_resource] ====================================================",
    ];

    const result = await scanUpdates({
      logLines: fakeSlugNotice,
      state: EMPTY_STATE,
      mapping: EMPTY_MAPPING,
      patterns: PATTERNS,
      checkUpdatesFn: NO_PORTAL_UPDATES,
      parseNoticesFn: parseNotices,
    });

    // Must never appear in available (would imply it was mapped and bumped).
    expect(result.available.some((r) => r.slug === "fake_resource")).toBe(false);
    expect(result.suppressed.some((r) => r.slug === "fake_resource")).toBe(false);
    expect(result.unknownSource.some((r) => r.slug === "fake_resource")).toBe(false);

    // Codesign pattern accepts the slug shape, so it should land in unmapped.
    // (If the pattern were to tighten its slug regex, this assertion can
    // flip to `expect(result.unmapped.length).toBe(0)` — per spec both
    // outcomes are acceptable. The current pattern accepts it, so we pin
    // that contract here.)
    expect(result.unmapped.some((r) => r.slug === "fake_resource")).toBe(true);
  });

  /**
   * Scenario 3 — Regex DoS / ReDoS defense (spec line 371).
   *
   * 100KB single-line input. Pattern regexes must complete quickly — no
   * catastrophic backtracking. Budget: <100ms per pattern per spec; we assert
   * total scanner wall-time <300ms (allows for scanner overhead + all 4
   * patterns + JIT warmup on a cold test process).
   */
  it("3. regex DoS: 100KB single-line input completes within budget (<300ms)", async () => {
    const hugeLine = "A".repeat(100 * 1024);

    const start = performance.now();
    const result = await scanUpdates({
      logLines: [hugeLine],
      state: EMPTY_STATE,
      mapping: EMPTY_MAPPING,
      patterns: PATTERNS,
      checkUpdatesFn: NO_PORTAL_UPDATES,
      parseNoticesFn: parseNotices,
    });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(300);
    expect(result.scannedLogLines).toBe(1);
    // A 100KB wall of "A" chars cannot match any pattern's opener.
    expect(result.available.length).toBe(0);
    expect(result.suppressed.length).toBe(0);
    expect(result.unknownSource.length).toBe(0);
    expect(result.unmapped.length).toBe(0);
  });

  /**
   * Scenario 4 — Newline smuggling (spec line 372).
   *
   * `[script:cd_bridge] - New Update Available!\nCurrent Version: 1.0.0.`
   * collapsed into a SINGLE array element. Pattern regexes are anchored
   * (`^...$` without the `m` flag) so embedded `\n` inside a single string
   * does NOT split into lines from the regex engine's point of view —
   * the `^` and `$` anchors match start/end of the WHOLE string.
   *
   * Expected: the opener regex, which expects a line-shaped opener, does not
   * match a composite string containing a version tail after a newline.
   * Result: no notice is produced.
   */
  it("4. newline smuggling: embedded \\n in single array element does not span lines", async () => {
    // One array entry, with a newline baked into the middle. If a pattern's
    // `onOpener` treated `^` as "start of each line in the string" (multiline
    // mode), the opener could match while later fields got captured via
    // subsequent lines[] walk — which would be a vulnerability. Our regexes
    // do NOT use the `m` flag, so this must not match.
    const smuggled = [
      "[script:cd_bridge] - New Update Available!\nCurrent Version: 1.0.0.\nNew Version: 9.9.9.",
    ];

    const result = await scanUpdates({
      logLines: smuggled,
      state: EMPTY_STATE,
      mapping: EMPTY_MAPPING,
      patterns: PATTERNS,
      checkUpdatesFn: NO_PORTAL_UPDATES,
      parseNoticesFn: parseNotices,
    });

    // No bucket should catch the smuggled notice.
    expect(result.available.length).toBe(0);
    expect(result.suppressed.length).toBe(0);
    expect(result.unknownSource.length).toBe(0);
    expect(result.unmapped.length).toBe(0);
  });
});
