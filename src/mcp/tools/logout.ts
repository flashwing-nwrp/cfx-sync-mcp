import type { z } from "zod";
import type { LogoutOutput } from "../schemas/index.js";
import { loadConfig } from "../../lib/config.js";
import { wipeCookieFile } from "../../lib/auth/fileAuth.js";

export async function cfx_logout(): Promise<z.infer<typeof LogoutOutput>> {
  const cfg = loadConfig();
  await wipeCookieFile(cfg.cookieFile);
  return { wiped: true };
}
