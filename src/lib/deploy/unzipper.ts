import fs from "node:fs";
import fsP from "node:fs/promises";
import path from "node:path";
import { open as yauzlOpen } from "yauzl-promise";
import { ValidationFailedError } from "../errors.js";
import type { ValidationFailure } from "../preservation/types.js";

export interface UnzipResult {
  root: string;
  /**
   * Pack-level validation failures surfaced (not thrown) during extraction.
   * Currently only symlinks — skipped entries are recorded so the dry-run /
   * deploy-plan layer can display them to operators alongside other pack
   * problems. Zip-slip and absolute-path entries are NOT surfaced here; those
   * are hard refuses and still throw ValidationFailedError.
   */
  validationFailures: ValidationFailure[];
}

// Extracts a zip into <stagingRoot>/<basename>-<counter>/ with these guarantees:
//   - No entry resolves outside the staging root (zip-slip) — THROWS
//   - Absolute paths are refused — THROWS
//   - Symlink entries are SKIPPED and surfaced in validationFailures[]
//   - If the zip wraps everything in a single top-level dir, contents are
//     flattened (hoisted one level) so the staging root holds fxmanifest.lua directly.
export async function unzipToStaging(
  zipFile: string,
  stagingRoot: string,
  preferredSubdir?: string
): Promise<UnzipResult> {
  await fsP.mkdir(stagingRoot, { recursive: true });
  const stagingBase = path.join(stagingRoot, `extract-${Date.now()}-${process.pid}`);
  await fsP.mkdir(stagingBase);

  // validateFilenames: true (default) — yauzl will throw on `../` and absolute paths
  // during entry iteration. We catch those and rethrow as ValidationFailedError below.
  const zip = await yauzlOpen(zipFile);
  let hadFiles = false;
  const validationFailures: ValidationFailure[] = [];

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

        // Skip symlinks but surface them in validationFailures so callers (dry-run,
        // DeployPlan.packValidationFailures) can show operators which files were
        // dropped. yauzl exposes external file attrs — upper 16 bits are Unix mode.
        const externalAttrs = entry.externalFileAttributes >>> 16;
        const isSymlink = (externalAttrs & 0o170000) === 0o120000;
        if (isSymlink) {
          validationFailures.push({ path: rawName, reason: "symlink-refused" });
          continue;
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

    // Determine root — flatten single-top-dir wrapper, or pick preferred subdir
    // when the pack ships multiple top-level variants (e.g. "Foo/" + "Foo_experimental/").
    let root = stagingBase;
    const topLevelEntries = await fsP.readdir(stagingBase);
    const topDirs: string[] = [];
    for (const name of topLevelEntries) {
      if ((await fsP.stat(path.join(stagingBase, name))).isDirectory()) topDirs.push(name);
    }

    if (topDirs.length === 1) {
      const only = path.join(stagingBase, topDirs[0]!);
      if (fs.existsSync(path.join(only, "fxmanifest.lua"))) {
        root = only;
      }
    } else if (topDirs.length > 1 && preferredSubdir) {
      // Case-insensitive match against mapping target's basename.
      const matched = topDirs.find((d) => d.toLowerCase() === preferredSubdir.toLowerCase());
      if (matched) {
        const candidate = path.join(stagingBase, matched);
        if (fs.existsSync(path.join(candidate, "fxmanifest.lua"))) {
          root = candidate;
        }
      }
    }

    // Validate fxmanifest.lua presence at root
    if (!fs.existsSync(path.join(root, "fxmanifest.lua"))) {
      const hint =
        topDirs.length > 1
          ? ` Multi-root pack (${topDirs.join(", ")}); preferredSubdir='${preferredSubdir ?? "<none>"}'`
          : "";
      throw new ValidationFailedError(
        `No fxmanifest.lua at root or inside single-top-dir wrapper.${hint}`
      );
    }
    return { root, validationFailures };
  } catch (e) {
    // Cleanup partial extraction on any failure — prevents stagingRoot from
    // filling with orphaned extract-* dirs on repeated failures.
    await fsP.rm(stagingBase, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}
