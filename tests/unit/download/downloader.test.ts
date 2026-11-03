import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs, { mkdtempSync, rmSync, readFileSync, existsSync, statSync, appendFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
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
    // Stub private streamPresignedDownload — test harness override, not public API.
    (client as unknown as { streamPresignedDownload: () => Promise<unknown> }).streamPresignedDownload = async () => ({
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

  it("returns only after the file is fully flushed to disk", async () => {
    // Regression: downloadPack used to resolve on the SOURCE's "end" event,
    // before the fs write stream flushed — callers could read a truncated pack.
    const client = new DownloadClient({
      apiBase: "https://portal-api.cfx.re",
      cookieJar: new CookieJar(),
    });
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const chunks = Array.from({ length: 8 }, () => chunk);
    (client as unknown as { streamPresignedDownload: () => Promise<unknown> }).streamPresignedDownload = async () => ({
      statusCode: 200,
      contentLength: chunk.length * chunks.length,
      body: Readable.from(chunks),
    });
    // A disk that acknowledges each write 10ms late makes the race
    // deterministic: the source ends while the last writes are in flight.
    const spy = vi.spyOn(fs, "createWriteStream").mockImplementation(((p: string) =>
      new Writable({
        write(c: Buffer, _enc, cb) {
          setTimeout(() => { appendFileSync(p, c); cb(); }, 10);
        },
      })) as unknown as typeof fs.createWriteStream);

    try {
      const destination = path.join(dir, "big.zip");
      const out = await downloadPack({
        client,
        url: new URL("https://content-scw.cfx.re/assets/x/y?sig=stub"),
        cacheFile: destination,
      });
      expect(out.bytes).toBe(chunk.length * chunks.length);
      expect(statSync(destination).size).toBe(out.bytes);
      expect(existsSync(destination + ".part")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("cleans up partial file on error", async () => {
    const client = new DownloadClient({
      apiBase: "https://portal-api.cfx.re",
      cookieJar: new CookieJar(),
    });
    (client as unknown as { streamPresignedDownload: () => Promise<unknown> }).streamPresignedDownload = async () => ({
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
