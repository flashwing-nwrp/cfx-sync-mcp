import fs from "node:fs";
import fsP from "node:fs/promises";
import path from "node:path";
import { open as yauzlOpen } from "yauzl-promise";
import { ValidationFailedError } from "../errors.js";

export interface UnzipResult {
  root: string;
}

// Extracts a zip into <stagingRoot>/<basename>-<counter>/ with these guarantees:
//   - No entry resolves outside the staging root (zip-slip)
//   - Symlink entries are refused
//   - Absolute paths are refused
//   - If the zip wraps everything in a single top-level dir, contents are
//     flattened (hoisted one level) so the staging root holds fxmanifest.lua directly.
export async function unzipToStaging(zipFile: string, stagingRoot: string): Promise<UnzipResult> {
  await fsP.mkdir(stagingRoot, { recursive: true });
  const stagingBase = path.join(stagingRoot, `extract-${Date.now()}-${process.pid}`);
  await fsP.mkdir(stagingBase);

  // validateFilenames: true (default) — yauzl will throw on `../` and absolute paths
  // during entry iteration. We catch those and rethrow as ValidationFailedError below.
  const zip = await yauzlOpen(zipFile);
  let hadFiles = false;

  try {
    try {
      for await (const entry of zip) {
        const rawName = entry.filename;

        // Defense-in-depth: reject absolute paths + drive letters before path.resolve
        // (yauzl validateFilenames may already have caught these via assert, but guard anyway)
        if (path.isAbsolute(rawName) || /^[a-zA-Z]:/.test(rawName)) {
          throw new ValidationFailedError(`Zip entry has absolute path: ${rawName}`);
        }

        // Normalize and verify containment (zip-slip guard)
        const dest = path.resolve(stagingBase, rawName);
        if (!dest.startsWith(stagingBase + path.sep) && dest !== stagingBase) {
          throw new ValidationFailedError(`Zip entry escapes staging root: ${rawName}`);
        }

        if (entry.filename.endsWith("/")) {
          await fsP.mkdir(dest, { recursive: true });
          continue;
        }

        // Reject symlinks (yauzl exposes external file attrs — upper 16 bits are Unix mode)
        const externalAttrs = entry.externalFileAttributes >>> 16;
        const isSymlink = (externalAttrs & 0o170000) === 0o120000;
        if (isSymlink) {
          throw new ValidationFailedError(`Zip entry is a symlink: ${rawName}`);
        }

        hadFiles = true;

        await fsP.mkdir(path.dirname(dest), { recursive: true });
        const readStream = await entry.openReadStream();
        await new Promise<void>((resolve, reject) => {
          const w = fs.createWriteStream(dest);
          readStream.pipe(w);
          w.on("finish", () => resolve());
          w.on("error", reject);
          readStream.on("error", reject);
        });
      }
    } catch (err) {
      // Re-wrap yauzl validateFilenames assert errors (zip-slip, absolute path, relative `..`)
      // as ValidationFailedError so callers see a typed, consistent error class.
      if (err instanceof ValidationFailedError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new ValidationFailedError(`Zip entry validation failed: ${msg}`);
    }

    await zip.close();

    if (!hadFiles) throw new ValidationFailedError("Zip had no files");

    // Determine root — flatten single-top-dir wrapper
    let root = stagingBase;
    const topLevelEntries = await fsP.readdir(stagingBase);
    if (
      topLevelEntries.length === 1 &&
      (await fsP.stat(path.join(stagingBase, topLevelEntries[0]!))).isDirectory()
    ) {
      const only = path.join(stagingBase, topLevelEntries[0]!);
      if (fs.existsSync(path.join(only, "fxmanifest.lua"))) {
        root = only;
      }
    }

    // Validate fxmanifest.lua presence at root
    if (!fs.existsSync(path.join(root, "fxmanifest.lua"))) {
      throw new ValidationFailedError(
        `No fxmanifest.lua at root or inside single-top-dir wrapper`
      );
    }
    return { root };
  } catch (e) {
    // Cleanup partial extraction on any failure — prevents stagingRoot from
    // filling with orphaned extract-* dirs on repeated failures.
    await fsP.rm(stagingBase, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}
