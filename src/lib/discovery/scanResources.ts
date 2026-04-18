import fs from "node:fs";
import path from "node:path";
import type { Layout } from "./detectLayout.js";

export interface ResourceMeta {
  path: string;
  folderName: string;
  fxmanifestName: string | null;
  author: string | null;
  hasFxap: boolean;
}

function parseFxmanifest(file: string): { name: string | null; author: string | null } {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const nameMatch = raw.match(/\bname\s+['"]([^'"]+)['"]/);
    const authorMatch = raw.match(/\bauthor\s+['"]([^'"]+)['"]/);
    return { name: nameMatch?.[1] ?? null, author: authorMatch?.[1] ?? null };
  } catch { return { name: null, author: null }; }
}

function readResourceDir(dir: string): ResourceMeta | null {
  const manifest = path.join(dir, "fxmanifest.lua");
  if (!fs.existsSync(manifest)) return null;
  const parsed = parseFxmanifest(manifest);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const hasFxap = entries.some((e) => e.isFile() && e.name.endsWith(".fxap"));
  return {
    path: dir,
    folderName: path.basename(dir),
    fxmanifestName: parsed.name,
    author: parsed.author,
    hasFxap,
  };
}

export function scanResources(serverResources: string, layout: Layout): ResourceMeta[] {
  const out: ResourceMeta[] = [];

  const walkDirs = (roots: string[]) => {
    for (const root of roots) {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        // skip symlinks per spec — they cause lookups through external dirs
        if (e.isSymbolicLink()) continue;
        if (!e.isDirectory()) continue;
        const p = path.join(root, e.name);
        const meta = readResourceDir(p);
        if (meta) out.push(meta);
      }
    }
  };

  if (layout === "categorized") {
    const cats: string[] = [];
    for (const e of fs.readdirSync(serverResources, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith("[") && e.name.endsWith("]")) {
        cats.push(path.join(serverResources, e.name));
      }
    }
    walkDirs(cats);
  } else {
    walkDirs([serverResources]);
  }
  return out;
}
