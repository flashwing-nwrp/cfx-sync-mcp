import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { downloadPack } from "../../../src/lib/download/downloader.js";
import { DownloadClient } from "../../../src/lib/portal/downloadClient.js";
import { CookieJar } from "../../../src/lib/auth/cookieJar.js";

describe("downloadPack", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "cfx-dl-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("streams body to cache path + returns sha256", async () => {
    const client = new DownloadClient({
      apiBase: "https://portal-api.cfx.re",
      cookieJar: new CookieJar(),
    });
    // Stub streamDownload directly
    (client as any).streamPresignedDownload = async () => ({
      statusCode: 200,
      contentLength: 5,
      body: Readable.from(Buffer.from("hello")),
    });

    const destination = path.join(dir, "1-1.zip");
    const out = await downloadPack({
      client,
      url: new URL("https://content-scw.cfx.re/assets/x/y?sig=stub"),
      cacheFile: destination,
    });
    expect(out.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(out.bytes).toBe(5);
    expect(readFileSync(destination, "utf8")).toBe("hello");
  });

  it("cleans up partial file on error", async () => {
    const client = new DownloadClient({
      apiBase: "https://portal-api.cfx.re",
      cookieJar: new CookieJar(),
    });
    (client as any).streamPresignedDownload = async () => ({
      statusCode: 200,
      contentLength: null,
      body: new Readable({ read() { this.destroy(new Error("simulated stall")); } }),
    });

    const destination = path.join(dir, "1-1.zip");
    await expect(
      downloadPack({
        client,
        url: new URL("https://content-scw.cfx.re/assets/x/y?sig=stub"),
        cacheFile: destination,
      })
    ).rejects.toThrow();
    expect(existsSync(destination)).toBe(false); // partial cleaned up
  });
});
