import { describe, it, expect } from "vitest";
import { detectPlaywrightInstalled } from "../../../src/lib/auth/playwrightAuth.js";

describe("playwrightAuth", () => {
  it("detectPlaywrightInstalled returns boolean", async () => {
    expect(typeof detectPlaywrightInstalled).toBe("function");
    const installed = await detectPlaywrightInstalled();
    expect(typeof installed).toBe("boolean");
  });

  it("detectPlaywrightInstalled reflects actual on-disk state", async () => {
    // Test just verifies the function correctly reports what's on disk.
    // CI with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 → false. Dev with
    // `npx playwright install chromium` run → true. Both valid; we just
    // assert the function resolves to a boolean and matches the filesystem.
    const { chromium } = await import("playwright");
    const exePath = chromium.executablePath();
    const fs = await import("node:fs/promises");
    let expected = false;
    if (exePath) {
      try { await fs.stat(exePath); expected = true; } catch { expected = false; }
    }
    const installed = await detectPlaywrightInstalled();
    expect(installed).toBe(expected);
  });
});
