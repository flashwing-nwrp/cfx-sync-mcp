import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

const launch = vi.fn();
const launchPersistentContext = vi.fn();
vi.mock("playwright", () => ({ chromium: { launch, launchPersistentContext } }));

const { playwrightLogin } = await import("../../../src/lib/auth/playwrightAuth.js");
const { CookieJar } = await import("../../../src/lib/auth/cookieJar.js");
const { PlaywrightNotInstalledError } = await import("../../../src/lib/errors.js");

function opts(profileDir?: string) {
  return {
    cookieFile: path.join(os.tmpdir(), "cfx-sync-test-cookies.json"),
    jar: new CookieJar(),
    apiBase: "https://portal-api.invalid",
    timeoutMs: 1,
    profileDir,
  };
}

// Playwright's own wording when a channel's executable is missing
// (playwright-core lib/server/registry/index.js).
const notFound = () => new Error("Chromium distribution 'chrome' is not found at C:\\x\\chrome.exe");

describe("playwrightLogin browser selection", () => {
  beforeEach(() => { launch.mockReset(); launchPersistentContext.mockReset(); });

  it("launches system Chrome (channel 'chrome'), never bundled Chromium", async () => {
    launch.mockRejectedValue(new Error("stop"));
    await expect(playwrightLogin(opts())).rejects.toThrow("stop");
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ channel: "chrome", headless: false }));
  });

  it("persistent-profile path also uses system Chrome", async () => {
    launchPersistentContext.mockRejectedValue(new Error("stop"));
    const dir = path.join(os.tmpdir(), "cfx-sync-test-profile");
    await expect(playwrightLogin(opts(dir))).rejects.toThrow("stop");
    expect(launchPersistentContext).toHaveBeenCalledWith(dir, expect.objectContaining({ channel: "chrome" }));
  });

  it("maps a missing Chrome install to PlaywrightNotInstalledError (no bundled fallback)", async () => {
    launch.mockRejectedValue(notFound());
    await expect(playwrightLogin(opts())).rejects.toBeInstanceOf(PlaywrightNotInstalledError);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("rethrows unrelated launch errors unchanged", async () => {
    launch.mockRejectedValue(new Error("Target page, context or browser has been closed"));
    await expect(playwrightLogin(opts())).rejects.toThrow("has been closed");
  });
});
