import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { quasarstorePattern } from "../../../../src/lib/updates/patterns/quasarstore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../../../fixtures/log-snippets");

function loadFixture(name: string): string[] {
  const raw = readFileSync(resolve(FIXTURES, name), "utf8");
  const lines = raw.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Walk a fixture and find the first opener line's index.  quasarstore's
 * opener is `New version available for <slug>!` (post-prefix strip).
 */
function findOpenerIdx(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const stripped = raw.replace(/^\[\s*script:[^\]]+\]\s?/, "");
    if (/^New version available for [a-z0-9_-]+!?\s*$/i.test(stripped)) {
      return i;
    }
  }
  return -1;
}

describe("quasarstorePattern.canonicalSlug", () => {
  it("accepts bracket-wrapped token: [qs-inventory] → qs-inventory", () => {
    expect(quasarstorePattern.canonicalSlug("[qs-inventory]")).toBe(
      "qs-inventory"
    );
  });

  it("accepts bare slug: qs-housing → qs-housing", () => {
    expect(quasarstorePattern.canonicalSlug("qs-housing")).toBe("qs-housing");
  });

  it("lowercases mixed-case input: qs-Inventory → qs-inventory", () => {
    expect(quasarstorePattern.canonicalSlug("qs-Inventory")).toBe(
      "qs-inventory"
    );
  });

  it("accepts non-qs prefix slug (permissive — opener regex enforces)", () => {
    // canonicalSlug is permissive like prompt.ts; actual qs- prefix is
    // enforced via the opener regex, not the slug normalizer.
    expect(quasarstorePattern.canonicalSlug("qs-advancedinventory")).toBe(
      "qs-advancedinventory"
    );
  });

  it("rejects empty string", () => {
    expect(quasarstorePattern.canonicalSlug("")).toBeNull();
  });

  it("rejects brackets-only: [] → null", () => {
    expect(quasarstorePattern.canonicalSlug("[]")).toBeNull();
  });

  it("rejects token with whitespace inside brackets: [qs- inventory] → null", () => {
    expect(quasarstorePattern.canonicalSlug("[qs- inventory]")).toBeNull();
  });

  it("rejects script-prefixed input (caller bug)", () => {
    expect(quasarstorePattern.canonicalSlug("[script:qs-inventory]")).toBeNull();
  });
});

describe("quasarstorePattern.blockMatch — outdated fixtures", () => {
  it("qs-inventory fixture: announces qs-advancedinventory (announced slug wins over emitter)", () => {
    const lines = loadFixture("quasarstore-qs-inventory.log");
    const idx = findOpenerIdx(lines);
    expect(idx).toBeGreaterThanOrEqual(0);

    const m = quasarstorePattern.blockMatch(lines, idx);
    expect(m).not.toBeNull();
    if (!m) return;

    // CRITICAL: the emitter script token is qs-inventory but the announced
    // slug is qs-advancedinventory.  Pattern contract: ANNOUNCED slug wins.
    expect(m.canonicalSlug).toBe("qs-advancedinventory");
    expect(m.current).toBe("1.5.56");
    expect(m.announced).toBe("1.5.71");
    expect(m.patternId).toBe("quasarstore-v1");
    expect(m.linesConsumed).toBeGreaterThan(0);
    expect(m.releaseNotesUrl).toBeUndefined();
  });

  it("qs-housing fixture: announced slug matches emitter (both qs-housing)", () => {
    const lines = loadFixture("quasarstore-qs-housing.log");
    const idx = findOpenerIdx(lines);
    expect(idx).toBeGreaterThanOrEqual(0);

    const m = quasarstorePattern.blockMatch(lines, idx);
    expect(m).not.toBeNull();
    if (!m) return;

    expect(m.canonicalSlug).toBe("qs-housing");
    expect(m.current).toBe("5.2.29");
    expect(m.announced).toBe("5.3.17");
    expect(m.patternId).toBe("quasarstore-v1");
  });

  it("announced-slug-wins: qs-inventory fixture does NOT emit qs-inventory as the canonical slug", () => {
    // Lock in the semantic explicitly — regression trap.
    const lines = loadFixture("quasarstore-qs-inventory.log");
    const idx = findOpenerIdx(lines);
    const m = quasarstorePattern.blockMatch(lines, idx);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.canonicalSlug).not.toBe("qs-inventory");
    expect(m.canonicalSlug).toBe("qs-advancedinventory");
  });
});

describe("quasarstorePattern.blockMatch — up-to-date variant returns null", () => {
  it("qs-vehiclekeys-uptodate fixture: blockMatch returns null at every start index", () => {
    const lines = loadFixture("quasarstore-qs-vehiclekeys-uptodate.log");
    for (let i = 0; i < lines.length; i++) {
      const m = quasarstorePattern.blockMatch(lines, i);
      expect(
        m,
        `unexpected match at line ${i} in uptodate fixture: ${JSON.stringify(m)}`
      ).toBeNull();
    }
  });
});

describe("quasarstorePattern.blockMatch — adversarial + edge cases", () => {
  it("missing second line (opener only) → null", () => {
    const lines = [
      "[ script:qs-inventory] New version available for qs-advancedinventory!",
    ];
    const m = quasarstorePattern.blockMatch(lines, 0);
    expect(m).toBeNull();
  });

  it("malformed second line → null", () => {
    const lines = [
      "[ script:qs-inventory] New version available for qs-advancedinventory!",
      "[ script:qs-inventory] You have banana, upgrade to cheese!",
    ];
    const m = quasarstorePattern.blockMatch(lines, 0);
    expect(m).toBeNull();
  });

  it("non-quasarstore opener at startIdx → null", () => {
    const lines = [
      "[    script:cd_bridge] [cd_bridge] - New Update Available!",
      "[    script:cd_bridge] Current Version: 1.0.0.",
    ];
    const m = quasarstorePattern.blockMatch(lines, 0);
    expect(m).toBeNull();
  });

  it("newline-smuggled opener cannot smuggle the second line", () => {
    // Single array element with embedded \n must NOT be interpreted as two
    // logical lines.  Opener regex anchored ^...$ without /m flag.
    const lines = [
      "[ script:qs-evil] New version available for qs-evil!\nYou have version 1.0.0, upgrade to version 2.0.0!",
    ];
    const m = quasarstorePattern.blockMatch(lines, 0);
    expect(m).toBeNull();
  });

  it("date-style version strings are preserved verbatim (Task 9 owns semver compare)", () => {
    const lines = [
      "[ script:qs-thing] New version available for qs-thing!",
      "[ script:qs-thing] You have version 2025.01.15, upgrade to version 2025.03.01!",
    ];
    const m = quasarstorePattern.blockMatch(lines, 0);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.current).toBe("2025.01.15");
    expect(m.announced).toBe("2025.03.01");
  });

  it("two-part numeric version strings round-trip", () => {
    const lines = [
      "[ script:qs-thing] New version available for qs-thing!",
      "[ script:qs-thing] You have version 1.0, upgrade to version 2.0!",
    ];
    const m = quasarstorePattern.blockMatch(lines, 0);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.current).toBe("1.0");
    expect(m.announced).toBe("2.0");
  });
});

describe("quasarstorePattern.blockMatch — cross-orthogonality", () => {
  const siblingFixtures = [
    "codesign-cd_bridge.log",
    "codesign-cd_doorlock.log",
    "codesign-cd_dispatch.log",
    "prompt-sandy_illegal_garage.log",
    "prompt-sandy_mechanic.log",
    "ulc-fork-case.log",
  ];

  for (const name of siblingFixtures) {
    it(`does not false-match ${name} at any start index`, () => {
      const lines = loadFixture(name);
      for (let i = 0; i < lines.length; i++) {
        const m = quasarstorePattern.blockMatch(lines, i);
        expect(
          m,
          `unexpected match at line ${i} in ${name}: ${JSON.stringify(m)}`
        ).toBeNull();
      }
    });
  }
});

describe("quasarstorePattern — metadata", () => {
  it("has stable id quasarstore-v1", () => {
    expect(quasarstorePattern.id).toBe("quasarstore-v1");
  });

  it("description mentions quasarstore + announced-slug quirk", () => {
    expect(quasarstorePattern.description).toMatch(/quasarstore/i);
  });

  it("trustedDomains is empty (no URLs observed in fixtures)", () => {
    expect(quasarstorePattern.trustedDomains).toEqual([]);
  });
});
