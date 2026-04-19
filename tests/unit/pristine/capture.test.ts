import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import fsP from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { tmpdir } from "node:os";
import { capturePristine } from "../../../src/lib/pristine/capture.js";
import { hashTree } from "../../../src/lib/preservation/hashTree.js";

function sha256Hex(s: string | Buffer): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

describe("capturePristine", () => {
  let tmp: string;
  let staging: string;
  let pristineDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "cfx-pristine-"));
    staging = path.join(tmp, "staging");
    pristineDir = path.join(tmp, "pristine");
    mkdirSync(staging, { recursive: true });
    mkdirSync(pristineDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("captures a full tree into state/pristine/<grantId>/", async () => {
    writeFileSync(path.join(staging, "fxmanifest.lua"), "name 'pkg'");
    writeFileSync(path.join(staging, "a.lua"), "alpha");
    mkdirSync(path.join(staging, "sub"));
    writeFileSync(path.join(staging, "sub", "b.lua"), "beta");
    writeFileSync(path.join(staging, "sub", "c.lua"), "gamma");

    const snapshot = await capturePristine({
      stagingRoot: staging,
      grantId: 42,
      pristineDir,
      versionId: 100,
    });

    const dest = path.join(pristineDir, "42");
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(path.join(dest, "fxmanifest.lua"), "utf8")).toBe("name 'pkg'");
    expect(readFileSync(path.join(dest, "a.lua"), "utf8")).toBe("alpha");
    expect(readFileSync(path.join(dest, "sub", "b.lua"), "utf8")).toBe("beta");
    expect(readFileSync(path.join(dest, "sub", "c.lua"), "utf8")).toBe("gamma");

    expect(snapshot.versionId).toBe(100);
    expect(typeof snapshot.capturedAt).toBe("string");
    // Sanity: ISO 8601 parse succeeds
    expect(Number.isFinite(Date.parse(snapshot.capturedAt))).toBe(true);
    expect(snapshot.hashes).toBeInstanceOf(Map);
    expect(snapshot.hashes.size).toBe(4);
  });

  it("writes pristineHashes matching hashTree output", async () => {
    writeFileSync(path.join(staging, "fxmanifest.lua"), "name 'pkg'");
    writeFileSync(path.join(staging, "a.lua"), "alpha");
    mkdirSync(path.join(staging, "sub"));
    writeFileSync(path.join(staging, "sub", "b.lua"), "beta");

    const snapshot = await capturePristine({
      stagingRoot: staging,
      grantId: 7,
      pristineDir,
      versionId: 5,
    });

    const dest = path.join(pristineDir, "7");
    const viaHashTree = await hashTree(dest);

    // Same size
    expect(snapshot.hashes.size).toBe(viaHashTree.size);

    // Same keys + same values
    for (const [rel, hex] of viaHashTree) {
      expect(snapshot.hashes.get(rel)).toBe(hex);
    }

    // And the hashes actually correspond to the original content.
    expect(snapshot.hashes.get("fxmanifest.lua")).toBe(sha256Hex("name 'pkg'"));
    expect(snapshot.hashes.get("a.lua")).toBe(sha256Hex("alpha"));
    expect(snapshot.hashes.get("sub/b.lua")).toBe(sha256Hex("beta"));
  });

  it("atomic write — failed mid-copy leaves no partial pristine dir", async () => {
    writeFileSync(path.join(staging, "fxmanifest.lua"), "name 'pkg'");
    writeFileSync(path.join(staging, "a.lua"), "alpha");
    writeFileSync(path.join(staging, "b.lua"), "beta");

    // Simulate a copy failure by making fs.promises.cp reject.
    const spy = vi
      .spyOn(fsP, "cp")
      .mockRejectedValueOnce(new Error("simulated copy failure"));

    await expect(
      capturePristine({
        stagingRoot: staging,
        grantId: 13,
        pristineDir,
        versionId: 1,
      })
    ).rejects.toThrow(/simulated copy failure/);

    spy.mockRestore();

    // Final destination must NOT exist.
    const dest = path.join(pristineDir, "13");
    expect(existsSync(dest)).toBe(false);

    // No tmp turds left behind either.
    const leftovers = readdirSync(pristineDir).filter((n) =>
      n.startsWith("13.tmp.") || n.startsWith("13.old.")
    );
    expect(leftovers).toEqual([]);
  });

  it("overwrites existing pristine safely via tmp + rename", async () => {
    // Seed an existing pristine dir with stale content.
    const dest = path.join(pristineDir, "99");
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, "old.lua"), "stale-content");
    writeFileSync(path.join(dest, "leftover.lua"), "going-away");

    // Fresh staging has different content + different file set.
    writeFileSync(path.join(staging, "fxmanifest.lua"), "name 'v2'");
    writeFileSync(path.join(staging, "new.lua"), "fresh-content");

    const snapshot = await capturePristine({
      stagingRoot: staging,
      grantId: 99,
      pristineDir,
      versionId: 2,
    });

    // Old files are gone.
    expect(existsSync(path.join(dest, "old.lua"))).toBe(false);
    expect(existsSync(path.join(dest, "leftover.lua"))).toBe(false);

    // New files are present and correct.
    expect(readFileSync(path.join(dest, "fxmanifest.lua"), "utf8")).toBe("name 'v2'");
    expect(readFileSync(path.join(dest, "new.lua"), "utf8")).toBe("fresh-content");

    // Hashes reflect the new content only.
    expect(snapshot.hashes.size).toBe(2);
    expect(snapshot.hashes.get("fxmanifest.lua")).toBe(sha256Hex("name 'v2'"));
    expect(snapshot.hashes.get("new.lua")).toBe(sha256Hex("fresh-content"));
    expect(snapshot.hashes.has("old.lua")).toBe(false);

    // No tmp/old leftovers.
    const leftovers = readdirSync(pristineDir).filter((n) =>
      n.startsWith("99.tmp.") || n.startsWith("99.old.")
    );
    expect(leftovers).toEqual([]);
  });

  it("creates pristineDir parent if missing", async () => {
    // Fresh tmp root; pristineDir not pre-created.
    const deep = path.join(tmp, "not-yet", "pristine");
    writeFileSync(path.join(staging, "fxmanifest.lua"), "name 'x'");

    const snapshot = await capturePristine({
      stagingRoot: staging,
      grantId: 1,
      pristineDir: deep,
      versionId: 1,
    });

    expect(existsSync(path.join(deep, "1", "fxmanifest.lua"))).toBe(true);
    expect(snapshot.hashes.size).toBe(1);
  });

  it("returned capturedAt is ISO8601 with Z suffix", async () => {
    writeFileSync(path.join(staging, "fxmanifest.lua"), "name 'pkg'");
    const snapshot = await capturePristine({
      stagingRoot: staging,
      grantId: 5,
      pristineDir,
      versionId: 1,
    });
    expect(snapshot.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });
});
