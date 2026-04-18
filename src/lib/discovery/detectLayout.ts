import fs from "node:fs";
import path from "node:path";
import { UnknownLayoutError } from "../errors.js";

export type Layout = "categorized" | "flat";

export function detectLayout(serverResources: string): Layout {
  const entries = fs.readdirSync(serverResources, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());

  const hasCategoryBrackets = dirs.some((d) => d.name.startsWith("[") && d.name.endsWith("]"));
  if (hasCategoryBrackets) return "categorized";

  const hasFxmanifestDirs = dirs.some((d) =>
    fs.existsSync(path.join(serverResources, d.name, "fxmanifest.lua"))
  );
  if (hasFxmanifestDirs) return "flat";

  throw new UnknownLayoutError(serverResources);
}
