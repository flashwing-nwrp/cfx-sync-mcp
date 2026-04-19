/**
 * scanConfigs — Layer 1 orchestrator for Phase 1.5 preservation.
 *
 * Walks a resource directory and returns a sorted, de-duplicated list of
 * repo-relative paths the system will *advise* preserving during a sync. The
 * output is consumed by dry-run UI hints + the future KB moat. It NEVER
 * overrides Layer 2 (diff-engine) decisions — Layer 1 is purely advisory.
 *
 * Two detection channels, evaluated per file:
 *
 *   1. Path patterns (primary; see ROOT_PATTERNS + DIR_PATTERNS below).
 *      Case-insensitive basename / first-segment match. Fast, high-precision.
 *
 *   2. Content-signature fallback (advisory; only for .lua files that did NOT
 *      match a path pattern). Delegates to `scoreFile()` + `LAYER_1_THRESHOLD`
 *      from contentSignature.ts. Catches author-chosen config paths that
 *      don't match the standard allowlist (e.g. `prices/menu.lua`,
 *      `shared/items.lua`).
 *
 * The spec explicitly excludes `data/**` from the pattern list — pack authors
 * legitimately rewrite lookup tables between versions, and a false-positive
 * there would silently hide legitimate upstream updates from the operator.
 * Content-sig may still catch a `data/` file that happens to look config-shaped,
 * which is the correct behavior (one file, not the whole tree).
 *
 * Output contract (sorted in this order):
 *   - repo-relative (relative to `resourceDir`)
 *   - forward-slash ("/" on Windows too)
 *   - unique (no duplicates)
 *   - ASCII-ascending sort for determinism
 */

import fsP from "node:fs/promises";
import path from "node:path";

import { scoreFile, LAYER_1_THRESHOLD } from "./contentSignature.js";

// ----- Path patterns (case-insensitive) -----------------------------------

/** Files at the resource root that are always preserved by path. */
const ROOT_PATTERNS: ReadonlySet<string> = new Set([
  "config.lua",
  "cfg.lua",
  "shared.lua",
  "permissions.lua",
  "settings.lua",
]);

/**
 * Top-level directories whose entire subtree is preserved by path. Matched
 * against the FIRST segment of the repo-relative path (case-insensitive).
 *
 * Intentionally excludes `data` — see module docblock.
 */
const DIR_PATTERNS: ReadonlySet<string> = new Set([
  "config",
  "configs",
  "cfg",
  "settings",
  "locales",
]);

// ----- Public API ---------------------------------------------------------

/**
 * Scan `resourceDir` and return paths to advise-preserve.
 *
 * @param resourceDir Absolute path to the resource root (e.g.
 *   `.../server/resources/[category]/resource_name`).
 * @returns Sorted, de-duplicated, forward-slash, repo-relative paths.
 */
export async function scanConfigs(resourceDir: string): Promise<string[]> {
  const files: string[] = [];
  await walkCollectFiles(resourceDir, files);

  const results = new Set<string>();

  for (const abs of files) {
    const relNative = path.relative(resourceDir, abs);
    const rel = toForwardSlash(relNative);

    if (matchesPathPattern(rel)) {
      results.add(rel);
      continue;
    }

    // Content-sig fallback: .lua only. scoreFile itself returns null for
    // non-.lua or unreadable inputs, but we short-circuit here to avoid
    // the fs round-trip for obvious non-candidates.
    if (!rel.toLowerCase().endsWith(".lua")) continue;

    const score = await scoreFile(abs);
    if (score !== null && score >= LAYER_1_THRESHOLD) {
      results.add(rel);
    }
  }

  return Array.from(results).sort();
}

// ----- Internals ----------------------------------------------------------

/** Does this repo-relative path match a root or directory pattern? */
function matchesPathPattern(rel: string): boolean {
  const lower = rel.toLowerCase();
  // Root pattern — exact basename, no slash.
  if (!lower.includes("/") && ROOT_PATTERNS.has(lower)) {
    return true;
  }
  // Dir pattern — first segment.
  const firstSeg = lower.split("/", 1)[0];
  if (firstSeg && lower.includes("/") && DIR_PATTERNS.has(firstSeg)) {
    return true;
  }
  return false;
}

/**
 * Walks `dir` recursively collecting absolute file paths. Skips symlinks
 * (defense-in-depth, matching hashTree.ts convention). Propagates fs errors.
 */
async function walkCollectFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fsP.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // If the resource dir doesn't exist or isn't readable, callers treat
    // that as "nothing to preserve" rather than a crash. Re-throw for any
    // other error (permission denied, etc.) so the operator sees it.
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkCollectFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
    // Other types (block devices, sockets, FIFOs) ignored.
  }
}

function toForwardSlash(p: string): string {
  if (path.sep === "/") return p;
  return p.split(path.sep).join("/");
}
