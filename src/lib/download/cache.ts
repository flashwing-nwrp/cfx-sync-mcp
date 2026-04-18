import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function cachePath(cacheDir: string, grantId: number, versionId: number): string {
  return path.join(cacheDir, `${grantId}-${versionId}.zip`);
}

export async function verifyCacheFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = fsSync.createReadStream(file);
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return { sha256: hash.digest("hex"), bytes };
}

export async function pruneCache(cacheDir: string, keep: Set<string>): Promise<void> {
  const entries = await fs.readdir(cacheDir);
  for (const e of entries) {
    if (!e.endsWith(".zip")) continue;
    if (!keep.has(e)) await fs.unlink(path.join(cacheDir, e)).catch(() => {});
  }
}
