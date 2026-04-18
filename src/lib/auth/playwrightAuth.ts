import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { CookieJar } from "./cookieJar.js";
import { applySecurePerms } from "./fileAuth.js";
import { PlaywrightNotInstalledError, NetworkError } from "../errors.js";
import { createLogger } from "../logger.js";

const log = createLogger();

export interface PlaywrightLoginOpts {
  cookieFile: string;
  jar: CookieJar;
  apiBase: string;
  timeoutMs?: number;
  // Dedicated Chromium profile dir, isolated from user's real Chrome (D12) but
  // persistent between logins so Cfx doesn't re-trigger email device-verification
  // on every login. Absence of this arg falls back to a non-persistent context.
  profileDir?: string;
}

export interface PlaywrightLoginResult {
  username: string;
  cookieCount: number;
  expiresAtHint: number | null;
}

export async function detectPlaywrightInstalled(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    const exePath = chromium.executablePath();
    if (!exePath) return false;
    try { await fs.stat(exePath); return true; } catch { return false; }
  } catch { return false; }
}

export async function playwrightLogin(opts: PlaywrightLoginOpts): Promise<PlaywrightLoginResult> {
  if (!(await detectPlaywrightInstalled())) {
    throw new PlaywrightNotInstalledError();
  }

  const { chromium } = await import("playwright");
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  // D12 (clarified): context is isolated from the user's real Chrome profile.
  // When profileDir is supplied, we persist THIS dedicated profile between
  // logins so Cfx's device-verification prompt fires once (first login) rather
  // than every time. The profile still contains NO data from user's real
  // Chrome — just this tool's session cookies.
  const useProfile = typeof opts.profileDir === "string" && opts.profileDir.length > 0;
  if (useProfile) {
    // Ensure profile dir exists with 0o700 perms so only the owner can read it.
    fsSync.mkdirSync(opts.profileDir!, { recursive: true, mode: 0o700 });
  }

  const context = useProfile
    ? await chromium.launchPersistentContext(opts.profileDir!, { headless: false })
    : await (await chromium.launch({ headless: false })).newContext();

  try {
    // Persistent contexts pre-create an about:blank page; reuse it.
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto("https://portal.cfx.re/login", { waitUntil: "domcontentloaded" });

    const deadline = Date.now() + timeoutMs;
    let username: string | null = null;

    while (Date.now() < deadline) {
      try {
        const res = await page.request.get(`${opts.apiBase}/v1/me`);
        if (res.ok()) {
          const me = await res.json();
          if (typeof me?.username === "string") {
            username = me.username;
            break;
          }
        }
      } catch { /* not yet logged in; keep polling */ }
      try {
        await page.waitForTimeout(2000);
      } catch {
        // Page/context may have been closed manually by operator.
        break;
      }
    }
    if (!username) throw new NetworkError(`Timed out waiting for login after ${timeoutMs}ms`);

    const storage = await context.storageState();
    opts.jar.replaceAll(storage.cookies as any);

    // Persist cookies to disk and lock down perms.
    await fs.writeFile(opts.cookieFile, JSON.stringify(storage, null, 2), { mode: 0o600 });
    await applySecurePerms(opts.cookieFile);

    log.info({ event: "login_success", count: storage.cookies.length });
    return {
      username,
      cookieCount: storage.cookies.length,
      expiresAtHint: opts.jar.longestExpiry(),
    };
  } finally {
    // In persistent-context mode we only have a context (no separate browser
    // handle). Closing the context closes its underlying browser.
    await context.close();
    // Fence: dedicated profile stays on disk between runs by design.
    // Use `cfx_logout` to clear it (see below).
    // Avoid path traversal: we only wipe cookies from the jar here, not the profile.
    void path; // keep import hot for future use
  }
}

// Helper for cfx_logout to wipe the Playwright profile along with the cookie file.
export async function wipePlaywrightProfile(profileDir: string): Promise<void> {
  try {
    await fs.rm(profileDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}
