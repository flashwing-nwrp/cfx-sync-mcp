import { describe, it, expect } from "vitest";
import { detectPlaywrightInstalled } from "../../../src/lib/auth/playwrightAuth.js";

describe("playwrightAuth", () => {
  it("detectPlaywrightInstalled returns boolean", async () => {
    expect(typeof detectPlaywrightInstalled).toBe("function");
    const installed = await detectPlaywrightInstalled();
    expect(typeof installed).toBe("boolean");
  });

  it("detectPlaywrightInstalled returns false when chromium missing (CI default)", async () => {
    // PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 is set in .npmrc; CI has no chromium.
    // Local dev may or may not have it installed.
    const installed = await detectPlaywrightInstalled();
    if (!process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
      expect(installed).toBe(false);
    }
  });
});
