import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { tmpdir } from "node:os";
import {
  detectOrphans,
  verifyPristineIntegrity,
} from "../../../src/lib/pristine/gc.js";
import type { AssetState } from "../../../src/lib/state/state.js";

function sha256Hex(s: string | Buffer): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function makeStateEntry(overrides: Partial<AssetState> = {}): AssetState {
  return {
    grantId: 42,
    assetId: 1,
    slug: "some-asset",
    assetName: "Some Asset",
    versionId: 100,
    packId: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    sha256: "deadbeef",
    cachedZipPath: "/tmp/x.zip",
    deployedPath: "/tmp/dest",
    deployedAt: "2026-01-01T00:00:00.000Z",
    backups: [],
    pristineVersionId: null,
    pristineCapturedAt: null,
    pristineHashes: null,
    ...overrides,
  };
}

describe("detectOrphans", () => {
  let tmp: string;
  let pristineDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "cfx-gc-"));
    pristineDir = path.join(tmp, "pristine");
    mkdirSync(pristineDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns pristine dirs not present in the current mapping", async () => {
    // Seed 3 pristine dirs: 2 mapped + 1 orphan.
    mkdirSync(path.join(pristineDir, "10"));
    mkdirSync(path.join(pristineDir, "20"));
    mkdirSync(path.join(pristineDir, "30"));

    const orphans = await detectOrphans([10, 20], pristineDir);

    expect(orphans).toEqual([30]);
  });

  it("returns empty array when every pristine dir is mapped", async () => {
    mkdirSync(path.join(pristineDir, "10"));
    mkdirSync(path.join(pristineDir, "20"));

    const orphans = await detectOrphans([10, 20, 99], pristineDir);

    expect(orphans).toEqual([]);
  });

  it("skips .tmp.* and .old.* transient dirs", async () => {
    mkdirSync(path.join(pristineDir, "10"));
    mkdirSync(path.join(pristineDir, "10.tmp.123.456.789"));
    mkdirSync(path.join(pristineDir, "10.old.2026-01-01T00-00-00Z"));
    mkdirSync(path.join(pristineDir, "99"));

    const orphans = await detectOrphans([10], pristineDir);

    // 99 is orphan; .tmp.* / .old.* MUST be ignored (not reported as orphans).
    expect(orphans).toEqual([99]);
  });

  it("ignores non-numeric directory names", async () => {
    mkdirSync(path.join(pristineDir, "10"));
    mkdirSync(path.join(pristineDir, "README"));
    mkdirSync(path.join(pristineDir, "notes"));

    const orphans = await detectOrphans([10], pristineDir);

    expect(orphans).toEqual([]);
  });

  it("returns empty array when pristineDir does not exist", async () => {
    const orphans = await detectOrphans([10, 20], path.join(tmp, "not-exist"));
    expect(orphans).toEqual([]);
  });
});

describe("verifyPristineIntegrity", () => {
  let tmp: string;
  let pristineDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "cfx-gc-integ-"));
    pristineDir = path.join(tmp, "pristine");
    mkdirSync(pristineDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns 'ok' when hashes match state", async () => {
    const grantId = 42;
    const dest = path.join(pristineDir, String(grantId));
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, "fxmanifest.lua"), "name 'pkg'");
    writeFileSync(path.join(dest, "a.lua"), "alpha");

    const state = makeStateEntry({
      grantId,
      pristineVersionId: 1,
      pristineHashes: {
        "fxmanifest.lua": sha256Hex("name 'pkg'"),
        "a.lua": sha256Hex("alpha"),
      },
    });

    const status = await verifyPristineIntegrity(pristineDir, grantId, state);
    expect(status).toBe("ok");
  });

  it("returns 'ok' when both dir missing and state.pristineHashes is null", async () => {
    const grantId = 42;
    const state = makeStateEntry({
      grantId,
      pristineVersionId: null,
      pristineHashes: null,
    });

    const status = await verifyPristineIntegrity(pristineDir, grantId, state);
    expect(status).toBe("ok");
  });

  it("returns 'corrupted' when hashes mismatch (file modified after capture)", async () => {
    const grantId = 42;
    const dest = path.join(pristineDir, String(grantId));
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, "fxmanifest.lua"), "name 'pkg'");

    // State records the hash of the original content…
    const state = makeStateEntry({
      grantId,
      pristineVersionId: 1,
      pristineHashes: {
        "fxmanifest.lua": sha256Hex("name 'pkg'"),
      },
    });

    // …but someone tampered with the file after capture.
    writeFileSync(path.join(dest, "fxmanifest.lua"), "name 'tampered'");

    const status = await verifyPristineIntegrity(pristineDir, grantId, state);
    expect(status).toBe("corrupted");
  });

  it("returns 'corrupted' when extra files exist in pristine dir", async () => {
    const grantId = 42;
    const dest = path.join(pristineDir, String(grantId));
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, "fxmanifest.lua"), "name 'pkg'");
    // Extra file not in state.
    writeFileSync(path.join(dest, "rogue.lua"), "surprise");

    const state = makeStateEntry({
      grantId,
      pristineVersionId: 1,
      pristineHashes: {
        "fxmanifest.lua": sha256Hex("name 'pkg'"),
      },
    });

    const status = await verifyPristineIntegrity(pristineDir, grantId, state);
    expect(status).toBe("corrupted");
  });

  it("returns 'corrupted' when dir missing but state expects hashes", async () => {
    const grantId = 42;
    // No dir created.
    const state = makeStateEntry({
      grantId,
      pristineVersionId: 1,
      pristineHashes: { "fxmanifest.lua": sha256Hex("name 'pkg'") },
    });

    const status = await verifyPristineIntegrity(pristineDir, grantId, state);
    expect(status).toBe("corrupted");
  });

  it("returns 'mid-rotation' when a .tmp.* dir exists for grantId", async () => {
    const grantId = 42;
    mkdirSync(path.join(pristineDir, String(grantId)), { recursive: true });
    mkdirSync(path.join(pristineDir, `${grantId}.tmp.999.1.2`), {
      recursive: true,
    });

    const state = makeStateEntry({ grantId, pristineHashes: null });
    const status = await verifyPristineIntegrity(pristineDir, grantId, state);
    expect(status).toBe("mid-rotation");
  });

  it("returns 'mid-rotation' when a .old.* dir exists for grantId", async () => {
    const grantId = 42;
    mkdirSync(path.join(pristineDir, String(grantId)), { recursive: true });
    mkdirSync(path.join(pristineDir, `${grantId}.old.2026-01-01T00-00-00Z`), {
      recursive: true,
    });

    const state = makeStateEntry({ grantId, pristineHashes: null });
    const status = await verifyPristineIntegrity(pristineDir, grantId, state);
    expect(status).toBe("mid-rotation");
  });

  it("does not match unrelated grantIds' .tmp/.old dirs", async () => {
    const grantId = 42;
    const dest = path.join(pristineDir, String(grantId));
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, "fxmanifest.lua"), "name 'pkg'");

    // Unrelated grant's transient dir should not trigger mid-rotation for 42.
    mkdirSync(path.join(pristineDir, "99.tmp.1.2.3"), { recursive: true });

    const state = makeStateEntry({
      grantId,
      pristineVersionId: 1,
      pristineHashes: { "fxmanifest.lua": sha256Hex("name 'pkg'") },
    });

    const status = await verifyPristineIntegrity(pristineDir, grantId, state);
    expect(status).toBe("ok");
  });
});
