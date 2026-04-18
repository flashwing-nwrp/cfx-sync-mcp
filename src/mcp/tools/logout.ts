import type { z } from "zod";
import type { LogoutOutput } from "../schemas/index.js";
import { loadConfig } from "../../lib/config.js";
import { wipeCookieFile } from "../../lib/auth/fileAuth.js";
import { wipePlaywrightProfile } from "../../lib/auth/playwrightAuth.js";

export async function cfx_logout(): Promise<z.infer<typeof LogoutOutput>> {
  const cfg = loadConfig();
  await wipeCookieFile(cfg.cookieFile);
  // Also wipe the Playwright persistent profile so the next `cfx_login`
  // starts clean. Cfx will treat it as a new device and re-prompt for
  // email verification — that's the intended semantics of logout.
  await wipePlaywrightProfile(cfg.playwrightProfileDir);
  return { wiped: true };
}
