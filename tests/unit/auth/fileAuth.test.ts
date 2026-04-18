import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadCookiesFromFile, wipeCookieFile, applySecurePerms } from "../../../src/lib/auth/fileAuth.js";
import { CookieJar } from "../../../src/lib/auth/cookieJar.js";
import { AuthMissingError, IoError } from "../../../src/lib/errors.js";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn().mockReturnValue(Buffer.from("")) };
});

describe("fileAuth", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cfx-fauth-"));
    file = path.join(dir, "cookies.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("throws AuthMissingError when file absent", async () => {
    const jar = new CookieJar();
    await expect(loadCookiesFromFile(file, jar)).rejects.toBeInstanceOf(AuthMissingError);
  });

  it("loads Playwright-format cookies into the jar", async () => {
    writeFileSync(
      file,
      JSON.stringify([
        {
          name: "session", value: "abc", domain: ".cfx.re",
          path: "/", expires: 999999999, httpOnly: true, secure: true, sameSite: "Lax",
        },
      ])
    );
    const jar = new CookieJar();
    await loadCookiesFromFile(file, jar);
    expect(jar.count()).toBe(1);
    expect(jar.headerFor("https://portal.cfx.re/")).toBe("session=abc");
  });

  it("accepts {cookies: [...]} storage-state shape", async () => {
    writeFileSync(
      file,
      JSON.stringify({
        cookies: [
          { name: "a", value: "b", domain: ".cfx.re", path: "/", expires: 1, httpOnly: true, secure: true, sameSite: "Lax" },
        ],
        origins: [],
      })
    );
    const jar = new CookieJar();
    await loadCookiesFromFile(file, jar);
    expect(jar.count()).toBe(1);
  });

  it("wipeCookieFile() removes the file", async () => {
    writeFileSync(file, "[]");
    await wipeCookieFile(file);
    expect(existsSync(file)).toBe(false);
  });

  it("applySecurePerms on POSIX calls chmod 600", async () => {
    if (process.platform === "win32") return; // tested separately
    writeFileSync(file, "[]");
    await applySecurePerms(file);
    const fs = await import("node:fs/promises");
    const stat = await fs.stat(file);
    // mode low 9 bits
    expect((stat.mode & 0o777).toString(8)).toBe("600");
  });

  it("applySecurePerms on Windows uses icacls", async () => {
    if (process.platform !== "win32") return;
    writeFileSync(file, "[]");
    vi.mocked(childProcess.execFileSync).mockClear();
    await applySecurePerms(file);
    expect(childProcess.execFileSync).toHaveBeenCalledWith(
      "icacls",
      expect.arrayContaining([file, "/inheritance:r"]),
      expect.anything()
    );
  });
});
