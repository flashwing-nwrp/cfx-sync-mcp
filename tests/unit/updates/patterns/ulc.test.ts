import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ulcPattern } from "../../../../src/lib/updates/patterns/ulc.js";

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
 * contract expects startIdx to point at the opener (`[ULC] My Version: [...]`).
 * Returns -1 if none.
 */
function findOpenerIdx(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const stripped = raw.replace(/^\[\s*script:[^\]]+\]\s?/, "");
    if (/^\[ULC\]\s+My Version:\s*\[[^\]]+\]\s*$/.test(stripped)) {
      return i;
    }
  }
  return -1;
}

describe("ulcPattern.canonicalSlug", () => {
  it("accepts bracket-wrapped token: [ULC] → ulc", () => {
    expect(ulcPattern.canonicalSlug("[ULC]")).toBe("ulc");
  });

  it("accepts lowercase bracket-wrapped: [ulc] → ulc", () => {
    expect(ulcPattern.canonicalSlug("[ulc]")).toBe("ulc");
  });

  it("accepts bare lowercase: ulc → ulc", () => {
    expect(ulcPattern.canonicalSlug("ulc")).toBe("ulc");
  });

  it("accepts bare uppercase: ULC → ulc", () => {
    expect(ulcPattern.canonicalSlug("ULC")).toBe("ulc");
  });

  it("rejects foreign vendor token: [cd_bridge] → null", () => {
    expect(ulcPattern.canonicalSlug("[cd_bridge]")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(ulcPattern.canonicalSlug("")).toBeNull();
  });

  it("rejects brackets-only", () => {
    expect(ulcPattern.canonicalSlug("[]")).toBeNull();
  });

  it("rejects script-prefixed input (caller bug)", () => {
    expect(ulcPattern.canonicalSlug("[script:ulc]")).toBeNull();
  });

  it("rejects tokens with whitespace", () => {
    expect(ulcPattern.canonicalSlug("[u l c]")).toBeNull();
  });
});

describe("ulcPattern.blockMatch — real fixture (fork case)", () => {
  it("parses ulc-fork-case: current=1.9.0, announced=v1.8.0 (v preserved), URL + severityNote captured", () => {
    const lines = loadFixture("ulc-fork-case.log");
    const idx = findOpenerIdx(lines);
    expect(idx).toBeGreaterThanOrEqual(0);

    const m = ulcPattern.blockMatch(lines, idx);
    expect(m).not.toBeNull();
    if (!m) return;

    expect(m.canonicalSlug).toBe("ulc");
    expect(m.current).toBe("1.9.0");
    // v-prefix PRESERVED — Task 9's semverCompare strips it, pattern does not.
    expect(m.announced).toBe("v1.8.0");
    expect(m.releaseNotesUrl).toBe(
      "https://github.com/Flohhhhh/ultimate-lighting-controller/releases/"
    );
    expect(m.severityNote).toBeDefined();
    expect(m.severityNote).toContain(
      "OUTDATED. A NEW VERSION (v1.8.0) IS AVAILABLE."
    );
    expect(m.patternId).toBe("ulc-v1");
    expect(m.linesConsumed).toBeGreaterThan(0);
  });

  it("announced field preserves leading v (no v-strip inside pattern)", () => {
    const lines = loadFixture("ulc-fork-case.log");
    const idx = findOpenerIdx(lines);
    const m = ulcPattern.blockMatch(lines, idx);
    expect(m).not.toBeNull();
    if (!m) return;
    // Explicit guardrail — if someone adds a v-strip later this catches it.
    expect(m.announced.startsWith("v")).toBe(true);
    expect(m.announced).not.toBe("1.8.0");
  });
});

describe("ulcPattern.blockMatch — adversarial + edge cases", () => {
  it("demotes an untrusted URL (evil.tld) to severityNote, no releaseNotesUrl", () => {
    const lines = [
      "[          script:ulc] [ULC] My Version: [1.0.0]",
      "[          script:ulc] [ULC] Latest Version: [1.1.0]",
      "[          script:ulc] [ULC] OUTDATED. A NEW VERSION (1.1.0) IS AVAILABLE.",
      "[          script:ulc] [ULC] GET LATEST VERSION HERE: https://evil.tld/thing",
    ];
    const m = ulcPattern.blockMatch(lines, 0);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.releaseNotesUrl).toBeUndefined();
    expect(m.severityNote).toBeDefined();
    expect(m.severityNote).toContain("evil.tld");
  });

  it("rejects github.com subdomain: raw.githubusercontent.com is NOT trusted", () => {
    // Exact-host-equality: github.com allowlist does not cover raw.githubusercontent.com.
    const lines = [
      "[          script:ulc] [ULC] My Version: [1.0.0]",
      "[          script:ulc] [ULC] Latest Version: [1.1.0]",
      "[          script:ulc] [ULC] GET LATEST VERSION HERE: https://raw.githubusercontent.com/foo/bar/main/README.md",
    ];
    const m = ulcPattern.blockMatch(lines, 0);
    expect(m).not.toBeNull();
    if (!m) return;
    expect(m.releaseNotesUrl).toBeUndefined();
    expect(m.severityNote).toBeDefined();
    expect(m.severityNote).toContain("raw.githubusercontent.com");
  });

  it("only Part A present (no Part B / URL ever arrives) → null (walkBlock times out)", () => {
    // Pattern completes on the URL line. Without one, walkBlock's EOF path returns null.
    // Committed behavior: null. If you want to expose this emission path you must
    // change the pattern AND update this test together.
    const lines = [
      "[          script:ulc] [ULC] My Version: [1.0.0]",
      "[          script:ulc] [ULC] Latest Version: [1.1.0]",
    ];
    const m = ulcPattern.blockMatch(lines, 0);
    expect(m).toBeNull();
  });

  it("missing 'Latest Version:' line → null (no announced)", () => {
    const lines = [
      "[          script:ulc] [ULC] My Version: [1.0.0]",
      "[          script:ulc] [ULC] some unrelated narrative",
      "[          script:ulc] [ULC] more narrative",
      "[          script:ulc] [ULC] GET LATEST VERSION HERE: https://github.com/foo/bar",
    ];
    const m = ulcPattern.blockMatch(lines, 0);
    expect(m).toBeNull();
  });

  it("block timeout: opener + 30 filler lines with no URL → null", () => {
    const opener = "[          script:ulc] [ULC] My Version: [1.0.0]";
    const filler = Array.from(
      { length: 30 },
      (_, i) => `[          script:ulc] banner filler ${i}`
    );
    const m = ulcPattern.blockMatch([opener, ...filler], 0);
    expect(m).toBeNull();
  });

  it("newline-smuggling: opener with embedded \\n cannot smuggle in Latest Version", () => {
    // A single array element with embedded \n must NOT be split into two logical
    // lines.  The My-Version regex is anchored ^...$ without the /m flag so an
    // embedded newline inside the captured group fails to match.
    const lines = [
      "[          script:ulc] [ULC] My Version: [1.0.0]\n[ULC] Latest Version: [2.0.0]",
      "[          script:ulc] [ULC] GET LATEST VERSION HERE: https://github.com/foo/bar",
    ];
    const m = ulcPattern.blockMatch(lines, 0);
    // Opener must fail to match (embedded newline pollutes the captured version),
    // OR it matches the first line only, no Latest Version ever arrives, and
    // walkBlock times out returning null.  Either way: null.
    expect(m).toBeNull();
  });
});

describe("ulcPattern.blockMatch — cross-orthogonality", () => {
  const siblingFixtures = [
    "codesign-cd_bridge.log",
    "codesign-cd_doorlock.log",
    "codesign-cd_dispatch.log",
    "prompt-sandy_illegal_garage.log",
    "prompt-sandy_mechanic.log",
    "quasarstore-qs-inventory.log",
    "quasarstore-qs-housing.log",
  ];

  for (const name of siblingFixtures) {
    it(`does not false-match ${name} at any start index`, () => {
      const lines = loadFixture(name);
      for (let i = 0; i < lines.length; i++) {
        const m = ulcPattern.blockMatch(lines, i);
        expect(
          m,
          `unexpected match at line ${i} in ${name}: ${JSON.stringify(m)}`
        ).toBeNull();
      }
    });
  }
});

describe("ulcPattern — metadata", () => {
  it("has stable id ulc-v1", () => {
    expect(ulcPattern.id).toBe("ulc-v1");
  });

  it("description mentions ULC / Dawnstar / fork-case", () => {
    expect(ulcPattern.description).toMatch(/ulc/i);
    expect(ulcPattern.description).toMatch(/dawnstar/i);
  });

  it("trustedDomains = [github.com]", () => {
    expect(ulcPattern.trustedDomains).toEqual(["github.com"]);
  });
});
