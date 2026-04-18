import fs from "node:fs";
import fsP from "node:fs/promises";
import crypto from "node:crypto";
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
  try {
    await new Promise<void>((resolve, reject) => {
      stream.body.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        hash.update(chunk);
        if (onProgress) onProgress(bytes);
      });
      stream.body.on("end", () => resolve());
      stream.body.on("error", reject);
      stream.body.pipe(writer);
      writer.on("error", reject);
    });
  } catch (e) {
    await fsP.unlink(tmpFile).catch(() => {});
    throw e instanceof Error ? e : new Error(String(e));
  }
  await fsP.rename(tmpFile, cacheFile);
  return { sha256: hash.digest("hex"), bytes };
}
