/**
 * Integration tests for Task 18 — 4 failure-recovery scenarios.
 *
 * Each scenario deliberately injects a failure at a precise boundary in the
 * deploy pipeline, then re-runs the pipeline and asserts recovery behavior:
 * no orphaned files, typed error codes, and hints that point at the right
 * manual-recovery action.
 *
 * Simulation techniques:
 *   - "Process death" is simulated by patching `fs.promises.rename` (the only
 *     atomic-swap primitive in the deploy + rotate pipelines) with `vi.spyOn`
 *     to throw at a chosen call index.
 *   - Windows path-length is gated with `describe.skipIf` because Ubuntu's
 *     ext4 happily accepts 4096-char paths.
 *
 * Scenarios:
 *   1. Partial deploy — crash between live→backup and staging→live renames.
 *   2. Mid-rotation pristine corruption — crash between pristine→trash and
 *      staging→pristine renames inside rotatePristine.
 *   3. Windows path-length — path under <tmp>/<very-long-prefix>/ exceeds
 *      MAX_PATH; deploy must either succeed (longPathAware) or fail fast
 *      with a typed error BEFORE any writes.
 *   4. Concurrent deploy — two concurrent deploy_asset calls; second must
 *      throw LockHeldError.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import fsP from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import * as JSZipModule from "jszip";
import { cfx_deploy_asset } from "../../src/mcp/tools/deploy_asset.js";
import type { AssetState } from "../../src/lib/state/state.js";
import type { MappingFile, MappingEntry } from "../../src/lib/state/mapping.js";
import { LockHeldError, PathTooLongError } from "../../src/lib/errors.js";
import { StateLock } from "../../src/lib/state/lock.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const JSZip: any = (JSZipModule as any).default ?? JSZipModule;

// ---------------------------------------------------------------------------
// Fixture helpers (duplicated from preservation.test.ts to keep this file
// self-contained; the patterns are load-bearing so we want them inline).
// ---------------------------------------------------------------------------

interface Fixture {
  tmp: string;
  stateDir: string;
  srvDir: string;
  target: string;
  cacheDir: string;
  stagingDir: string;
  backupDir: string;
  pristineDir: string;
  pristineHistoryDir: string;
  conflictDir: string;
}

function setupEnv(f: Fixture): void {
  process.env.CFX_SERVER_RESOURCES = f.srvDir;
  process.env.CFX_STATE_DIR = f.stateDir;
  process.env.CFX_CACHE_DIR = f.cacheDir;
  process.env.CFX_STAGING_DIR = f.stagingDir;
  process.env.CFX_BACKUP_DIR = f.backupDir;
  process.env.CFX_COOKIE_FILE = path.join(f.tmp, ".cookies.json");
  process.env.CFX_PRISTINE_DIR = f.pristineDir;
  process.env.CFX_PRISTINE_HISTORY_DIR = f.pristineHistoryDir;
  process.env.CFX_CONFLICT_DIR = f.conflictDir;
  delete process.env.CFX_SYNC_PRESERVE;
}

function mkFixture(prefix = "cfx-recovery-int-"): Fixture {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  const stateDir = path.join(tmp, "state");
  const srvDir = path.join(tmp, "srv", "[category]");
  const target = path.join(srvDir, "my_asset");
  const f: Fixture = {
    tmp,
    stateDir,
    srvDir,
    target,
    cacheDir: path.join(tmp, "cache"),
    stagingDir: path.join(tmp, "staging"),
    backupDir: path.join(tmp, "backups"),
    pristineDir: path.join(tmp, "pristine"),
    pristineHistoryDir: path.join(tmp, "pristine-history"),
    conflictDir: path.join(tmp, "conflicts"),
  };
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(srvDir, { recursive: true });
  mkdirSync(f.cacheDir, { recursive: true });
  mkdirSync(f.stagingDir, { recursive: true });
  return f;
}

function writeMapping(stateDir: string, entries: Record<string, MappingEntry>): void {
  const file: MappingFile = {
    version: 2,
    approvedAt: new Date().toISOString(),
    entries,
    newInstalls: [],
    orphaned: [],
  };
  writeFileSync(path.join(stateDir, "cfx-sync-map.json"), JSON.stringify(file, null, 2));
}

function writeState(stateDir: string, assets: AssetState[]): void {
  const data = {
    version: 3,
    rateLimit: {},
    assets: Object.fromEntries(assets.map((a) => [String(a.grantId), a])),
  };
  writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(data, null, 2));
}

function readState(stateDir: string): { assets: Record<string, AssetState> } {
  return JSON.parse(readFileSync(path.join(stateDir, "state.json"), "utf8")) as {
    assets: Record<string, AssetState>;
  };
}

async function makePackZip(
  cacheDir: string,
  slug: string,
  files: Record<string, string>
): Promise<string> {
  const zip = new JSZip();
  for (const [rel, content] of Object.entries(files)) {
    zip.file(`${slug}/${rel}`, content);
  }
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const out = path.join(cacheDir, `${slug}-${Date.now()}-${Math.random()}.zip`);
  writeFileSync(out, buf);
  return out;
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function hashesFrom(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rel, body] of Object.entries(files)) out[rel] = sha256(body);
  return out;
}

function makeEntry(target: string, slug = "my_asset"): MappingEntry {
  return {
    slug,
    target,
    disabled: false,
    assetName: "My Asset",
    discoveredTier: 1,
    discoveredConfidence: 1.0,
  };
}

function makeAssetState(
  grantId: number,
  zipPath: string,
  target: string,
  overrides: Partial<AssetState> = {}
): AssetState {
  return {
    grantId,
    assetId: grantId,
    slug: "my_asset",
    assetName: "My Asset",
    versionId: 10,
    packId: 1,
    updatedAt: "2026-04-18T00:00:00.000Z",
    sha256: "deadbeef",
    cachedZipPath: zipPath,
    deployedPath: target,
    deployedAt: "",
    backups: [],
    pristineVersionId: null,
    pristineCapturedAt: null,
    pristineHashes: null,
    ...overrides,
  };
}

function seedLive(target: string, files: Record<string, string>): void {
  mkdirSync(target, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(target, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("integration: Task 18 — failure-recovery scenarios", () => {
  let f: Fixture;
  const grantId = 42;

  beforeEach(() => {
    f = mkFixture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CFX_SYNC_PRESERVE;
    delete process.env.CFX_PRISTINE_DIR;
    delete process.env.CFX_PRISTINE_HISTORY_DIR;
    delete process.env.CFX_CONFLICT_DIR;
    rmSync(f.tmp, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Partial deploy — crash between live→backup and staging→live.
  //
  // Deploy pipeline's critical section inside deployer.ts:
  //   1. moveAtomic(targetPath, backupResourcePath)    ← RENAME 1
  //   2. writeFile(manifest.json, ...)                 ← non-rename
  //   3. moveAtomic(stagingRoot, targetPath)           ← RENAME 2
  //
  // We intercept the SECOND fs.rename call that touches `targetPath` (the
  // staging→live swap) to simulate a kill at that exact boundary. Post-crash
  // disk state: backup dir + manifest present, staging-root still present,
  // live dir MISSING.
  //
  // Then we drop the patch and re-run cfx_deploy_asset to assert recovery
  // behavior. Acceptance: deploy either completes cleanly OR throws a typed
  // DeployInterruptedError that names the staging + backup paths.
  // -------------------------------------------------------------------------
  it("Scenario 1: partial deploy (backup done, staging→live incomplete) — recovery", async () => {
    setupEnv(f);

    // Start from a first-deploy world so the swap path is exercised (target
    // exists, pristine absent → first-deploy mode, destinationExists=true).
    const v1Files = { "fxmanifest.lua": "v1", "server.lua": "print('v1')" };
    seedLive(f.target, v1Files);

    const v2Files = { "fxmanifest.lua": "v2", "server.lua": "print('v2')" };
    const zipPath = await makePackZip(f.cacheDir, "my_asset", v2Files);

    writeMapping(f.stateDir, { [String(grantId)]: makeEntry(f.target) });
    writeState(f.stateDir, [
      makeAssetState(grantId, zipPath, f.target, {
        versionId: 10,
        // deployedAt set so dryRun doesn't auto-flip to true.
        deployedAt: "2026-04-17T00:00:00.000Z",
      }),
    ]);

    // Inject failure: on the 2nd call whose destination equals `entry.target`
    // (the staging→live rename), throw. The 1st call with that destination
    // is... wait: actually, the FIRST rename in deploy() has `src=targetPath,
    // dst=backupResourcePath` — destination is NOT targetPath. The SECOND
    // rename has `src=stagingRoot, dst=targetPath`. So we match on
    // destination == f.target, first hit.
    const realRename = fsP.rename.bind(fsP);
    const renameSpy = vi.spyOn(fsP, "rename").mockImplementation(async (src, dst) => {
      if (String(dst) === f.target) {
        // Simulate process kill mid-swap. Throw a synthetic IO error that
        // deploy() will surface. The live dir is gone (renamed away in step 1),
        // staging is still in place (we never completed the 2nd rename),
        // backup has content + manifest.
        throw Object.assign(new Error("SIMULATED_CRASH: process killed mid-swap"), {
          code: "EIO",
        });
      }
      return realRename(src, dst);
    });

    // First call — fails inside deploy(). The original error propagates.
    await expect(cfx_deploy_asset({ grantId, dryRun: false })).rejects.toThrow(
      /SIMULATED_CRASH|mid-swap/
    );

    // Post-crash state: live is gone (step 1 moved it away).
    expect(existsSync(f.target)).toBe(false);
    // Backup dir contains the prior live under `resource/` + a manifest.
    const slugBackupDir = path.join(f.backupDir, "my_asset");
    expect(existsSync(slugBackupDir)).toBe(true);
    const backupIsos = readdirSync(slugBackupDir);
    expect(backupIsos.length).toBe(1);
    const backupIso = backupIsos[0]!;
    const backupResource = path.join(slugBackupDir, backupIso, "resource");
    expect(existsSync(backupResource)).toBe(true);
    expect(readFileSync(path.join(backupResource, "fxmanifest.lua"), "utf8")).toBe("v1");
    // The staging extract dir is also still on disk (the catch in
    // deploy_asset's try/catch fires rm of unzip.root — but its rename failed
    // AFTER the unzip succeeded, so staging dir is indeed removed as cleanup.
    // We can't easily assert its path here; the interesting assertion is
    // below — that recovery produces a consistent world.)

    // Drop the patch and re-run. The second deploy sees:
    //   - entry.target missing → hashTreeIfExists returns empty
    //   - state still has pristineHashes=null (first-deploy flow)
    //   - stateEntry.cachedZipPath still points at the valid pack zip
    // Expected behavior: deploy completes successfully, live is populated,
    // and we don't double-throw.
    //
    // ACCEPTANCE: either we throw DeployInterruptedError with staging+backup
    // paths (explicit recovery prompt) OR we silently complete the swap
    // (implicit recovery). The spec's wording is "resume swap OR throw
    // DeployInterruptedError". The current implementation does NEITHER
    // explicitly — it silently re-deploys because hashTreeIfExists handles
    // the missing live dir. That's functionally a resume, but it doesn't
    // reconcile the orphan backup from the aborted run.
    renameSpy.mockRestore();

    const recoverResult = await cfx_deploy_asset({ grantId, dryRun: false });

    // Recovery succeeded — live is populated with v2 content.
    expect(existsSync(f.target)).toBe(true);
    expect(readFileSync(path.join(f.target, "fxmanifest.lua"), "utf8")).toBe("v2");
    // State was updated with the successful deploy.
    const stateAfter = readState(f.stateDir).assets[String(grantId)]!;
    expect(stateAfter.deployedAt).not.toBe("");
    // preservationMode will be "first-deploy" again since pristineHashes was
    // still null after the aborted run (state was never saved).
    expect(recoverResult.preservationMode).toBe("first-deploy");
    // The orphan backup from the crashed attempt is still on disk — it
    // wasn't rolled up into this deploy's backup chain. This is a GAP in
    // the recovery story: the crashed backup is effectively orphaned and
    // will only be cleaned by the retain policy over time. See report.
    const backupIsosAfter = readdirSync(slugBackupDir);
    // Recovery created at most one new backup; the crashed one survives
    // (either as the sole backup or alongside it).
    expect(backupIsosAfter.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Mid-rotation pristine corruption.
  //
  // During rotatePristine the critical sequence is:
  //   1. cp(staging → pristineDir/<id>.tmp.<...>)
  //   2. rename(pristineDir/<id> → pristineDir/<id>.old.<iso>)   ← RENAME 1
  //   3. rename(pristineDir/<id>.tmp.<...> → pristineDir/<id>)   ← RENAME 2
  //   4. rm(pristineDir/<id>.old.<iso>)
  //
  // We inject failure on rename #3 (step 3). Post-crash:
  //   - <id>/ is missing (moved to .old.<iso>)
  //   - <id>.old.<iso>/ has the previous pristine
  //   - <id>.tmp.<...>/ has the new pristine ready
  //
  // The recovery path lives in resumeOrRollbackRotation which rotatePristine
  // calls at the start of every invocation.
  //
  // GAP FOUND: In the deploy_asset pipeline, deploy() runs BEFORE
  // rotatePristine(). If rotate fails after deploy succeeds, live is already
  // swapped (v2) but pristine + state still reflect v1. On retry, the diff
  // engine sees live=v2 vs pristine=v1 vs pack=v2 → row 4 (both changed from
  // pristine), which throws ConflictsUnresolvedError. The rotation-level
  // self-heal (resumeOrRollbackRotation) never runs because diff gates
  // control flow upstream.
  //
  // Manual recovery: operator either (a) passes conflictResolutions mapping
  // every path to take-pack, OR (b) runs cfx_reset_pristine <grantId> to
  // wipe the baseline and re-capture via first-deploy mode. Neither is
  // automatic.
  //
  // See report for recommended fix (e.g. add a post-deploy "pristine stale"
  // detector that re-rotates in-line before returning to the caller).
  // -------------------------------------------------------------------------
  it("Scenario 2: mid-rotation pristine corruption — surfaces ConflictsUnresolvedError on retry (recovery gap)", async () => {
    setupEnv(f);

    // Seed a complete v1 world: live + pristine both = v1.
    const v1Files = { "fxmanifest.lua": "v1", "server.lua": "print('v1')" };
    seedLive(f.target, v1Files);
    mkdirSync(path.join(f.pristineDir, String(grantId)), { recursive: true });
    for (const [rel, body] of Object.entries(v1Files)) {
      writeFileSync(path.join(f.pristineDir, String(grantId), rel), body);
    }

    // Pack ships v2.
    const v2Files = { "fxmanifest.lua": "v2", "server.lua": "print('v2')" };
    const zipPath = await makePackZip(f.cacheDir, "my_asset", v2Files);

    writeMapping(f.stateDir, { [String(grantId)]: makeEntry(f.target) });
    writeState(f.stateDir, [
      makeAssetState(grantId, zipPath, f.target, {
        versionId: 11,
        deployedAt: "2026-04-17T00:00:00.000Z",
        pristineVersionId: 10,
        pristineCapturedAt: "2026-04-17T00:00:00.000Z",
        pristineHashes: hashesFrom(v1Files),
      }),
    ]);

    // Patch fs.promises.rename to throw on the pristine rotation swap.
    // Identify it by destination path = `<pristineDir>/<grantId>` (the
    // final slot). First time we see that as the destination, throw.
    const finalPristinePath = path.join(f.pristineDir, String(grantId));
    const realRename = fsP.rename.bind(fsP);
    let tripped = false;
    const renameSpy = vi.spyOn(fsP, "rename").mockImplementation(async (src, dst) => {
      const dstStr = String(dst);
      // The rotate sequence renames to finalPristinePath exactly once, from
      // the .tmp.<...> dir. Trip on that rename only.
      if (
        !tripped &&
        dstStr === finalPristinePath &&
        String(src).includes(`${grantId}.tmp.`)
      ) {
        tripped = true;
        throw Object.assign(
          new Error("SIMULATED_CRASH: process killed mid-pristine-rotation"),
          { code: "EIO" }
        );
      }
      return realRename(src, dst);
    });

    await expect(cfx_deploy_asset({ grantId, dryRun: false })).rejects.toThrow(
      /SIMULATED_CRASH|mid-pristine-rotation/
    );

    // Post-crash ground truth: deploy() completed (live swapped to v2). Rotate
    // failed on rename #2. Either:
    //   - finalDir missing + .old.<iso> trash present + .tmp.<...> left behind
    //   - OR the rollback in rotate's catch moved trash back to finalDir
    //     (rotate has a best-effort cleanup that rolls trash back when
    //     finalDir is empty — see rotate.ts lines 100-125)
    // The catch in rotate rolled `.old.<iso>` back to finalDir, so we expect
    // finalDir to hold v1 content again.
    expect(readFileSync(path.join(f.target, "fxmanifest.lua"), "utf8")).toBe("v2");
    // state.save never ran, so stored hashes still reflect v1.
    const stateAfterCrash = readState(f.stateDir).assets[String(grantId)]!;
    expect(stateAfterCrash.pristineVersionId).toBe(10);

    // Drop patch; retry deploy.
    renameSpy.mockRestore();

    // RECOVERY GAP: diff engine sees live=v2 vs pristine=v1 vs pack=v2 → row 4
    // for every differing file (both live and pack changed from pristine).
    // Deploy throws ConflictsUnresolvedError. Operator must either pass
    // conflictResolutions or run cfx_reset_pristine <grantId>.
    //
    // This asserts the CURRENT behavior so a future fix (e.g. "if pristine is
    // stale relative to live, re-run rotation inline") will surface as a red
    // test — flipping the assertion is the intended signal.
    await expect(cfx_deploy_asset({ grantId, dryRun: false })).rejects.toMatchObject({
      code: "CONFLICTS_UNRESOLVED",
    });

    // Manual recovery path #1: operator resolves every row to take-pack.
    // (Bytes are identical anyway since live==pack==v2.)
    const recoverResult = await cfx_deploy_asset({
      grantId,
      dryRun: false,
      conflictResolutions: {
        "fxmanifest.lua": "take-pack",
        "server.lua": "take-pack",
      },
    });
    expect(recoverResult.preservationMode).toBe("layer-2");
    // After successful recovery, rotate self-heals (resumeOrRollbackRotation
    // at top of rotatePristine cleans any leftover .old/.tmp; rotate then
    // builds new pristine from the deployed live).
    const pristineSiblings = readdirSync(f.pristineDir).filter(
      (n) => n.startsWith(`${grantId}.tmp.`) || n.startsWith(`${grantId}.old.`)
    );
    expect(pristineSiblings).toEqual([]);
    expect(readFileSync(path.join(finalPristinePath, "fxmanifest.lua"), "utf8")).toBe("v2");
    const stateAfter = readState(f.stateDir).assets[String(grantId)]!;
    expect(stateAfter.pristineVersionId).toBe(11);
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Windows path length.
  //
  // Windows MAX_PATH is 260 chars unless the process opts in to long-path
  // awareness (requires manifest + registry). Our state/pristine layout is
  // `<stateDir>/pristine/<grantId>/<pack-rel-path>` — for a deeply nested
  // pack this can blow past MAX_PATH without long-path awareness.
  //
  // Acceptance (tightened post-gap-#3): deploy throws a typed PathTooLongError
  // BEFORE any filesystem mutation of the live target. No partial writes.
  // A raw ENAMETOOLONG/EIO is a regression (gap re-opened).
  //
  // Windows-only; skip on Linux/macOS where longpaths are trivial.
  // -------------------------------------------------------------------------
  describe.skipIf(process.platform !== "win32")("Scenario 3: Windows path length", () => {
    it("deploy throws typed PathTooLongError and writes nothing to the live target", async () => {
      // Build a long-prefixed fixture by nesting mkdtemp underneath a chain
      // of 40-char dirs. Total prefix ~260 chars, so any pack with a
      // 6-deep internal path trivially exceeds MAX_PATH.
      const longPrefix = Array.from({ length: 6 }, (_, i) =>
        `longdir_${String(i).padStart(3, "0")}_` + "x".repeat(30)
      ).join(path.sep);
      const root = mkdtempSync(path.join(tmpdir(), "cfx-longpath-"));
      const deepRoot = path.join(root, longPrefix);
      mkdirSync(deepRoot, { recursive: true });

      const longF = mkFixture("cfx-longpath-fixture-");
      // Override stateDir + pristineDir to live under the deep prefix.
      longF.stateDir = path.join(deepRoot, "state");
      longF.pristineDir = path.join(deepRoot, "pristine");
      longF.pristineHistoryDir = path.join(deepRoot, "pristine-history");
      longF.conflictDir = path.join(deepRoot, "conflicts");
      longF.backupDir = path.join(deepRoot, "backups");
      longF.cacheDir = path.join(deepRoot, "cache");
      longF.stagingDir = path.join(deepRoot, "staging");
      longF.srvDir = path.join(deepRoot, "srv", "[category]");
      longF.target = path.join(longF.srvDir, "my_asset");
      mkdirSync(longF.stateDir, { recursive: true });
      mkdirSync(longF.srvDir, { recursive: true });
      mkdirSync(longF.cacheDir, { recursive: true });
      mkdirSync(longF.stagingDir, { recursive: true });

      setupEnv(longF);

      // Pack with a 6-deep internal dir structure.
      const deepPath = Array.from({ length: 6 }, (_, i) =>
        `sub_${String(i).padStart(3, "0")}_` + "y".repeat(30)
      ).join("/");
      const packFiles: Record<string, string> = {
        "fxmanifest.lua": "name 'deep'",
        [`${deepPath}/file.lua`]: "print('deep')",
      };
      const zipPath = await makePackZip(longF.cacheDir, "my_asset", packFiles);

      writeMapping(longF.stateDir, { [String(grantId)]: makeEntry(longF.target) });
      writeState(longF.stateDir, [makeAssetState(grantId, zipPath, longF.target)]);

      let caught: unknown = null;
      try {
        await cfx_deploy_asset({ grantId, dryRun: false });
      } catch (err) {
        caught = err;
      }

      // Must throw the typed preflight error — never a raw ENAMETOOLONG/EIO.
      expect(caught).toBeInstanceOf(PathTooLongError);
      const pathErr = caught as PathTooLongError;
      expect(pathErr.code).toBe("PATH_TOO_LONG");
      expect(pathErr.length).toBeGreaterThan(260);
      expect(pathErr.limit).toBe(260);
      // `path` field matches the length field reported by the error — projected
      // live path, not the pack-relative one.
      expect(pathErr.path.length).toBe(pathErr.length);
      expect(pathErr.hint ?? "").toMatch(/long-path|CFX_STATE_DIR/i);

      // No files written to the live target. Preflight fires AFTER unzip but
      // BEFORE applyPlan/deploy, so live must be absent (we never seeded it).
      expect(existsSync(longF.target)).toBe(false);
      // State was not mutated — deployedAt remains "".
      const stateAfter = readState(longF.stateDir).assets[String(grantId)]!;
      expect(stateAfter.deployedAt).toBe("");

      rmSync(root, { recursive: true, force: true });
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Concurrent deploy.
  //
  // StateLock is a cross-process primitive — it writes `<stateDir>/state.lock`
  // with `{pid, acquiredAt}` and rejects `acquire()` if `prior.pid` is alive.
  // The intended semantics are "only one cfx-sync process at a time".
  //
  // We simulate a concurrent process by writing a lockfile with our OWN pid
  // (process.pid is always alive) BEFORE invoking deploy. The acquire() check
  // reads the file, sees the live pid, and throws LockHeldError.
  //
  // NOTE: true intra-process `Promise.all([deploy_asset(), deploy_asset()])`
  // is a RACE in the current lock code — both acquires may complete before
  // either observes the file. That's a known gap (see report); the lock is
  // designed for process-level, not coroutine-level, isolation.
  // -------------------------------------------------------------------------
  it("Scenario 4: second deploy throws LockHeldError when lockfile shows a live PID", async () => {
    setupEnv(f);

    const v1Files = { "fxmanifest.lua": "v1", "server.lua": "print('v1')" };
    const zipPath = await makePackZip(f.cacheDir, "my_asset", v1Files);

    writeMapping(f.stateDir, { [String(grantId)]: makeEntry(f.target) });
    writeState(f.stateDir, [makeAssetState(grantId, zipPath, f.target)]);

    // Simulate another process holding the lock by pre-writing a lockfile
    // with our own PID (always alive). The production acquire() flow reads
    // this and rejects.
    const lockPath = path.join(f.stateDir, "state.lock");
    mkdirSync(f.stateDir, { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
      { mode: 0o600 }
    );

    // Now invoke deploy — acquire() should throw LockHeldError before any
    // mutation happens.
    let caught: unknown = null;
    try {
      await cfx_deploy_asset({ grantId, dryRun: false });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LockHeldError);
    expect((caught as LockHeldError).code).toBe("LOCK_HELD");
    // Hint tells the operator how to recover (wait, or --force-unlock).
    expect((caught as LockHeldError).hint ?? "").toMatch(/force-unlock|Wait/);

    // No partial disk mutation: live is still absent (never deployed).
    expect(existsSync(f.target)).toBe(false);
    // Our pre-written lockfile is still there (acquire() refused to overwrite it).
    expect(existsSync(lockPath)).toBe(true);

    // Cleanup: release the "other process" lock. Verify a deploy now
    // completes normally — i.e. LockHeldError was the only thing blocking.
    const lock = new StateLock(f.stateDir);
    await lock.release();
    const out = await cfx_deploy_asset({ grantId, dryRun: false });
    expect(out.preservationMode).toBe("first-deploy");
    expect(existsSync(path.join(f.target, "fxmanifest.lua"))).toBe(true);
  });
});
