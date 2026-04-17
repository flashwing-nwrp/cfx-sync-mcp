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

/** Returns true if the property name node resolves to the string "method". */
function isMethodKey(name: ts.PropertyName): boolean {
  // { method: ... }  — identifier key
  if (ts.isIdentifier(name) && name.text === "method") return true;
  // { "method": ... } — string-literal key
  if (ts.isStringLiteral(name) && name.text === "method") return true;
  // { ["method"]: ... } — computed key wrapping a string literal
  if (
    ts.isComputedPropertyName(name) &&
    ts.isStringLiteral(name.expression) &&
    name.expression.text === "method"
  ) {
    return true;
  }
  return false;
}

/** Returns the method string value, or null if not a static string we can read. */
function getMethodValue(init: ts.Expression): string | null {
  // "POST" / 'POST'
  if (ts.isStringLiteral(init)) return init.text;
  // `POST`  (no-substitution template — no ${} interpolation)
  if (ts.isNoSubstitutionTemplateLiteral(init)) return init.text;
  return null;
}

/**
 * Core violation finder. Works on an already-parsed SourceFile so it can be
 * called from both the real-file scanner and the synthesized-source tests.
 */
export function findViolationsInSource(sf: ts.SourceFile): string[] {
  const violations: string[] = [];

  function visit(node: ts.Node) {
    // Look for object-literal property `method: "POST"` etc.
    if (ts.isPropertyAssignment(node)) {
      const name = node.name;
      const init = node.initializer;
      if (isMethodKey(name)) {
        const value = getMethodValue(init);
        if (value !== null && value.toUpperCase() !== "GET") {
          // getStart(sf) points at the token itself, not leading trivia.
          const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          violations.push(
            `${sf.fileName}:${pos.line + 1} method: "${value}" not allowed in portal code`
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return violations;
}

function findNonGetMethodLiterals(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
  return findViolationsInSource(sf);
}

// ---------------------------------------------------------------------------
// Helpers for synthesized-source tests
// ---------------------------------------------------------------------------

function parseInline(src: string): ts.SourceFile {
  return ts.createSourceFile("synthetic.ts", src, ts.ScriptTarget.ES2022, true);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CI invariant: no non-GET method literals in src/lib/portal/**", () => {
  it("portal code uses only GET method literals", () => {
    const portalDir = path.resolve(__dirname, "../../src/lib/portal");
    const files = listTsFiles(portalDir);
    const violations = files.flatMap(findNonGetMethodLiterals);
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

describe("AST detector — synthesized-source cases", () => {
  it("detects method violation: identifier key + string-literal value", () => {
    const sf = parseInline('const opts = { method: "POST" };');
    const v = findViolationsInSource(sf);
    expect(v.length).toBe(1);
    expect(v[0]).toContain('"POST"');
  });

  it('detects method violation: string-literal key (e.g., { "method": "POST" })', () => {
    const sf = parseInline('const opts = { "method": "POST" };');
    const v = findViolationsInSource(sf);
    expect(v.length).toBe(1);
    expect(v[0]).toContain('"POST"');
  });

  it('detects method violation: computed string key (e.g., { ["method"]: "POST" })', () => {
    const sf = parseInline('const opts = { ["method"]: "POST" };');
    const v = findViolationsInSource(sf);
    expect(v.length).toBe(1);
    expect(v[0]).toContain('"POST"');
  });

  it("detects method violation: no-substitution template-literal value (e.g., { method: `POST` })", () => {
    const sf = parseInline("const opts = { method: `POST` };");
    const v = findViolationsInSource(sf);
    expect(v.length).toBe(1);
    expect(v[0]).toContain('"POST"');
  });
});
