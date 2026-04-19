import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { codesignPattern } from "../../../../src/lib/updates/patterns/codesign.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../../../fixtures/log-snippets");

function loadFixture(name: string): string[] {
  const raw = readFileSync(resolve(FIXTURES, name), "utf8");
  // Preserve the fixture shape exactly — split on newline, drop trailing empty line.
  const lines = raw.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Walk a fixture and find the first opener line's index — the `blockMatch`
 * contract expects startIdx to point at the opener.  Returns -1 if none.
 */
function findOpenerIdx(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (/\[[a-z0-9_-]+\] - New Update Available!/i.test(lines[i] ?? "")) {
      return i;
    }
  }
  return -1;
}

describe("codesignPattern.canonicalSlug", () => {
  it("accepts bracket-wrapped slug: [cd_dispatch] → cd_dispatch", () => {
    expect(codesignPattern.canonicalSlug("[cd_dispatch]")).toBe("cd_dispatch");
  });

  it("accepts bare slug: cd_bridge → cd_bridge", () => {
    expect(codesignPattern.canonicalSlug("cd_bridge")).toBe("cd_bridge");
  });

  it("normalizes dashes → underscores: [cd-dispatch-] → cd_dispatch", () => {
    expect(codesignPattern.canonicalSlug("[cd-dispatch-]")).toBe("cd_dispatch");
  });

  it("lowercases: [CD_BRIDGE] → cd_bridge", () => {
    expect(codesignPattern.canonicalSlug("[CD_BRIDGE]")).toBe("cd_bridge");
  });

  it("returns null for [script:cd_bridge] (logScraper strips script: prefix)", () => {
    // The logScraper in Task 8 is responsible for stripping "[script:...]" and
    // feeding just the bare token to canonicalSlug — so a colon in the input
    // indicates caller error and should return null.
    expect(codesignPattern.canonicalSlug("[script:cd_bridge]")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(codesignPattern.canonicalSlug("")).toBeNull();
  });

  it("returns null for brackets-only", () => {
    expect(codesignPattern.canonicalSlug("[]")).toBeNull();
  });

  it("returns null when only trailing dashes are present", () => {
    // "[---]" after stripping brackets → "---" → dashes → underscores → "___"
    // then trailing-underscore trim → "" → reject.
    expect(codesignPattern.canonicalSlug("[---]")).toBeNull();
  });

  it("returns null for tokens with whitespace", () => {
    expect(codesignPattern.canonicalSlug("[cd bridge]")).toBeNull();
  });

  it("returns null for tokens with special chars", () => {
    expect(codesignPattern.canonicalSlug("[cd$bridge]")).toBeNull();
  });
});

describe("codesignPattern.blockMatch — real fixtures", () => {
  it("parses cd_bridge fixture: 1.0.23 → 1.0.26, docs.codesign.pro trusted", () => {
    const lines = loadFixture("codesign-cd_bridge.log");
    const idx = findOpenerIdx(lines);
    expect(idx).toBeGreaterThanOrEqual(0);

    const m = codesignPattern.blockMatch(lines, idx);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.canonicalSlug).toBe("cd_bridge");
    expect(m.current).toBe("1.0.23");
    expect(m.announced).toBe("1.0.26");
    expect(m.releaseNotesUrl).toBe(
      "https://docs.codesign.pro/paid-scripts/bridge/changelog"
    );
    expect(m.patternId).toBe("codesign-v1");
    expect(m.linesConsumed).toBeGreaterThan(0);
  });

  it("parses cd_doorlock fixture: 2.1.15 → 2.1.16", () => {
    const lines = loadFixture("codesign-cd_doorlock.log");
    const idx = findOpenerIdx(lines);
    expect(idx).toBeGreaterThanOrEqual(0);

    const m = codesignPattern.blockMatch(lines, idx);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.canonicalSlug).toBe("cd_doorlock");
    expect(m.current).toBe("2.1.15");
    expect(m.announced).toBe("2.1.16");
    expect(m.releaseNotesUrl).toBe(
      "https://docs.codesign.pro/paid-scripts/door-lock/changelog"
    );
  });

  it("parses cd_dispatch: Download at keymaster, Changelog at docs.codesign.pro — we keep Changelog", () => {
    const lines = loadFixture("codesign-cd_dispatch.log");
    const idx = findOpenerIdx(lines);
    expect(idx).toBeGreaterThanOrEqual(0);

    const m = codesignPattern.blockMatch(lines, idx);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.canonicalSlug).toBe("cd_dispatch");
    expect(m.current).toBe("4.3.7");
    expect(m.announced).toBe("4.3.11");
    // Download URL (keymaster.fivem.net/asset-grants) is IGNORED for releaseNotesUrl.
    // We capture the Changelog URL only.
    expect(m.releaseNotesUrl).toBe(
      "https://docs.codesign.pro/paid-scripts/dispatch#changelog"
    );
  });

  it("captures 'Notes:' into severityNote for cd_bridge", () => {
    const lines = loadFixture("codesign-cd_bridge.log");
    const idx = findOpenerIdx(lines);
    const m = codesignPattern.blockMatch(lines, idx);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.severityNote).toBeDefined();
    expect(m.severityNote).toContain("Another Major Update");
  });
});

describe("codesignPattern.blockMatch — adversarial + edge cases", () => {
  it("demotes an untrusted Changelog URL to severityNote (no releaseNotesUrl)", () => {
    // Synthetic fixture — keep the shape identical to Codesign but point
    // Changelog at an off-allowlist host.
    const lines = [
      "[    script:cd_evil] ===================================================================",
      "[    script:cd_evil] [cd_evil] - New Update Available!",
      "[    script:cd_evil] Current Version: 1.0.0.",
      "[    script:cd_evil] New Version: 1.0.1.",
      "[    script:cd_evil] Notes: Routine update.",
      "[    script:cd_evil] Changelog: https://evil.tld/changelog.",
      "[    script:cd_evil] ===================================================================",
    ];
    const idx = findOpenerIdx(lines);
    const m = codesignPattern.blockMatch(lines, idx);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.canonicalSlug).toBe("cd_evil");
    expect(m.current).toBe("1.0.0");
    expect(m.announced).toBe("1.0.1");
    // URL was not trusted → must not expose it as releaseNotesUrl
    expect(m.releaseNotesUrl).toBeUndefined();
    // But the URL must still appear somewhere in severityNote so the operator
    // sees what was announced.
    expect(m.severityNote).toBeDefined();
    expect(m.severityNote).toContain("evil.tld");
  });

  it("block timeout: opener followed by 25 unrelated lines → null", () => {
    const opener = "[    script:cd_bridge] [cd_bridge] - New Update Available!";
    const filler = Array.from(
      { length: 25 },
      (_, i) => `[    script:cd_bridge] unrelated filler line ${i}`
    );
    const lines = [opener, ...filler];
    const m = codesignPattern.blockMatch(lines, 0);
    expect(m).toBeNull();
  });

  it("truncated block: opener + Current but no New before EOF → null", () => {
    const lines = [
      "[    script:cd_bridge] [cd_bridge] - New Update Available!",
      "[    script:cd_bridge] Current Version: 1.0.0.",
    ];
    const m = codesignPattern.blockMatch(lines, 0);
    expect(m).toBeNull();
  });

  it("missing required Current Version → null", () => {
    const lines = [
      "[    script:cd_bridge] [cd_bridge] - New Update Available!",
      "[    script:cd_bridge] New Version: 1.0.1.",
      "[    script:cd_bridge] ===================================================================",
    ];
    const m = codesignPattern.blockMatch(lines, 0);
    expect(m).toBeNull();
  });

  it("anchored regex rejects newline-smuggled version line", () => {
    // A single array element containing an embedded \n must NOT be treated as
    // two independent lines.  The strip-prefix + anchored regexes MUST NOT
    // produce a Current Version capture out of a composite line.
    //
    // Two-layer defence: (1) stripScriptPrefix's `(.*)$` without the `m` flag
    // bails on embedded \n so the opener test falls back to matching against
    // the raw line; (2) OPENER_RE's `^\[(...)\]` anchors to start-of-string,
    // so the `[    script:cd_bridge]` FiveM prefix wins the first bracket and
    // the regex rejects because `script:cd_bridge` contains `:` (not in the
    // slug character class).
    const lines = [
      "[    script:cd_bridge] [cd_bridge] - New Update Available!\nCurrent Version: 1.0.0.",
      "[    script:cd_bridge] New Version: 1.0.1.",
      "[    script:cd_bridge] ===================================================================",
    ];
    const m = codesignPattern.blockMatch(lines, 0);
    expect(m).toBeNull();
  });

  it("anchored version regex: 'Current Version: 1.0.0.' trailing-dot aware", () => {
    // Direct exercise of the CURRENT_VERSION_RE anchor — confirms the
    // optional trailing dot strips without also eating valid version chars.
    const lines = [
      "[    script:cd_bridge] =====================================================================",
      "[    script:cd_bridge] [cd_bridge] - New Update Available!",
      "[    script:cd_bridge] Current Version: 1.0.0.",
      "[    script:cd_bridge] New Version: 1.0.1",
      "[    script:cd_bridge] =====================================================================",
    ];
    const m = codesignPattern.blockMatch(lines, 1);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.current).toBe("1.0.0");
    expect(m.announced).toBe("1.0.1"); // no trailing dot also accepted
  });
});

describe("codesignPattern.blockMatch — cross-orthogonality", () => {
  // Running each non-Codesign fixture through codesign.blockMatch at EVERY
  // start-index must produce null for every position.  This proves the
  // Codesign pattern does not false-match sibling authors.
  const siblingFixtures = [
    "ulc-fork-case.log",
    "prompt-sandy_illegal_garage.log",
    "prompt-sandy_mechanic.log",
    "quasarstore-qs-inventory.log",
    "quasarstore-qs-housing.log",
  ];

  for (const name of siblingFixtures) {
    it(`does not false-match ${name} at any start index`, () => {
      const lines = loadFixture(name);
      for (let i = 0; i < lines.length; i++) {
        const m = codesignPattern.blockMatch(lines, i);
        expect(
          m,
          `unexpected match at line ${i} in ${name}: ${JSON.stringify(m)}`
        ).toBeNull();
      }
    });
  }
});

describe("codesignPattern — metadata", () => {
  it("has stable id and description", () => {
    expect(codesignPattern.id).toBe("codesign-v1");
    expect(codesignPattern.description).toMatch(/codesign/i);
  });

  it("trustedDomains includes docs.codesign.pro, portal.cfx.re, keymaster.fivem.net", () => {
    expect(codesignPattern.trustedDomains).toContain("docs.codesign.pro");
    expect(codesignPattern.trustedDomains).toContain("portal.cfx.re");
    expect(codesignPattern.trustedDomains).toContain("keymaster.fivem.net");
  });
});
