import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
} from "node:fs";
import fsP from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { applyPlan } from "../../../src/lib/preservation/applyPlan.js";
import {
  ConflictsUnresolvedError,
  CaseCollisionDetectedError,
  EncryptedTamperDetectedError,
} from "../../../src/lib/errors.js";
import type { PlanRow, DeployPlan } from "../../../src/lib/preservation/types.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function readFile(root: string, rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

function fileExists(root: string, rel: string): boolean {
  return existsSync(path.join(root, rel));
}

function makePlan(rows: PlanRow[]): DeployPlan {
  return {
    rows,
    blockers: rows.filter((r) => r.decision === "blocker"),
    conflicts: rows.filter((r) => r.decision === "conflict"),
    packValidationFailures: [],
  };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("applyPlan", () => {
  let workDir: string;
  let liveRoot: string;
  let stagingRoot: string;
  let conflictDir: string;
  const grantId = 42;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "cfx-applyplan-"));
    liveRoot = path.join(workDir, "live");
    stagingRoot = path.join(workDir, "staging");
    conflictDir = path.join(workDir, "state", "conflicts");
    mkdirSync(liveRoot, { recursive: true });
    mkdirSync(stagingRoot, { recursive: true });
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // preserve-live
  // -------------------------------------------------------------------------

  describe("preserve-live", () => {
    it("copies live bytes into staging at the same path (user-modified file)", async () => {
      writeFile(liveRoot, "config/server.lua", "USER-EDITED");
      writeFile(stagingRoot, "config/server.lua", "PACK-VERSION");

      await applyPlan({
        plan: makePlan([
          {
            path: "config/server.lua",
            decision: "preserve-live",
            rowNumber: 3,
            pristineSha: "p",
            liveSha: "l",
            packSha: "k",
          },
        ]),
        liveRoot,
        stagingRoot,
        conflictDir,
        grantId,
      });

      expect(readFile(stagingRoot, "config/server.lua")).toBe("USER-EDITED");
    });

    it("copies live-only orphan files into staging (row 5)", async () => {
      writeFile(liveRoot, "config/custom_admin.lua", "LOCAL-ORPHAN");
      // Staging has NO such file (pack doesn't ship it).

      await applyPlan({
        plan: makePlan([
          {
            path: "config/custom_admin.lua",
            decision: "preserve-live",
            rowNumber: 5,
            liveSha: "l",
          },
        ]),
        liveRoot,
        stagingRoot,
        conflictDir,
        grantId,
      });

      expect(readFile(stagingRoot, "config/custom_admin.lua")).toBe("LOCAL-ORPHAN");
    });

    it("creates parent dirs in staging when copying live files", async () => {
      writeFile(liveRoot, "deeply/nested/sub/file.lua", "X");

      await applyPlan({
        plan: makePlan([
          {
            path: "deeply/nested/sub/file.lua",
            decision: "preserve-live",
            rowNumber: 5,
            liveSha: "l",
          },
        ]),
        liveRoot,
        stagingRoot,
        conflictDir,
        grantId,
      });

      expect(fileExists(stagingRoot, "deeply/nested/sub/file.lua")).toBe(true);
      expect(readFile(stagingRoot, "deeply/nested/sub/file.lua")).toBe("X");
    });
  });

  // -------------------------------------------------------------------------
  // take-newPack
  // -------------------------------------------------------------------------

  describe("take-newPack", () => {
    it("leaves staging untouched when packSha is defined (adopt pack)", async () => {
      writeFile(stagingRoot, "config/server.lua", "NEW-PACK-VERSION");
      writeFile(liveRoot, "config/server.lua", "OLD-LIVE");

      await applyPlan({
        plan: makePlan([
          {
            path: "config/server.lua",
            decision: "take-newPack",
            rowNumber: 2,
            pristineSha: "p",
            liveSha: "l",
            packSha: "k",
          },
        ]),
        liveRoot,
        stagingRoot,
        conflictDir,
        grantId,
      });

      expect(readFile(stagingRoot, "config/server.lua")).toBe("NEW-PACK-VERSION");
    });

    it("deletes file from staging when packSha is undefined (pack dropped unchanged file)", async () => {
      // Simulates row-2 "pack removed a file user hasn't edited" — diffEngine
      // emits take-newPack with packSha undefined as the deletion signal.
      // Staging was pre-populated from live by the deployer; applyPlan must delete.
      writeFile(stagingRoot, "config/old_feature.lua", "TO-BE-DELETED");
      writeFile(liveRoot, "config/old_feature.lua", "LIVE-COPY");

      await applyPlan({
        plan: makePlan([
          {
            path: "config/old_feature.lua",
            decision: "take-newPack",
            rowNumber: 2,
            pristineSha: "p",
            liveSha: "l",
            // packSha intentionally undefined
          },
        ]),
        liveRoot,
        stagingRoot,
        conflictDir,
        grantId,
      });

      expect(fileExists(stagingRoot, "config/old_feature.lua")).toBe(false);
    });

    it("no-op when staging already lacks the file and packSha undefined", async () => {
      // Deletion of a file that isn't in staging — must not throw.
      await expect(
        applyPlan({
          plan: makePlan([
            {
              path: "nope.lua",
              decision: "take-newPack",
              rowNumber: 2,
              pristineSha: "p",
              liveSha: "l",
            },
          ]),
          liveRoot,
          stagingRoot,
          conflictDir,
          grantId,
        })
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // take-newPack-rename
  // -------------------------------------------------------------------------

  describe("take-newPack-rename", () => {
    it("file appears at newPath and disappears from oldPath in staging", async () => {
      // Simulates vendor rename: staging comes from deployer pre-populated with
      // the user's live tree (pre-pack-overlay). Staging has the old path.
      // After applyPlan, new path should be present (from pack contents that
      // the deployer overlays later), and old path should be removed.
      //
      // In practice, the deployer applies the pack overlay BEFORE applyPlan,
      // so staging already has the newPath bytes. applyPlan's job is to
      // remove the stale oldPath entry from staging.
      writeFile(stagingRoot, "config/old_name.lua", "CARRIED-FROM-LIVE");
      writeFile(stagingRoot, "config/new_name.lua", "PACK-VERSION");

      await applyPlan({
        plan: makePlan([
          {
            path: "config/new_name.lua",
            decision: "take-newPack-rename",
            rowNumber: 7,
            rename: { oldPath: "config/old_name.lua", newPath: "config/new_name.lua" },
            pristineSha: "p",
            packSha: "k",
          },
        ]),
        liveRoot,
        stagingRoot,
        conflictDir,
        grantId,
      });

      expect(fileExists(stagingRoot, "config/old_name.lua")).toBe(false);
      expect(readFile(stagingRoot, "config/new_name.lua")).toBe("PACK-VERSION");
    });
  });

  // -------------------------------------------------------------------------
  // staged-for-merge
  // -------------------------------------------------------------------------

  describe("staged-for-merge", () => {
    it("writes .live + .pack sidecars and removes file from staging", async () => {
      writeFile(liveRoot, "config/server.lua", "USER-CONTENT");
      writeFile(stagingRoot, "config/server.lua", "PACK-CONTENT");

      await applyPlan({
        plan: makePlan([
          {
            path: "config/server.lua",
            decision: "conflict",
            rowNumber: 4,
            resolution: "staged-for-merge",
            conflictOptions: [
              "take-live",
              "take-pack",
              "merge-diff3",
              "staged-for-merge",
            ],
            pristineSha: "p",
            liveSha: "l",
            packSha: "k",
          },
        ]),
        liveRoot,
        stagingRoot,
        conflictDir,
        grantId,
      });

      // Staging no longer has the conflicted file (so deploy skips it and
      // live keeps whatever it has until operator resolves manually).
      expect(fileExists(stagingRoot, "config/server.lua")).toBe(false);

      const conflictGrantDir = path.join(conflictDir, String(grantId));
      const liveSidecar = path.join(conflictGrantDir, "config/server.lua.live");
      const packSidecar = path.join(conflictGrantDir, "config/server.lua.pack");

      expect(existsSync(liveSidecar)).toBe(true);
      expect(existsSync(packSidecar)).toBe(true);
      expect(readFileSync(liveSidecar, "utf8")).toBe("USER-CONTENT");
      expect(readFileSync(packSidecar, "utf8")).toBe("PACK-CONTENT");
    });

    it("creates nested conflict dirs as needed", async () => {
      writeFile(liveRoot, "deep/nested/dir/file.lua", "L");
      writeFile(stagingRoot, "deep/nested/dir/file.lua", "P");

      await applyPlan({
        plan: makePlan([
          {
            path: "deep/nested/dir/file.lua",
            decision: "conflict",
            rowNumber: 4,
            resolution: "staged-for-merge",
            conflictOptions: ["staged-for-merge"],
            liveSha: "l",
            packSha: "k",
          },
        ]),
        liveRoot,
        stagingRoot,
        conflictDir,
        grantId,
      });

      const liveSidecar = path.join(
        conflictDir,
        String(grantId),
        "deep/nested/dir/file.lua.live"
      );
      expect(existsSync(liveSidecar)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // take-live-at-new-path
  // -------------------------------------------------------------------------

  describe("take-live-at-new-path (row 8 resolution)", () => {
    it("copies user's old-path content to newPath and removes oldPath from staging", async () => {
      // User modified config/old.lua; pack renamed to config/new.lua.
      // Operator chose: take their edits at the new path.
      writeFile(liveRoot, "config/old.lua", "USER-EDITED-AT-OLD-PATH");
      // Deployer pre-populated staging with live tree AND pack overlay:
      writeFile(stagingRoot, "config/old.lua", "USER-EDITED-AT-OLD-PATH");
      writeFile(stagingRoot, "config/new.lua", "PACK-VERSION");

      await applyPlan({
        plan: makePlan([
          {
            path: "config/new.lua",
            decision: "conflict",
            rowNumber: 8,
            resolution: "take-live-at-new-path",
            rename: { oldPath: "config/old.lua", newPath: "config/new.lua" },
            conflictOptions: ["take-live-at-new-path", "take-live-at-old-path"],
            pristineSha: "p",
            liveSha: "l",
            packSha: "k",
          },
        ]),
        liveRoot,
        stagingRoot,
        conflictDir,
        grantId,
      });

      expect(readFile(stagingRoot, "config/new.lua")).toBe("USER-EDITED-AT-OLD-PATH");
      expect(fileExists(stagingRoot, "config/old.lua")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // take-live-at-old-path
  // -------------------------------------------------------------------------

  describe("take-live-at-old-path (row 8 resolution)", () => {
    it("keeps oldPath with user's edits and removes newPath (rejecting rename)", async () => {
      writeFile(liveRoot, "config/old.lua", "USER-EDITED-AT-OLD-PATH");
      // Deployer pre-populated staging with live tree AND pack overlay:
      writeFile(stagingRoot, "config/old.lua", "USER-EDITED-AT-OLD-PATH");
      writeFile(stagingRoot, "config/new.lua", "PACK-VERSION");

      await applyPlan({
        plan: makePlan([
          {
            path: "config/new.lua",
            decision: "conflict",
            rowNumber: 8,
            resolution: "take-live-at-old-path",
            rename: { oldPath: "config/old.lua", newPath: "config/new.lua" },
            conflictOptions: ["take-live-at-old-path"],
            pristineSha: "p",
            liveSha: "l",
            packSha: "k",
          },
        ]),
        liveRoot,
        stagingRoot,
        conflictDir,
        grantId,
      });

      expect(readFile(stagingRoot, "config/old.lua")).toBe("USER-EDITED-AT-OLD-PATH");
      expect(fileExists(stagingRoot, "config/new.lua")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // merge-diff3 stub
  // -------------------------------------------------------------------------

  describe("merge-diff3 (NotImplementedYet stub)", () => {
    it("throws with hint pointing at staged-for-merge", async () => {
      writeFile(liveRoot, "config/server.lua", "L");
      writeFile(stagingRoot, "config/server.lua", "P");

      await expect(
        applyPlan({
          plan: makePlan([
            {
              path: "config/server.lua",
              decision: "conflict",
              rowNumber: 4,
              resolution: "merge-diff3",
              conflictOptions: ["merge-diff3", "staged-for-merge"],
              liveSha: "l",
              packSha: "k",
            },
          ]),
          liveRoot,
          stagingRoot,
          conflictDir,
          grantId,
        })
      ).rejects.toThrow(/staged-for-merge/);
    });
  });

  // -------------------------------------------------------------------------
  // drop
  // -------------------------------------------------------------------------

  describe("drop", () => {
    it("removes file from staging (deletion from pristine that live already lacks)", async () => {
      // Row 6: file was in pristine but neither in live nor in pack. Staging
      // shouldn't have it either (pack didn't overlay one), but if the deployer
      // pre-populated from live it won't — so drop is usually no-op. Still,
      // applyPlan must handle it without throwing.
      await expect(
        applyPlan({
          plan: makePlan([
            {
              path: "config/gone.lua",
              decision: "drop",
              rowNumber: 6,
              pristineSha: "p",
            },
          ]),
          liveRoot,
          stagingRoot,
          conflictDir,
          grantId,
        })
      ).resolves.toBeUndefined();

      expect(fileExists(stagingRoot, "config/gone.lua")).toBe(false);
    });

    it("deletes the file when staging has it", async () => {
      writeFile(stagingRoot, "config/gone.lua", "SHOULD-BE-GONE");
      await applyPlan({
        plan: makePlan([
          {
            path: "config/gone.lua",
            decision: "drop",
            rowNumber: 6,
            pristineSha: "p",
          },
        ]),
        liveRoot,
        stagingRoot,
        conflictDir,
        grantId,
      });
      expect(fileExists(stagingRoot, "config/gone.lua")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  describe("error short-circuits", () => {
    it("throws ConflictsUnresolvedError when a conflict row has no resolution", async () => {
      writeFile(stagingRoot, "config/server.lua", "P");

      await expect(
        applyPlan({
          plan: makePlan([
            {
              path: "config/server.lua",
              decision: "conflict",
              rowNumber: 4,
              conflictOptions: ["take-live", "take-pack"],
              liveSha: "l",
              packSha: "k",
            },
          ]),
          liveRoot,
          stagingRoot,
          conflictDir,
          grantId,
        })
      ).rejects.toBeInstanceOf(ConflictsUnresolvedError);
    });

    it("ConflictsUnresolvedError includes the conflicting paths", async () => {
      try {
        await applyPlan({
          plan: makePlan([
            {
              path: "a.lua",
              decision: "conflict",
              rowNumber: 4,
              conflictOptions: ["take-live"],
            },
            {
              path: "b.lua",
              decision: "conflict",
              rowNumber: 4,
              conflictOptions: ["take-live"],
            },
          ]),
          liveRoot,
          stagingRoot,
          conflictDir,
          grantId,
        });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictsUnresolvedError);
        const paths = (err as ConflictsUnresolvedError).paths;
        expect(paths).toContain("a.lua");
        expect(paths).toContain("b.lua");
      }
    });

    it("throws CaseCollisionDetectedError before any mutation when blocker present", async () => {
      writeFile(stagingRoot, "other.lua", "ORIGINAL");

      await expect(
        applyPlan({
          plan: makePlan([
            {
              path: "Config.lua",
              decision: "blocker",
              rowNumber: 9,
              blockerCode: "CASE_COLLISION_DETECTED",
              blockerDetail: "case collision: Config.lua collides with config.lua",
            },
            {
              path: "other.lua",
              decision: "preserve-live",
              rowNumber: 5,
              liveSha: "l",
            },
          ]),
          liveRoot,
          stagingRoot,
          conflictDir,
          grantId,
        })
      ).rejects.toBeInstanceOf(CaseCollisionDetectedError);

      // Staging untouched — note "other.lua" was in live but NOT copied to staging.
      expect(readFile(stagingRoot, "other.lua")).toBe("ORIGINAL");
    });

    it("throws EncryptedTamperDetectedError before any mutation", async () => {
      writeFile(liveRoot, "encrypted/asset.fxap", "LIVE");
      writeFile(stagingRoot, "other.lua", "ORIGINAL");

      await expect(
        applyPlan({
          plan: makePlan([
            {
              path: "encrypted/asset.fxap",
              decision: "blocker",
              rowNumber: 10,
              blockerCode: "ENCRYPTED_TAMPER_DETECTED",
              blockerDetail: "live sha differs",
            },
            {
              path: "other.lua",
              decision: "preserve-live",
              rowNumber: 5,
              liveSha: "l",
            },
          ]),
          liveRoot,
          stagingRoot,
          conflictDir,
          grantId,
        })
      ).rejects.toBeInstanceOf(EncryptedTamperDetectedError);

      expect(readFile(stagingRoot, "other.lua")).toBe("ORIGINAL");
    });

    it("blocker short-circuit fires before conflict short-circuit", async () => {
      // If both blockers and unresolved conflicts exist, blocker takes precedence.
      await expect(
        applyPlan({
          plan: makePlan([
            {
              path: "X",
              decision: "conflict",
              rowNumber: 4,
              conflictOptions: ["take-live"],
            },
            {
              path: "Y",
              decision: "blocker",
              rowNumber: 9,
              blockerCode: "CASE_COLLISION_DETECTED",
              blockerDetail: "d",
            },
          ]),
          liveRoot,
          stagingRoot,
          conflictDir,
          grantId,
        })
      ).rejects.toBeInstanceOf(CaseCollisionDetectedError);
    });
  });

  // -------------------------------------------------------------------------
  // Multi-row end-to-end
  // -------------------------------------------------------------------------

  describe("multi-row plan", () => {
    it("applies a mixed plan deterministically", async () => {
      // live tree
      writeFile(liveRoot, "config/server.lua", "USER-EDITED");
      writeFile(liveRoot, "config/custom.lua", "LOCAL-ORPHAN");
      writeFile(liveRoot, "config/old.lua", "OLD-CONTENT");

      // staging tree (deployer pre-state: live overlaid with pack contents)
      writeFile(stagingRoot, "config/server.lua", "PACK-VERSION"); // conflict → take-pack style (decision: preserve-live)
      writeFile(stagingRoot, "fxmanifest.lua", "pack-manifest"); // pack-only (take-newPack adopt)
      writeFile(stagingRoot, "config/old.lua", "OLD-CONTENT");
      writeFile(stagingRoot, "config/new.lua", "RENAMED-CONTENT");
      writeFile(stagingRoot, "config/removed.lua", "TO-DELETE");

      await applyPlan({
        plan: makePlan([
          // preserve-live: user's file wins
          {
            path: "config/server.lua",
            decision: "preserve-live",
            rowNumber: 3,
            pristineSha: "p",
            liveSha: "l",
            packSha: "k",
          },
          // preserve-live: orphan
          {
            path: "config/custom.lua",
            decision: "preserve-live",
            rowNumber: 5,
            liveSha: "l",
          },
          // take-newPack (adopt): staging untouched
          {
            path: "fxmanifest.lua",
            decision: "take-newPack",
            rowNumber: 2,
            pristineSha: "p",
            liveSha: "l",
            packSha: "k",
          },
          // take-newPack (deletion): remove from staging
          {
            path: "config/removed.lua",
            decision: "take-newPack",
            rowNumber: 2,
            pristineSha: "p",
            liveSha: "l",
          },
          // take-newPack-rename
          {
            path: "config/new.lua",
            decision: "take-newPack-rename",
            rowNumber: 7,
            rename: { oldPath: "config/old.lua", newPath: "config/new.lua" },
            pristineSha: "p",
            packSha: "k",
          },
        ]),
        liveRoot,
        stagingRoot,
        conflictDir,
        grantId,
      });

      // Final staging state
      expect(readFile(stagingRoot, "config/server.lua")).toBe("USER-EDITED");
      expect(readFile(stagingRoot, "config/custom.lua")).toBe("LOCAL-ORPHAN");
      expect(readFile(stagingRoot, "fxmanifest.lua")).toBe("pack-manifest");
      expect(fileExists(stagingRoot, "config/removed.lua")).toBe(false);
      expect(readFile(stagingRoot, "config/new.lua")).toBe("RENAMED-CONTENT");
      expect(fileExists(stagingRoot, "config/old.lua")).toBe(false);
    });

    it("empty plan is a no-op", async () => {
      writeFile(stagingRoot, "x", "x");
      await applyPlan({
        plan: makePlan([]),
        liveRoot,
        stagingRoot,
        conflictDir,
        grantId,
      });
      expect(readFile(stagingRoot, "x")).toBe("x");
    });
  });

  // -------------------------------------------------------------------------
  // grantId as string
  // -------------------------------------------------------------------------

  describe("grantId variants", () => {
    it("accepts string grantId for conflict-dir pathing", async () => {
      writeFile(liveRoot, "f.lua", "L");
      writeFile(stagingRoot, "f.lua", "P");

      await applyPlan({
        plan: makePlan([
          {
            path: "f.lua",
            decision: "conflict",
            rowNumber: 4,
            resolution: "staged-for-merge",
            conflictOptions: ["staged-for-merge"],
            liveSha: "l",
            packSha: "k",
          },
        ]),
        liveRoot,
        stagingRoot,
        conflictDir,
        grantId: "my-grant",
      });

      expect(
        existsSync(path.join(conflictDir, "my-grant", "f.lua.live"))
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // tmp cleanup on rename failure (fixup item 1)
  // -------------------------------------------------------------------------

  describe("atomic write tmp cleanup on rename failure", () => {
    it("atomicCopy (staged-for-merge .live sidecar): leaves no *.tmp-* orphan when rename throws", async () => {
      writeFile(liveRoot, "config/server.lua", "USER-CONTENT");
      writeFile(stagingRoot, "config/server.lua", "PACK-CONTENT");

      // Patch fs.rename to fail on first invocation. The very first rename
      // during staged-for-merge is the .live sidecar — which is what we want
      // to verify the atomicCopy catch-cleanup path on.
      const realRename = fsP.rename.bind(fsP);
      const spy = vi.spyOn(fsP, "rename").mockImplementationOnce(async () => {
        const e = new Error("simulated EACCES") as NodeJS.ErrnoException;
        e.code = "EACCES";
        throw e;
      });

      try {
        await expect(
          applyPlan({
            plan: makePlan([
              {
                path: "config/server.lua",
                decision: "conflict",
                rowNumber: 4,
                resolution: "staged-for-merge",
                conflictOptions: ["staged-for-merge"],
                liveSha: "l",
                packSha: "k",
              },
            ]),
            liveRoot,
            stagingRoot,
            conflictDir,
            grantId,
          })
        ).rejects.toThrow(/EACCES/);
      } finally {
        spy.mockRestore();
        // Sanity: real rename still works after restore.
        void realRename;
      }

      // The .live sidecar should not exist (rename failed).
      const sidecarDir = path.join(conflictDir, String(grantId), "config");
      const liveSidecar = path.join(sidecarDir, "server.lua.live");
      expect(existsSync(liveSidecar)).toBe(false);

      // No orphaned `.tmp-*` files anywhere in the sidecar directory.
      if (existsSync(sidecarDir)) {
        const entries = readdirSync(sidecarDir);
        const orphans = entries.filter((n) => /\.tmp-/.test(n));
        expect(orphans).toEqual([]);
      }
    });

    it("atomicWrite (empty .live sidecar when live missing): leaves no *.tmp-* orphan on rename failure", async () => {
      // No live file at this path, so staged-for-merge takes the atomicWrite
      // branch for the .live sidecar.
      writeFile(stagingRoot, "config/orphan.lua", "PACK-CONTENT");

      const spy = vi.spyOn(fsP, "rename").mockImplementationOnce(async () => {
        const e = new Error("simulated ENOSPC") as NodeJS.ErrnoException;
        e.code = "ENOSPC";
        throw e;
      });

      try {
        await expect(
          applyPlan({
            plan: makePlan([
              {
                path: "config/orphan.lua",
                decision: "conflict",
                rowNumber: 4,
                resolution: "staged-for-merge",
                conflictOptions: ["staged-for-merge"],
                packSha: "k",
              },
            ]),
            liveRoot,
            stagingRoot,
            conflictDir,
            grantId,
          })
        ).rejects.toThrow(/ENOSPC/);
      } finally {
        spy.mockRestore();
      }

      const sidecarDir = path.join(conflictDir, String(grantId), "config");
      if (existsSync(sidecarDir)) {
        const entries = readdirSync(sidecarDir);
        const orphans = entries.filter((n) => /\.tmp-/.test(n));
        expect(orphans).toEqual([]);
      }
    });
  });

  // -------------------------------------------------------------------------
  // structured collision field (fixup item 2)
  // -------------------------------------------------------------------------

  describe("blocker row collision field", () => {
    it("CaseCollisionDetectedError.pathB comes from structured collision.paths, not blockerDetail regex", async () => {
      try {
        await applyPlan({
          plan: makePlan([
            {
              path: "Config.lua",
              decision: "blocker",
              rowNumber: 9,
              blockerCode: "CASE_COLLISION_DETECTED",
              // Intentionally garbage detail — if applyPlan were still parsing
              // blockerDetail instead of the structured field, it would
              // extract an empty or wrong pathB.
              blockerDetail: "!!!malformed!!! does not mention the other path",
              collision: {
                lowerPath: "config.lua",
                paths: ["Config.lua", "config.lua"],
              },
            },
          ]),
          liveRoot,
          stagingRoot,
          conflictDir,
          grantId,
        });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(CaseCollisionDetectedError);
        const e = err as CaseCollisionDetectedError;
        expect(e.pathA).toBe("Config.lua");
        expect(e.pathB).toBe("config.lua");
      }
    });

    it("falls back to blockerDetail regex when collision field absent (legacy/hand-built plans)", async () => {
      try {
        await applyPlan({
          plan: makePlan([
            {
              path: "A.lua",
              decision: "blocker",
              rowNumber: 9,
              blockerCode: "CASE_COLLISION_DETECTED",
              blockerDetail:
                "case collision: A.lua collides with a.lua (lowercased to a.lua)",
              // no `collision` field — simulates pre-fixup hand-built plan
            },
          ]),
          liveRoot,
          stagingRoot,
          conflictDir,
          grantId,
        });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(CaseCollisionDetectedError);
        expect((err as CaseCollisionDetectedError).pathB).toBe("a.lua");
      }
    });

    it("multi-path collision group picks the first 'other' path deterministically", async () => {
      try {
        await applyPlan({
          plan: makePlan([
            {
              path: "B.lua",
              decision: "blocker",
              rowNumber: 9,
              blockerCode: "CASE_COLLISION_DETECTED",
              blockerDetail: "(whatever)",
              collision: {
                lowerPath: "b.lua",
                paths: ["A.lua", "B.lua", "b.lua"],
              },
            },
          ]),
          liveRoot,
          stagingRoot,
          conflictDir,
          grantId,
        });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(CaseCollisionDetectedError);
        const e = err as CaseCollisionDetectedError;
        expect(e.pathA).toBe("B.lua");
        // `Array.find` returns the first non-self path; paths are sorted in
        // diffEngine before attaching, so the answer is stable.
        expect(e.pathB).toBe("A.lua");
      }
    });
  });
});

// Sanity: statSync unused warning guard (kept import for future tests).
void statSync;
