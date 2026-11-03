import fs from "node:fs";
import fsP from "node:fs/promises";
import crypto from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DownloadClient } from "../portal/downloadClient.js";
import { NetworkError } from "../errors.js";

export interface DownloadPackOpts {
  client: DownloadClient;
  url: URL;
  cacheFile: string;
  onProgress?: (bytes: number) => void;
}

export interface DownloadResult {
  sha256: string;
  bytes: number;
}

export async function downloadPack(opts: DownloadPackOpts): Promise<DownloadResult> {
  const { client, url, cacheFile, onProgress } = opts;
  const tmpFile = cacheFile + ".part";
  const hash = crypto.createHash("sha256");
  let bytes = 0;

  const stream = await client.streamPresignedDownload(url);
  if (stream.statusCode < 200 || stream.statusCode >= 300) {
    throw new NetworkError(`Download returned status ${stream.statusCode}`);
  }

  const writer = fs.createWriteStream(tmpFile);
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      hash.update(chunk);
      if (onProgress) onProgress(bytes);
      cb(null, chunk);
    },
  });
  try {
    // pipeline resolves only once the writer has flushed and closed, so the
    // rename below never races in-flight writes (the source's "end" is too early).
    await pipeline(stream.body, tap, writer);
  } catch (e) {
    await fsP.unlink(tmpFile).catch(() => {});
    throw e instanceof Error ? e : new Error(String(e));
  }
  await fsP.rename(tmpFile, cacheFile);
  return { sha256: hash.digest("hex"), bytes };
}
