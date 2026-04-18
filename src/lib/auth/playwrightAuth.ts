import fs from "node:fs/promises";
import { CookieJar } from "./cookieJar.js";
import { applySecurePerms } from "./fileAuth.js";
import { PlaywrightNotInstalledError, IoError, NetworkError } from "../errors.js";
import { createLogger } from "../logger.js";

const log = createLogger();

export interface PlaywrightLoginOpts {
  cookieFile: string;
  jar: CookieJar;
  apiBase: string;
  timeoutMs?: number;
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

  // Non-persistent context — fresh profile, no leak of real Chrome cookies.
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
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
      await page.waitForTimeout(2000);
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
    await browser.close();
  }
}
