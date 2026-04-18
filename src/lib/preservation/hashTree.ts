import fs from "node:fs";
import fsP from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export interface HashTreeOpts {
  abortSignal?: AbortSignal;
}

/**
 * Walks `root` and returns a Map<relPath, sha256Hex>.
 *
 * Keys are repo-relative, forward-slash, with no leading slash or "./" prefix
 * (e.g. "config/server.lua"). Values are lowercase sha256 hex digests.
 *
 * Guarantees:
 *   - Pure: same input tree → same output map across runs.
 *   - Streaming: uses `createReadStream` + `crypto.createHash` so 10k-file packs
 *     or multi-hundred-MB files don't OOM.
 *   - Symlinks are skipped (not followed, not included) as defense-in-depth
 *     against live-dir tampering.
 *   - Empty dirs are fine — returns an empty Map (or excludes the dir from output).
 *   - `abortSignal.aborted` is honored between batches and at the file-stream level.
 *
 * @throws If `root` does not exist or is not readable (fs errors propagate).
 */
export async function hashTree(
  root: string,
  opts: HashTreeOpts = {}
): Promise<Map<string, string>> {
  const { abortSignal } = opts;
  checkAbort(abortSignal);

  // Collect all file paths first (cheap — just stat walks), then hash in
  // bounded-concurrency batches. This gives predictable memory and lets us
  // honor the abort signal between batches.
  const files: string[] = [];
  await walkCollectFiles(root, files, abortSignal);

  const map = new Map<string, string>();
  const BATCH = 8;
  for (let i = 0; i < files.length; i += BATCH) {
    checkAbort(abortSignal);
    const slice = files.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map(async (abs) => {
        const hex = await hashFileStream(abs, abortSignal);
        const rel = toForwardSlash(path.relative(root, abs));
        return [rel, hex] as const;
      })
    );
    for (const [rel, hex] of results) map.set(rel, hex);
  }

  return map;
}

async function walkCollectFiles(
  dir: string,
  out: string[],
  abortSignal: AbortSignal | undefined
): Promise<void> {
  checkAbort(abortSignal);
  const entries = await fsP.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    checkAbort(abortSignal);
    // Skip symlinks entirely — neither follow nor include.
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkCollectFiles(full, out, abortSignal);
    } else if (entry.isFile()) {
      out.push(full);
    }
    // Other types (block devices, sockets, FIFOs) are intentionally ignored.
  }
}

function hashFileStream(
  abs: string,
  abortSignal: AbortSignal | undefined
): Promise<string> {
  return new Promise((resolve, reject) => {
    checkAbort(abortSignal);
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(abs);

    const onAbort = () => {
      stream.destroy(new Error("hashTree aborted"));
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        stream.destroy();
        reject(new Error("hashTree aborted"));
        return;
      }
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    stream.on("data", (chunk: Buffer | string) => {
      hash.update(chunk);
    });
    stream.on("end", () => {
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      resolve(hash.digest("hex"));
    });
    stream.on("error", (err) => {
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

function toForwardSlash(p: string): string {
  // On POSIX path.sep === "/" so this is a no-op; on Windows path.sep === "\\".
  if (path.sep === "/") return p;
  return p.split(path.sep).join("/");
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("hashTree aborted");
  }
}
