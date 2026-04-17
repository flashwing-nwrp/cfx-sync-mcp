import { describe, it, expect } from "vitest";
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ESM: __dirname is not defined; derive from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(p));
    else if (entry.isFile() && p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function findNonGetMethodLiterals(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
  const violations: string[] = [];

  function visit(node: ts.Node) {
    // Look for object-literal property `method: "POST"` etc.
    if (ts.isPropertyAssignment(node)) {
      const name = node.name;
      const init = node.initializer;
      if (
        ts.isIdentifier(name) &&
        name.text === "method" &&
        ts.isStringLiteral(init) &&
        init.text.toUpperCase() !== "GET"
      ) {
        const pos = sf.getLineAndCharacterOfPosition(node.pos);
        violations.push(
          `${file}:${pos.line + 1} method: "${init.text}" not allowed in portal code`
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return violations;
}

describe("CI invariant: no non-GET method literals in src/lib/portal/**", () => {
  it("portal code uses only GET method literals", () => {
    const portalDir = path.resolve(__dirname, "../../src/lib/portal");
    const files = listTsFiles(portalDir);
    const violations = files.flatMap(findNonGetMethodLiterals);
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
