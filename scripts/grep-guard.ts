#!/usr/bin/env node
// Grep-based guard that complements the AST check. Catches patterns a
// developer might use to smuggle mutations (e.g., building method strings
// dynamically that happen to include POST/PUT/PATCH/DELETE).

import fs from "node:fs";
import path from "node:path";

const FORBIDDEN_PATTERNS = [
  /\bmethod\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i,
  /\.(?:post|put|patch|delete)\s*\(/i,
];

const ALLOWED_FILES = new Set<string>([]); // none

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const targetDir = path.resolve(process.cwd(), "src/lib/portal");
if (!fs.existsSync(targetDir)) {
  console.error(`grep-guard: ${targetDir} not found`);
  process.exit(1);
}

const files = walk(targetDir).filter((f) => !ALLOWED_FILES.has(f));
const violations: string[] = [];

for (const file of files) {
  const content = fs.readFileSync(file, "utf8");
  content.split("\n").forEach((line, idx) => {
    for (const pat of FORBIDDEN_PATTERNS) {
      if (pat.test(line)) {
        violations.push(`${file}:${idx + 1}: ${line.trim()}`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error(`grep-guard FAILED — forbidden patterns in src/lib/portal/**:`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(`grep-guard OK — scanned ${files.length} files in src/lib/portal/`);
