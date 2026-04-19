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
import {
  rotatePristine,
  resumeOrRollbackRotation,
} from "../../../src/lib/pristine/rotate.js";
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

describe("rotatePristine", () => {
  let tmp: string;
  let staging: string;
  let pristineDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "cfx-rotate-"));
    staging = path.join(tmp, "staging");
    pristineDir = path.join(tmp, "pristine");
    mkdirSync(staging, { recursive: true });
    mkdirSync(pristineDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("first rotation (no prior pristine) — captures cleanly without trash", async () => {
    writeFileSync(path.join(staging, "fxmanifest.lua"), "name 'pkg'");
    writeFileSync(path.join(staging, "a.lua"), "alpha");

    const state = makeStateEntry({
      grantId: 42,
      pristineVersionId: null,
      pristineHashes: null,
    });

    const result = await rotatePristine({
      grantId: 42,
      newStagingRoot: staging,
      stateEntry: state,
      pristineDir,
      newVersionId: 200,
    });

    expect(result.grantId).toBe(42);
    expect(result.rotatedFrom).toBe(null);
    expect(result.rotatedTo).toBe(200);
    expect(result.newPristineHashes).toBeInstanceOf(Map);
    expect(result.newPristineHashes.size).toBe(2);
    expect(result.newPristineHashes.get("fxmanifest.lua")).toBe(sha256Hex("name 'pkg'"));

    const dest = path.join(pristineDir, "42");
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(path.join(dest, "a.lua"), "utf8")).toBe("alpha");

    // No transient trash/tmp dirs left.
    const leftovers = readdirSync(pristineDir).filter(
      (n) => n.startsWith("42.tmp.") || n.startsWith("42.old.")
    );
    expect(leftovers).toEqual([]);
  });

  it("rotates current pristine to trash, new into place, deletes trash last", async () => {
    // Prior pristine exists (grantId=42, versionId=100).
    const priorDest = path.join(pristineDir, "42");
    mkdirSync(priorDest, { recursive: true });
    writeFileSync(path.join(priorDest, "fxmanifest.lua"), "name 'v1'");
    writeFileSync(path.join(priorDest, "old.lua"), "v1-only");

    // New staging for versionId=200.
    writeFileSync(path.join(staging, "fxmanifest.lua"), "name 'v2'");
    writeFileSync(path.join(staging, "new.lua"), "v2-only");

    const renameSpy = vi.spyOn(fsP, "rename");
    const rmSpy = vi.spyOn(fsP, "rm");

    const state = makeStateEntry({
      grantId: 42,
      pristineVersionId: 100,
      pristineHashes: {
        "fxmanifest.lua": sha256Hex("name 'v1'"),
        "old.lua": sha256Hex("v1-only"),
      },
    });

    const result = await rotatePristine({
      grantId: 42,
      newStagingRoot: staging,
      stateEntry: state,
      pristineDir,
      newVersionId: 200,
    });

    expect(result.rotatedFrom).toBe(100);
    expect(result.rotatedTo).toBe(200);

    // Final state: only the new pristine exists, no trash.
    const dirs = readdirSync(pristineDir);
    expect(dirs).toContain("42");
    const trash = dirs.filter(
      (n) => n.startsWith("42.tmp.") || n.startsWith("42.old.")
    );
    expect(trash).toEqual([]);

    // New content is in place, old content gone.
    expect(existsSync(path.join(priorDest, "old.lua"))).toBe(false);
    expect(readFileSync(path.join(priorDest, "fxmanifest.lua"), "utf8")).toBe("name 'v2'");
    expect(readFileSync(path.join(priorDest, "new.lua"), "utf8")).toBe("v2-only");

    // Verify the trash dance actually happened: at least one rename call
    // targeted a `42.old.<...>` path (prior → trash). And at least one `rm`
    // call targeted that same trash path (trash → removed).
    const renameCalls = renameSpy.mock.calls.map((c) => [c[0] as string, c[1] as string] as const);
    const oldTrashRename = renameCalls.find(
      (pair) => path.basename(pair[1]!).startsWith("42.old.")
    );
    expect(oldTrashRename).toBeTruthy();

    const rmCalls = rmSpy.mock.calls.map((c) => c[0] as string);
    const trashRmCall = rmCalls.find((p) => path.basename(p).startsWith("42.old."));
    expect(trashRmCall).toBeTruthy();
  });

  it("self-heals from pre-existing .tmp.* turd at start of rotate", async () => {
    // Seed a turd tmp from a prior crashed rotate.
    const turd = path.join(pristineDir, "42.tmp.999.1234.5678");
    mkdirSync(turd, { recursive: true });
    writeFileSync(path.join(turd, "stale.lua"), "garbage");

    // Fresh staging.
    writeFileSync(path.join(staging, "fxmanifest.lua"), "name 'pkg'");

    const state = makeStateEntry({
      grantId: 42,
      pristineVersionId: null,
      pristineHashes: null,
    });

    const result = await rotatePristine({
      grantId: 42,
      newStagingRoot: staging,
      stateEntry: state,
      pristineDir,
      newVersionId: 1,
    });

    expect(result.rotatedTo).toBe(1);

    // Turd is gone.
    expect(existsSync(turd)).toBe(false);

    // Clean final state.
    const leftovers = readdirSync(pristineDir).filter(
      (n) => n.startsWith("42.tmp.") || n.startsWith("42.old.")
    );
    expect(leftovers).toEqual([]);
  });
});

describe("resumeOrRollbackRotation", () => {
  let tmp: string;
  let pristineDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "cfx-rotate-recov-"));
    pristineDir = path.join(tmp, "pristine");
    mkdirSync(pristineDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("resumes: trash + new dir present with fxmanifest → deletes trash", async () => {
    // Simulate a crash between cp+rename(trash) + rename(tmp→final) success and
    // final trash rm. Post-crash disk: `<id>/` is the new version, `<id>.old.<t>/`
    // is the prior.
    const grantId = 42;
    const finalDir = path.join(pristineDir, String(grantId));
    const trashDir = path.join(pristineDir, `${grantId}.old.2026-01-01T00-00-00Z`);
    mkdirSync(finalDir, { recursive: true });
    writeFileSync(path.join(finalDir, "fxmanifest.lua"), "name 'v2'");
    mkdirSync(trashDir, { recursive: true });
    writeFileSync(path.join(trashDir, "fxmanifest.lua"), "name 'v1'");

    const outcome = await resumeOrRollbackRotation(grantId, pristineDir);

    expect(outcome).toBe("resumed");
    expect(existsSync(trashDir)).toBe(false);
    expect(existsSync(finalDir)).toBe(true);
    expect(readFileSync(path.join(finalDir, "fxmanifest.lua"), "utf8")).toBe("name 'v2'");
  });

  it("rolls back: trash present + new dir missing → restores trash to final", async () => {
    // Crash between rename(prior → trash) and cp+rename(tmp → final). Post-crash:
    // final missing, only trash exists.
    const grantId = 42;
    const finalDir = path.join(pristineDir, String(grantId));
    const trashDir = path.join(pristineDir, `${grantId}.old.2026-01-01T00-00-00Z`);
    mkdirSync(trashDir, { recursive: true });
    writeFileSync(path.join(trashDir, "fxmanifest.lua"), "name 'v1'");
    writeFileSync(path.join(trashDir, "old.lua"), "v1-only");

    const outcome = await resumeOrRollbackRotation(grantId, pristineDir);

    expect(outcome).toBe("rolled-back");
    expect(existsSync(trashDir)).toBe(false);
    expect(existsSync(finalDir)).toBe(true);
    expect(readFileSync(path.join(finalDir, "fxmanifest.lua"), "utf8")).toBe("name 'v1'");
    expect(readFileSync(path.join(finalDir, "old.lua"), "utf8")).toBe("v1-only");
  });

  it("rolls back: trash present + new dir empty → restores trash to final", async () => {
    const grantId = 42;
    const finalDir = path.join(pristineDir, String(grantId));
    const trashDir = path.join(pristineDir, `${grantId}.old.2026-01-01T00-00-00Z`);
    mkdirSync(finalDir, { recursive: true });
    // finalDir is empty → incomplete
    mkdirSync(trashDir, { recursive: true });
    writeFileSync(path.join(trashDir, "fxmanifest.lua"), "name 'v1'");

    const outcome = await resumeOrRollbackRotation(grantId, pristineDir);

    expect(outcome).toBe("rolled-back");
    expect(existsSync(trashDir)).toBe(false);
    expect(readFileSync(path.join(finalDir, "fxmanifest.lua"), "utf8")).toBe("name 'v1'");
  });

  it("cleans stale .tmp.* dir when no trash exists (no-op beyond cleanup)", async () => {
    const grantId = 42;
    const tmpDir = path.join(pristineDir, `${grantId}.tmp.999.1.2`);
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(path.join(tmpDir, "partial.lua"), "crashed-mid-copy");

    const outcome = await resumeOrRollbackRotation(grantId, pristineDir);

    // No trash → nothing to resume or roll back, but .tmp.* gets cleaned as
    // part of self-heal.
    expect(outcome).toBe("resumed");
    expect(existsSync(tmpDir)).toBe(false);
  });
});
