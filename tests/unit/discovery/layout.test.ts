import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { detectLayout } from "../../../src/lib/discovery/detectLayout.js";
import { UnknownLayoutError } from "../../../src/lib/errors.js";

describe("detectLayout", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "cfx-layout-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns 'categorized' when top-level has [category] dirs", () => {
    mkdirSync(path.join(dir, "[standalone]"));
    mkdirSync(path.join(dir, "[qs]"));
    expect(detectLayout(dir)).toBe("categorized");
  });

  it("returns 'flat' when top-level dirs contain fxmanifest.lua", () => {
    mkdirSync(path.join(dir, "foo"));
    writeFileSync(path.join(dir, "foo", "fxmanifest.lua"), "name 'foo'");
    mkdirSync(path.join(dir, "bar"));
    writeFileSync(path.join(dir, "bar", "fxmanifest.lua"), "name 'bar'");
    expect(detectLayout(dir)).toBe("flat");
  });

  it("throws UnknownLayoutError otherwise", () => {
    mkdirSync(path.join(dir, "regular-dir"));
    expect(() => detectLayout(dir)).toThrow(UnknownLayoutError);
  });
});
