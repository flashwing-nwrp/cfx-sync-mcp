import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { scanResources } from "../../../src/lib/discovery/scanResources.js";

describe("scanResources (categorized)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "cfx-scan-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function mkResource(cat: string, name: string, manifest: string, withFxap = false) {
    const p = path.join(dir, cat, name);
    mkdirSync(p, { recursive: true });
    writeFileSync(path.join(p, "fxmanifest.lua"), manifest);
    if (withFxap) writeFileSync(path.join(p, "resource.fxap"), "encrypted");
  }

  it("enumerates resources under [category] dirs, flagging .fxap", () => {
    mkdirSync(path.join(dir, "[standalone]"));
    mkResource("[standalone]", "qs-inventory", "name 'qs-inventory'\nauthor 'Quasar'", true);
    mkResource("[qs]", "qs-housing", "fx_version 'cerulean'\nname 'qs-housing'", true);
    mkResource("[flrp]", "flrp_banking", "name 'flrp_banking'", false);

    const out = scanResources(dir, "categorized");
    expect(out.length).toBe(3);
    const byFolder = Object.fromEntries(out.map((r) => [r.folderName, r]));
    expect(byFolder["qs-inventory"]!.hasFxap).toBe(true);
    expect(byFolder["flrp_banking"]!.hasFxap).toBe(false);
  });

  it("skips symlinks in server tree", () => {
    mkdirSync(path.join(dir, "[standalone]", "real"), { recursive: true });
    writeFileSync(path.join(dir, "[standalone]", "real", "fxmanifest.lua"), "name 'real'");
    try {
      symlinkSync(path.join(dir, "[standalone]", "real"), path.join(dir, "[standalone]", "link"));
    } catch {
      return; // symlink unsupported on this host (Windows w/o admin); skip
    }
    const out = scanResources(dir, "categorized");
    expect(out.some((r) => r.folderName === "link")).toBe(false);
  });

  it("extracts name and author from fxmanifest.lua", () => {
    mkResource("[standalone]", "foo", "name 'FooName'\nauthor 'AuthorName'");
    const out = scanResources(dir, "categorized");
    expect(out[0]!.fxmanifestName).toBe("FooName");
    expect(out[0]!.author).toBe("AuthorName");
  });
});

describe("scanResources (flat)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "cfx-scan-flat-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("enumerates resources directly under root", () => {
    mkdirSync(path.join(dir, "foo"));
    writeFileSync(path.join(dir, "foo", "fxmanifest.lua"), "name 'foo'");
    mkdirSync(path.join(dir, "bar"));
    writeFileSync(path.join(dir, "bar", "fxmanifest.lua"), "name 'bar'");
    const out = scanResources(dir, "flat");
    expect(out.map((r) => r.folderName).sort()).toEqual(["bar", "foo"]);
  });
});
