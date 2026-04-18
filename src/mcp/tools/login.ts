import type { z } from "zod";
import type { LoginInput, LoginOutput } from "../schemas/index.js";
import { loadConfig } from "../../lib/config.js";
import { CookieJar } from "../../lib/auth/cookieJar.js";
import { loadCookiesFromFile } from "../../lib/auth/fileAuth.js";
import { playwrightLogin } from "../../lib/auth/playwrightAuth.js";
import { PortalApiClient } from "../../lib/portal/client.js";

export async function cfx_login(
  input: z.infer<typeof LoginInput>
): Promise<z.infer<typeof LoginOutput>> {
  const cfg = loadConfig();
  const jar = new CookieJar();

  if (cfg.authMode === "playwright") {
    const r = await playwrightLogin({
      cookieFile: cfg.cookieFile,
      jar,
      apiBase: cfg.apiBase,
      timeoutMs: (input.timeoutMinutes ?? 5) * 60_000,
      profileDir: cfg.playwrightProfileDir,
    });
    return {
      username: r.username,
      cookieCount: r.cookieCount,
      expiresAtHint: r.expiresAtHint,
      storageStatePath: cfg.cookieFile,
    };
  }

  // file mode — validate that the file exists + probe /v1/me
  await loadCookiesFromFile(cfg.cookieFile, jar);
  const client = new PortalApiClient({ apiBase: cfg.apiBase, cookieJar: jar });
  const me = await client.getMe();
  return {
    username: me.username,
    cookieCount: jar.count(),
    expiresAtHint: jar.longestExpiry(),
    storageStatePath: cfg.cookieFile,
  };
}
