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
});
