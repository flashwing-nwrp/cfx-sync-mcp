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

describe("scanResources — nested [bracket] categories", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "cfx-scan-nested-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds resources two bracket levels deep", () => {
    const nested = path.join(dir, "[maps]", "[apollo]", "apollo_fishing_pier");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      path.join(nested, "fxmanifest.lua"),
      "fx_version 'cerulean'\ngame 'gta5'\nname 'apollo_fishing_pier'\nauthor 'Apollo Developments'\n"
    );
    const out = scanResources(dir, "categorized");
    expect(out.map((r) => r.folderName)).toContain("apollo_fishing_pier");
    const apollo = out.find((r) => r.folderName === "apollo_fishing_pier")!;
    expect(apollo.author).toBe("Apollo Developments");
  });

  it("does not descend past the nesting safety cap", () => {
    // 6 bracket levels deep: [a]/[b]/[c]/[d]/[e]/[f]/deep_resource
    // Root bracket [a] is level 0; cap is 5, so [f] would be level 6 — should be skipped.
    const deep = path.join(dir, "[a]", "[b]", "[c]", "[d]", "[e]", "[f]", "deep_resource");
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, "fxmanifest.lua"), "fx_version 'cerulean'\ngame 'gta5'\n");
    const out = scanResources(dir, "categorized");
    expect(out.map((r) => r.folderName)).not.toContain("deep_resource");
  });

  it("handles a mix of flat resources and nested brackets", () => {
    const flat = path.join(dir, "[maps]", "flat_resource");
    const nested = path.join(dir, "[maps]", "[brofx]", "brofx_mansion_10");
    mkdirSync(flat, { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(flat, "fxmanifest.lua"), "fx_version 'cerulean'\ngame 'gta5'\n");
    writeFileSync(path.join(nested, "fxmanifest.lua"), "fx_version 'cerulean'\ngame 'gta5'\n");
    const out = scanResources(dir, "categorized");
    const names = out.map((r) => r.folderName).sort();
    expect(names).toEqual(["brofx_mansion_10", "flat_resource"]);
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
