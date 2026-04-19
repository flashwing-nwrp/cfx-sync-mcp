import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { unzipToStaging } from "../../../src/lib/deploy/unzipper.js";
import { ValidationFailedError } from "../../../src/lib/errors.js";

// jszip@3.x ships CJS only; namespace-import pattern for ESM+NodeNext
import * as JSZipModule from "jszip";
const JSZip: any = (JSZipModule as any).default ?? JSZipModule;

async function buildZip(entries: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer" });
}

// Build a zip that includes symlink entries. Setting unixPermissions with the
// S_IFLNK bits (0o120000) + platform: 'UNIX' causes yauzl to report this entry
// as a symlink via its external file attributes.
async function buildZipWithSymlinks(
  files: Record<string, string>,
  symlinks: Record<string, string>
): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  for (const [name, target] of Object.entries(symlinks)) {
    zip.file(name, target, { unixPermissions: 0o120777 });
  }
  return zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
}

describe("unzipToStaging", () => {
  let tmp: string;
  let cache: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "cfx-unz-"));
    cache = path.join(tmp, "pack.zip");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("extracts a flat zip", async () => {
    const buf = await buildZip({ "fxmanifest.lua": "name 'foo'", "client.lua": "x" });
    writeFileSync(cache, buf);
    const stagingRoot = path.join(tmp, "staging");
    const out = await unzipToStaging(cache, stagingRoot);
    expect(existsSync(path.join(out.root, "fxmanifest.lua"))).toBe(true);
    expect(existsSync(path.join(out.root, "client.lua"))).toBe(true);
    // Valid packs should report an empty validationFailures array.
    expect(out.validationFailures).toEqual([]);
  });

  it("flattens single-top-level-dir wrapper", async () => {
    const buf = await buildZip({
      "qs-inventory/fxmanifest.lua": "name 'qs-inventory'",
      "qs-inventory/client.lua": "x",
    });
    writeFileSync(cache, buf);
    const stagingRoot = path.join(tmp, "staging");
    const out = await unzipToStaging(cache, stagingRoot);
    expect(existsSync(path.join(out.root, "fxmanifest.lua"))).toBe(true);
    expect(existsSync(path.join(out.root, "client.lua"))).toBe(true);
  });

  it("rejects zip-slip ../escape", async () => {
    const buf = await buildZip({ "../../escape.lua": "bad" });
    writeFileSync(cache, buf);
    await expect(
      unzipToStaging(cache, path.join(tmp, "staging"))
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it("surfaces symlinks in validationFailures; does not extract them", async () => {
    // Pack contains one valid file + fxmanifest AND one symlink entry.
    // Expectation: extraction completes, symlink is skipped (not written to
    // disk), and is reported in validationFailures as `symlink-refused`.
    const buf = await buildZipWithSymlinks(
      { "fxmanifest.lua": "name 'foo'", "client.lua": "x" },
      { "evil-link.lua": "/etc/passwd" }
    );
    writeFileSync(cache, buf);
    const stagingRoot = path.join(tmp, "staging");

    const out = await unzipToStaging(cache, stagingRoot);

    // Valid files extracted.
    expect(existsSync(path.join(out.root, "fxmanifest.lua"))).toBe(true);
    expect(existsSync(path.join(out.root, "client.lua"))).toBe(true);
    // Symlink NOT extracted.
    expect(existsSync(path.join(out.root, "evil-link.lua"))).toBe(false);
    // Surfaced as a structured failure.
    expect(out.validationFailures).toEqual([
      { path: "evil-link.lua", reason: "symlink-refused" },
    ]);
  });

  it("rejects absolute-path entries", async () => {
    const buf = await buildZip({ "/etc/passwd.lua": "bad" });
    writeFileSync(cache, buf);
    await expect(
      unzipToStaging(cache, path.join(tmp, "staging"))
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it("rejects zip with no fxmanifest.lua", async () => {
    const buf = await buildZip({ "something.lua": "no manifest" });
    writeFileSync(cache, buf);
    await expect(
      unzipToStaging(cache, path.join(tmp, "staging"))
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it("cleans up staging dir when extraction fails mid-loop (zip-slip after valid entries)", async () => {
    const buf = await buildZip({
      "fxmanifest.lua": "name 'foo'",
      "client.lua": "x",
      "../../escape.lua": "bad",
    });
    writeFileSync(cache, buf);
    const stagingRoot = path.join(tmp, "staging");
    await expect(unzipToStaging(cache, stagingRoot)).rejects.toThrow();
    // Staging root should be empty — extract-* dir from the partial run was cleaned up
    const { readdirSync, existsSync } = await import("node:fs");
    const entries = existsSync(stagingRoot) ? readdirSync(stagingRoot) : [];
    expect(entries).toEqual([]);
  });

  it("cleans up staging when zip has top-dir without fxmanifest.lua", async () => {
    const buf = await buildZip({
      "wrapper/notmanifest.lua": "no",
    });
    writeFileSync(cache, buf);
    const stagingRoot = path.join(tmp, "staging");
    await expect(unzipToStaging(cache, stagingRoot)).rejects.toThrow();
    const { readdirSync, existsSync } = await import("node:fs");
    const entries = existsSync(stagingRoot) ? readdirSync(stagingRoot) : [];
    expect(entries).toEqual([]);
  });
});
