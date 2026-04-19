import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { parseNotices } from "../../../src/lib/updates/logScraper.js";
import { PATTERNS } from "../../../src/lib/updates/patterns/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "../../fixtures/log-snippets");

function loadFixture(name: string): string[] {
  const raw = readFileSync(resolve(FIXTURES, name), "utf8");
  const lines = raw.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

describe("parseNotices — happy-path & real fixtures", () => {
  it("parses a single synthetic Codesign notice", () => {
    const lines = [
      "[    script:cd_bridge] ===================================================================",
      "[    script:cd_bridge] [cd_bridge] - New Update Available!",
      "[    script:cd_bridge] Current Version: 1.0.23.",
      "[    script:cd_bridge] New Version: 1.0.26.",
      "[    script:cd_bridge] Released: 5 days ago.",
      "[    script:cd_bridge] Notes: Another Major Update - Please Update.",
      "[    script:cd_bridge] Changelog: https://docs.codesign.pro/paid-scripts/bridge/changelog.",
      "[    script:cd_bridge] ===================================================================",
    ];
    const result = parseNotices(lines, PATTERNS);
    expect(result.notices).toHaveLength(1);
    const n = result.notices[0]!;
    expect(n.canonicalSlug).toBe("cd_bridge");
    expect(n.current).toBe("1.0.23");
    expect(n.announced).toBe("1.0.26");
    expect(n.patternId).toBe("codesign-v1");
    expect(result.scannedLogLines).toBe(lines.length);
    expect(result.logHasStartupBoundary).toBe(false);
  });

  it("parses the real cd_bridge fixture end-to-end", () => {
    const lines = loadFixture("codesign-cd_bridge.log");
    const result = parseNotices(lines, PATTERNS);
    expect(result.notices).toHaveLength(1);
    const n = result.notices[0]!;
    expect(n.canonicalSlug).toBe("cd_bridge");
    expect(n.current).toBe("1.0.23");
    expect(n.announced).toBe("1.0.26");
    expect(n.patternId).toBe("codesign-v1");
    expect(result.scannedLogLines).toBe(lines.length);
  });

  it("captures both notices when two Codesign fixtures are concatenated", () => {
    const a = loadFixture("codesign-cd_bridge.log");
    const b = loadFixture("codesign-cd_doorlock.log");
    const lines = [...a, ...b];
    const result = parseNotices(lines, PATTERNS);
    expect(result.notices).toHaveLength(2);
    const slugs = result.notices.map((n) => n.canonicalSlug).sort();
    expect(slugs).toEqual(["cd_bridge", "cd_doorlock"]);
  });
});

describe("parseNotices — dedup by (slug, current, announced)", () => {
  it("collapses duplicate (cd_bridge, 1.0.23, 1.0.26) to one notice", () => {
    const a = loadFixture("codesign-cd_bridge.log");
    const lines = [...a, ...a];
    const result = parseNotices(lines, PATTERNS);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]!.canonicalSlug).toBe("cd_bridge");
    // Both occurrences were parsed — scannedLogLines still reflects full input.
    expect(result.scannedLogLines).toBe(lines.length);
  });

  it("keeps distinct triples separate even for the same slug", () => {
    // Two cd_bridge blocks with different version pairs → two notices.
    const lines = [
      // First block: 1.0.22 → 1.0.25
      "[    script:cd_bridge] ===================================================================",
      "[    script:cd_bridge] [cd_bridge] - New Update Available!",
      "[    script:cd_bridge] Current Version: 1.0.22.",
      "[    script:cd_bridge] New Version: 1.0.25.",
      "[    script:cd_bridge] ===================================================================",
      // Second block: 1.0.23 → 1.0.26
      "[    script:cd_bridge] ===================================================================",
      "[    script:cd_bridge] [cd_bridge] - New Update Available!",
      "[    script:cd_bridge] Current Version: 1.0.23.",
      "[    script:cd_bridge] New Version: 1.0.26.",
      "[    script:cd_bridge] ===================================================================",
    ];
    const result = parseNotices(lines, PATTERNS);
    expect(result.notices).toHaveLength(2);
    const triples = result.notices
      .map((n) => `${n.canonicalSlug}|${n.current}|${n.announced}`)
      .sort();
    expect(triples).toEqual([
      "cd_bridge|1.0.22|1.0.25",
      "cd_bridge|1.0.23|1.0.26",
    ]);
  });
});

describe("parseNotices — startup boundary detection", () => {
  it("sets logHasStartupBoundary=true when a 'Started resource <slug>' line is present", () => {
    const lines = [
      "[           resources] Started resource qbx_core",
      "[           resources] Started resource ox_lib",
    ];
    const result = parseNotices(lines, PATTERNS);
    expect(result.logHasStartupBoundary).toBe(true);
    expect(result.notices).toHaveLength(0);
  });

  it("sets logHasStartupBoundary=false when no boundary line is present", () => {
    const lines = [
      "[    script:cd_bridge] some unrelated log line",
      "[    script:cd_bridge] another unrelated log line",
    ];
    const result = parseNotices(lines, PATTERNS);
    expect(result.logHasStartupBoundary).toBe(false);
  });

  it("detects boundary independently of pattern matching", () => {
    // A notice AND a boundary line in the same input.
    const lines = [
      "[           resources] Started resource cd_bridge",
      "[    script:cd_bridge] ===================================================================",
      "[    script:cd_bridge] [cd_bridge] - New Update Available!",
      "[    script:cd_bridge] Current Version: 1.0.23.",
      "[    script:cd_bridge] New Version: 1.0.26.",
      "[    script:cd_bridge] ===================================================================",
    ];
    const result = parseNotices(lines, PATTERNS);
    expect(result.logHasStartupBoundary).toBe(true);
    expect(result.notices).toHaveLength(1);
  });
});

describe("parseNotices — empty / edge inputs", () => {
  it("handles empty input", () => {
    const result = parseNotices([], PATTERNS);
    expect(result.notices).toEqual([]);
    expect(result.scannedLogLines).toBe(0);
    expect(result.logHasStartupBoundary).toBe(false);
  });

  it("scannedLogLines === lines.length exactly", () => {
    const lines = Array.from({ length: 137 }, (_, i) => `noise ${i}`);
    const result = parseNotices(lines, PATTERNS);
    expect(result.scannedLogLines).toBe(137);
    expect(result.notices).toEqual([]);
  });
});

describe("parseNotices — full FLRP boot fixture", () => {
  it("matches multiple notices across ≥2 patterns in a 2000-line boot log", () => {
    const lines = loadFixture("flrp-boot-2000.log");
    const result = parseNotices(lines, PATTERNS);

    // Real boot window: Codesign (cd_bridge, cd_doorlock, cd_dispatch), ULC,
    // quasarstore (qs-advancedinventory, qs-housing), Prompt (Variant A + B).
    // We assert ≥3 notices spanning ≥2 pattern ids — stable under fixture
    // churn but still demonstrates the multi-pattern walk.
    expect(result.notices.length).toBeGreaterThanOrEqual(3);

    const distinctPatternIds = new Set(result.notices.map((n) => n.patternId));
    expect(distinctPatternIds.size).toBeGreaterThanOrEqual(2);

    // Codesign + ULC were both in the real capture — assert them explicitly
    // so regressions in the walker's pattern dispatch surface here.
    expect(distinctPatternIds.has("codesign-v1")).toBe(true);
    expect(distinctPatternIds.has("ulc-v1")).toBe(true);

    expect(result.logHasStartupBoundary).toBe(true);
    expect(result.scannedLogLines).toBe(lines.length);
  });
});

describe("parseNotices — adversarial / ReDoS probes", () => {
  it("completes on a single 100KB line within a generous 500ms budget", () => {
    const huge = "x".repeat(100_000);
    const start = performance.now();
    const result = parseNotices([huge], PATTERNS);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(result.notices).toEqual([]);
    expect(result.scannedLogLines).toBe(1);
  });

  it("rejects newline-smuggled composite line (no pattern false-matches)", () => {
    // The whole block crammed into a single array element — anchored regexes
    // inside each pattern's blockMatch MUST NOT treat embedded \n as a line
    // separator.  Expect zero matches.
    const smuggled =
      "[cd_bridge] - New Update Available!\nCurrent Version: 1.0.0.\nNew Version: 1.0.1.\n=====================================================================";
    const result = parseNotices([smuggled], PATTERNS);
    expect(result.notices).toEqual([]);
  });

  it("finds the notice when wrapped with 50 lines of unrelated noise on each side", () => {
    const noiseBefore = Array.from({ length: 50 }, (_, i) => `noise-before-${i}`);
    const noiseAfter = Array.from({ length: 50 }, (_, i) => `noise-after-${i}`);
    const notice = loadFixture("codesign-cd_bridge.log");
    const lines = [...noiseBefore, ...notice, ...noiseAfter];
    const result = parseNotices(lines, PATTERNS);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]!.canonicalSlug).toBe("cd_bridge");
    expect(result.notices[0]!.current).toBe("1.0.23");
    expect(result.notices[0]!.announced).toBe("1.0.26");
  });
});
