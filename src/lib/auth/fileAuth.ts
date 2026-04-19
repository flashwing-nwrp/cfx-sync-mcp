import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { CookieJar, type CookieEntry } from "./cookieJar.js";
import { AuthMissingError, IoError } from "../errors.js";

export async function loadCookiesFromFile(
  file: string,
  jar: CookieJar
): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") throw new AuthMissingError(`Cookie file not found: ${file}`);
    throw new IoError(`Failed to read cookie file: ${err.message}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (e) {
    throw new IoError(`Cookie file is not valid JSON: ${(e as Error).message}`);
  }
  let cookies: CookieEntry[];
  if (Array.isArray(parsed)) {
    cookies = parsed as CookieEntry[];
  } else if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { cookies?: unknown }).cookies)
  ) {
    cookies = (parsed as { cookies: CookieEntry[] }).cookies;
  } else {
    throw new IoError(`Cookie file has unexpected shape (expected array or { cookies: [...] })`);
  }
  // Validate each entry has the minimum required fields. Without this,
  // a corrupt cookie file would silently populate the jar with garbage
  // and `headerFor` could throw at request time with a confusing error.
  for (let i = 0; i < cookies.length; i++) {
    const c = cookies[i] as unknown as Record<string, unknown>;
    if (!c || typeof c.name !== "string" || typeof c.value !== "string" || typeof c.domain !== "string") {
      throw new IoError(`Cookie file entry at index ${i} is missing required fields (name, value, domain)`);
    }
  }
  jar.replaceAll(cookies);
}

export async function wipeCookieFile(file: string): Promise<void> {
  try { await fs.unlink(file); } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw new IoError(err.message);
  }
}

export async function applySecurePerms(file: string): Promise<void> {
  if (process.platform === "win32") {
    // icacls strips inherited ACLs, grants full control only to current user
    const user = os.userInfo().username;
    try {
      execFileSync("icacls", [file, "/inheritance:r"], { stdio: "ignore" });
      execFileSync("icacls", [file, "/grant:r", `${user}:F`], { stdio: "ignore" });
    } catch (e) {
      throw new IoError(`icacls failed: ${(e as Error).message}`);
    }
  } else {
    try {
      await fs.chmod(file, 0o600);
    } catch (e) {
      throw new IoError(`chmod 600 failed: ${(e as Error).message}`);
    }
  }
}
