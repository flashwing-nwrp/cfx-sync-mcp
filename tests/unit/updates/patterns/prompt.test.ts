import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promptPattern } from "../../../../src/lib/updates/patterns/prompt.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../../../fixtures/log-snippets");

function loadFixture(name: string): string[] {
  const raw = readFileSync(resolve(FIXTURES, name), "utf8");
  const lines = raw.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Walk a fixture and find the first opener line's index — the `blockMatch`
 * contract expects startIdx to point at the opener (the top `+---...---+`
 * border).  Returns -1 if none.
 */
function findOpenerIdx(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Strip the `[script:...]` prefix first to test the box border cleanly.
    const stripped = line.replace(/^\[\s*script:[^\]]+\]\s?/, "");
    if (/^\+-{3,}\+$/.test(stripped)) {
      return i;
    }
  }
  return -1;
}

describe("promptPattern.canonicalSlug", () => {
  it("accepts bracket-wrapped slug: [prompt_sandy_illegal_garage] → prompt_sandy_illegal_garage", () => {
    expect(promptPattern.canonicalSlug("[prompt_sandy_illegal_garage]")).toBe(
      "prompt_sandy_illegal_garage"
    );
  });

  it("accepts bare slug: prompt_sandy_mechanic → prompt_sandy_mechanic", () => {
    expect(promptPattern.canonicalSlug("prompt_sandy_mechanic")).toBe(
      "prompt_sandy_mechanic"
    );
  });

  it("preserves trailing underscore (valid slug char): [prompt_sandy_] → prompt_sandy_", () => {
    // Prompt's script prefix is truncated to `prompt_sandy_` in the live log.
    // That truncated form IS a valid slug — do not trim trailing underscores.
    expect(promptPattern.canonicalSlug("[prompt_sandy_]")).toBe("prompt_sandy_");
  });

  it("lowercases: [PROMPT_SANDY] → prompt_sandy", () => {
    expect(promptPattern.canonicalSlug("[PROMPT_SANDY]")).toBe("prompt_sandy");
  });

  it("returns null for empty string", () => {
    expect(promptPattern.canonicalSlug("")).toBeNull();
  });

  it("returns null for brackets-only", () => {
    expect(promptPattern.canonicalSlug("[]")).toBeNull();
  });

  it("returns null for script:-prefixed input (caller error)", () => {
    expect(promptPattern.canonicalSlug("[ script:cd_bridge]")).toBeNull();
  });

  it("returns null for tokens with whitespace", () => {
    expect(promptPattern.canonicalSlug("[prompt sandy]")).toBeNull();
  });

  it("returns null for tokens with special chars", () => {
    expect(promptPattern.canonicalSlug("[prompt$sandy]")).toBeNull();
  });
});

describe("promptPattern.blockMatch — real fixtures", () => {
  it("Variant A (explicit 'for [slug]'): prompt-sandy_illegal_garage → 1.0.5 → 1.1.1", () => {
    const lines = loadFixture("prompt-sandy_illegal_garage.log");
    const idx = findOpenerIdx(lines);
    expect(idx).toBeGreaterThanOrEqual(0);

    const m = promptPattern.blockMatch(lines, idx);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.canonicalSlug).toBe("prompt_sandy_illegal_garage");
    expect(m.current).toBe("1.0.5");
    expect(m.announced).toBe("1.1.1");
    expect(m.patternId).toBe("prompt-v1");
    expect(m.releaseNotesUrl).toBeUndefined();
    expect(m.severityNote).toBeDefined();
    expect(m.severityNote).toContain("- Sandy Illegal Garage & Gas Station");
    expect(m.severityNote).toContain("Please update");
    expect(m.linesConsumed).toBeGreaterThan(0);
  });

  it("Variant B (header-less, truncation edge case): prompt-sandy_mechanic → slug = prompt_sandy_ (FLRP's 13-char script-prefix truncation)", () => {
    // The live FLRP log format truncates the [script:<token>] prefix at 13 chars
    // (including "script:"). So the longest slug surfaceable from the prefix
    // alone is `prompt_sandy_` (trailing underscore preserved) — the mechanic
    // fixture has no explicit `for [slug]` header, so this truncated form is
    // all we can canonicalize.
    const lines = loadFixture("prompt-sandy_mechanic.log");
    const idx = findOpenerIdx(lines);
    expect(idx).toBeGreaterThanOrEqual(0);

    const m = promptPattern.blockMatch(lines, idx);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.canonicalSlug).toBe("prompt_sandy_");
    expect(m.current).toBe("1.1.1");
    expect(m.announced).toBe("1.2.1");
    expect(m.patternId).toBe("prompt-v1");
    expect(m.severityNote).toBeDefined();
    expect(m.severityNote).toContain("- Sandy Mechanic");
  });

  it("captures CHANGELOGS multi-row section into severityNote (newline-joined)", () => {
    // Synthetic fixture with multiple changelog rows — exercise the append path.
    const lines = [
      "[script:prompt_test] +----------------------------------------+",
      "[script:prompt_test] | ⚠️  UPDATE AVAILABLE for [foo]: 1.0.0 → 2.0.0 |",
      "[script:prompt_test] |                                        |",
      "[script:prompt_test] |  CHANGELOGS:                           |",
      "[script:prompt_test] |  - first bullet                        |",
      "[script:prompt_test] |  - second bullet                       |",
      "[script:prompt_test] |  - third bullet                        |",
      "[script:prompt_test] +----------------------------------------+",
    ];
    const m = promptPattern.blockMatch(lines, 0);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.severityNote).toBeDefined();
    const parts = (m.severityNote ?? "").split("\n");
    expect(parts).toContain("Changelog: - first bullet");
    expect(parts).toContain("Changelog: - second bullet");
    expect(parts).toContain("Changelog: - third bullet");
  });
});

describe("promptPattern.blockMatch — arrow variants", () => {
  it("accepts ASCII '->' arrow", () => {
    const lines = [
      "[script:prompt_test] +-------------------------------------+",
      "[script:prompt_test] | UPDATE AVAILABLE: 1.0.0 -> 2.0.0    |",
      "[script:prompt_test] +-------------------------------------+",
    ];
    const m = promptPattern.blockMatch(lines, 0);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.current).toBe("1.0.0");
    expect(m.announced).toBe("2.0.0");
    expect(m.canonicalSlug).toBe("prompt_test");
  });

  it("accepts ASCII '=>' arrow", () => {
    const lines = [
      "[script:prompt_test] +-------------------------------------+",
      "[script:prompt_test] | UPDATE AVAILABLE: 1.0.0 => 2.0.0    |",
      "[script:prompt_test] +-------------------------------------+",
    ];
    const m = promptPattern.blockMatch(lines, 0);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.current).toBe("1.0.0");
    expect(m.announced).toBe("2.0.0");
  });
});

describe("promptPattern.blockMatch — negative + edge cases", () => {
  it("returns null when starting line is not a +---+ border", () => {
    const lines = [
      "[script:prompt_test] | ⚠️  UPDATE AVAILABLE for [foo]: 1.0.0 → 2.0.0 |",
      "[script:prompt_test] +-------------------------------------+",
    ];
    const m = promptPattern.blockMatch(lines, 0);
    expect(m).toBeNull();
  });

  it("returns null for input with no border at all", () => {
    const lines = [
      "[script:prompt_test] | UPDATE AVAILABLE: 1.0.0 → 2.0.0 |",
      "[script:prompt_test] | just some text here             |",
    ];
    // No line is a valid opener, so every index must return null.
    for (let i = 0; i < lines.length; i++) {
      expect(promptPattern.blockMatch(lines, i)).toBeNull();
    }
  });

  it("returns null for truncated box (open + header + EOF, no closer)", () => {
    const lines = [
      "[script:prompt_test] +-------------------------------------+",
      "[script:prompt_test] | ⚠️  UPDATE AVAILABLE for [foo]: 1.0.0 → 2.0.0 |",
    ];
    const m = promptPattern.blockMatch(lines, 0);
    expect(m).toBeNull();
  });

  it("times out after 20 lines: opener + 25 unrelated '|  ...  |' rows → null", () => {
    const opener = "[script:prompt_test] +-------------------------------------+";
    const filler = Array.from(
      { length: 25 },
      (_, i) => `[script:prompt_test] |  filler ${i}                       |`
    );
    const lines = [opener, ...filler];
    const m = promptPattern.blockMatch(lines, 0);
    expect(m).toBeNull();
  });

  it("returns null when neither explicit-slug nor script-prefix token resolves", () => {
    // No `for [slug]` header AND no `[script:...]` prefix → slug cannot be
    // canonicalized → conservative drop.
    const lines = [
      "+-------------------------------------+",
      "| UPDATE AVAILABLE: 1.0.0 → 2.0.0     |",
      "+-------------------------------------+",
    ];
    const m = promptPattern.blockMatch(lines, 0);
    expect(m).toBeNull();
  });

  it("demotes untrusted URL in box to plain text in severityNote (empty trustedDomains)", () => {
    // Prompt's trustedDomains is [] — ANY URL is by definition untrusted.
    const lines = [
      "[script:prompt_test] +----------------------------------------------+",
      "[script:prompt_test] | ⚠️  UPDATE AVAILABLE for [foo]: 1.0.0 → 2.0.0 |",
      "[script:prompt_test] |  See: https://evil.tld/cl                    |",
      "[script:prompt_test] +----------------------------------------------+",
    ];
    const m = promptPattern.blockMatch(lines, 0);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.releaseNotesUrl).toBeUndefined();
    expect(m.severityNote).toBeDefined();
    expect(m.severityNote).toContain("evil.tld");
  });

  it("tolerates whitespace padding inside '| ... |' table cells", () => {
    const lines = [
      "[script:prompt_test] +-------------------------------------+",
      "[script:prompt_test] |   ⚠️  UPDATE AVAILABLE for [foo]:  1.0.0  →  2.0.0   |",
      "[script:prompt_test] +-------------------------------------+",
    ];
    const m = promptPattern.blockMatch(lines, 0);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.current).toBe("1.0.0");
    expect(m.announced).toBe("2.0.0");
    expect(m.canonicalSlug).toBe("foo");
  });
});

describe("promptPattern.blockMatch — cross-orthogonality", () => {
  // Running each non-Prompt fixture through prompt.blockMatch at EVERY start
  // index must produce null.  Prevents pattern cross-contamination.
  const siblingFixtures = [
    "codesign-cd_bridge.log",
    "codesign-cd_doorlock.log",
    "codesign-cd_dispatch.log",
    "ulc-fork-case.log",
    "quasarstore-qs-inventory.log",
    "quasarstore-qs-housing.log",
  ];

  for (const name of siblingFixtures) {
    it(`does not false-match ${name} at any start index`, () => {
      const lines = loadFixture(name);
      for (let i = 0; i < lines.length; i++) {
        const m = promptPattern.blockMatch(lines, i);
        expect(
          m,
          `unexpected match at line ${i} in ${name}: ${JSON.stringify(m)}`
        ).toBeNull();
      }
    });
  }
});

describe("promptPattern — metadata", () => {
  it("has stable id and description", () => {
    expect(promptPattern.id).toBe("prompt-v1");
    expect(promptPattern.description).toMatch(/prompt/i);
  });

  it("has empty trustedDomains (no URL surfaced in any real fixture)", () => {
    expect(promptPattern.trustedDomains).toEqual([]);
  });
});
