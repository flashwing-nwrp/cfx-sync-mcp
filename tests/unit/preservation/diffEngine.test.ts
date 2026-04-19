import { describe, it, expect } from "vitest";
import { computeDeployPlan, isEncryptedPath } from "../../../src/lib/preservation/diffEngine.js";
import type {
  ComputeDeployPlanInput,
  PlanRow,
} from "../../../src/lib/preservation/types.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function m(obj: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(obj));
}

/** Build a minimal input with sensible defaults. */
function input(partial: Partial<ComputeDeployPlanInput>): ComputeDeployPlanInput {
  return {
    pristineHashes: partial.pristineHashes ?? new Map(),
    liveHashes: partial.liveHashes ?? new Map(),
    packHashes: partial.packHashes ?? new Map(),
    renamePairs: partial.renamePairs ?? [],
    caseCollisions: partial.caseCollisions ?? [],
    ...(partial.conflictResolutions !== undefined
      ? { conflictResolutions: partial.conflictResolutions }
      : {}),
    ...(partial.packValidationFailures !== undefined
      ? { packValidationFailures: partial.packValidationFailures }
      : {}),
  };
}

function findRow(rows: PlanRow[], path: string): PlanRow {
  const row = rows.find((r) => r.path === path);
  if (!row) throw new Error(`no row for path ${path}`);
  return row;
}

// ---------------------------------------------------------------------------
// row-by-row tests
// ---------------------------------------------------------------------------

describe("computeDeployPlan — row 1 (unchanged/unchanged same path)", () => {
  it("emits take-newPack no-op when all three shas match", () => {
    const plan = computeDeployPlan(
      input({
        pristineHashes: m({ "fxmanifest.lua": "aaa" }),
        liveHashes: m({ "fxmanifest.lua": "aaa" }),
        packHashes: m({ "fxmanifest.lua": "aaa" }),
      })
    );

    expect(plan.rows).toHaveLength(1);
    const row = plan.rows[0]!;
    expect(row.decision).toBe("take-newPack");
    expect(row.rowNumber).toBe(1);
    expect(row.pristineSha).toBe("aaa");
    expect(row.liveSha).toBe("aaa");
    expect(row.packSha).toBe("aaa");
    expect(plan.blockers).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });
});

describe("computeDeployPlan — row 2 (unchanged/changed same path)", () => {
  it("emits take-newPack when live matches pristine but pack differs", () => {
    const plan = computeDeployPlan(
      input({
        pristineHashes: m({ "config/server.lua": "old" }),
        liveHashes: m({ "config/server.lua": "old" }),
        packHashes: m({ "config/server.lua": "new" }),
      })
    );

    expect(plan.rows).toHaveLength(1);
    const row = plan.rows[0]!;
    expect(row.decision).toBe("take-newPack");
    expect(row.rowNumber).toBe(2);
    expect(row.packSha).toBe("new");
    expect(row.liveSha).toBe("old");
  });
});

describe("computeDeployPlan — row 3 (changed/unchanged)", () => {
  it("emits preserve-live when user modified a file pack didn't touch", () => {
    const plan = computeDeployPlan(
      input({
        pristineHashes: m({ "config/server.lua": "original" }),
        liveHashes: m({ "config/server.lua": "user-edit" }),
        packHashes: m({ "config/server.lua": "original" }),
      })
    );

    expect(plan.rows).toHaveLength(1);
    const row = plan.rows[0]!;
    expect(row.decision).toBe("preserve-live");
    expect(row.rowNumber).toBe(3);
    expect(row.liveSha).toBe("user-edit");
    expect(row.pristineSha).toBe("original");
  });
});

describe("computeDeployPlan — row 4 (changed/changed conflict)", () => {
  it("emits conflict with 4 resolution options when both sides diverged", () => {
    const plan = computeDeployPlan(
      input({
        pristineHashes: m({ "config/server.lua": "base" }),
        liveHashes: m({ "config/server.lua": "user-edit" }),
        packHashes: m({ "config/server.lua": "vendor-edit" }),
      })
    );

    expect(plan.rows).toHaveLength(1);
    const row = plan.rows[0]!;
    expect(row.decision).toBe("conflict");
    expect(row.rowNumber).toBe(4);
    expect(row.conflictOptions).toEqual([
      "take-live",
      "take-pack",
      "merge-diff3",
      "staged-for-merge",
    ]);
    expect(plan.conflicts).toHaveLength(1);
  });
});

describe("computeDeployPlan — row 5 (live-only orphan)", () => {
  it("emits preserve-live for a file only in live tree", () => {
    const plan = computeDeployPlan(
      input({
        pristineHashes: m({}),
        liveHashes: m({ "user-custom.lua": "xyz" }),
        packHashes: m({}),
      })
    );

    expect(plan.rows).toHaveLength(1);
    const row = plan.rows[0]!;
    expect(row.decision).toBe("preserve-live");
    expect(row.rowNumber).toBe(5);
    expect(row.liveSha).toBe("xyz");
    expect(row.pristineSha).toBeUndefined();
  });
});

describe("computeDeployPlan — row 6 (pristine-only drop)", () => {
  it("emits drop when file is in pristine but neither live nor pack", () => {
    const plan = computeDeployPlan(
      input({
        pristineHashes: m({ "deleted.lua": "abc" }),
        liveHashes: m({}),
        packHashes: m({}),
      })
    );

    expect(plan.rows).toHaveLength(1);
    const row = plan.rows[0]!;
    expect(row.decision).toBe("drop");
    expect(row.rowNumber).toBe(6);
    expect(row.pristineSha).toBe("abc");
  });
});

describe("computeDeployPlan — row 7 (rename, live unchanged)", () => {
  it("emits take-newPack-rename when user didn't touch the old path", () => {
    const plan = computeDeployPlan(
      input({
        pristineHashes: m({ "old/path.lua": "content" }),
        liveHashes: m({ "old/path.lua": "content" }),
        packHashes: m({ "new/path.lua": "content" }),
        renamePairs: [{ oldPath: "old/path.lua", newPath: "new/path.lua" }],
      })
    );

    expect(plan.rows).toHaveLength(1);
    const row = plan.rows[0]!;
    expect(row.path).toBe("new/path.lua");
    expect(row.decision).toBe("take-newPack-rename");
    expect(row.rowNumber).toBe(7);
    expect(row.rename).toEqual({ oldPath: "old/path.lua", newPath: "new/path.lua" });
    expect(row.pristineSha).toBe("content");
    expect(row.liveSha).toBe("content");
    expect(row.packSha).toBe("content");
  });

  it("treats missing live[oldPath] as unchanged (user already lacks the old file)", () => {
    const plan = computeDeployPlan(
      input({
        pristineHashes: m({ "old/path.lua": "content" }),
        liveHashes: m({}),
        packHashes: m({ "new/path.lua": "content" }),
        renamePairs: [{ oldPath: "old/path.lua", newPath: "new/path.lua" }],
      })
    );

    const row = findRow(plan.rows, "new/path.lua");
    expect(row.decision).toBe("take-newPack-rename");
    expect(row.rowNumber).toBe(7);
    expect(row.liveSha).toBeUndefined();
  });
});

describe("computeDeployPlan — row 8 (rename + user modified at old path)", () => {
  it("emits conflict with 6 resolution options", () => {
    const plan = computeDeployPlan(
      input({
        pristineHashes: m({ "old/path.lua": "base" }),
        liveHashes: m({ "old/path.lua": "user-edit" }),
        packHashes: m({ "new/path.lua": "base" }),
        renamePairs: [{ oldPath: "old/path.lua", newPath: "new/path.lua" }],
      })
    );

    expect(plan.rows).toHaveLength(1);
    const row = plan.rows[0]!;
    expect(row.decision).toBe("conflict");
    expect(row.rowNumber).toBe(8);
    expect(row.rename).toEqual({ oldPath: "old/path.lua", newPath: "new/path.lua" });
    expect(row.conflictOptions).toEqual([
      "take-live",
      "take-pack",
      "merge-diff3",
      "staged-for-merge",
      "take-live-at-new-path",
      "take-live-at-old-path",
    ]);
    expect(row.liveSha).toBe("user-edit");
  });
});

describe("computeDeployPlan — row 9 (case collision blocker)", () => {
  it("emits a blocker row for each path in a collision group", () => {
    const plan = computeDeployPlan(
      input({
        pristineHashes: m({ "Configs/server.lua": "a" }),
        liveHashes: m({ "Configs/server.lua": "a", "configs/server.lua": "b" }),
        packHashes: m({ "configs/server.lua": "b" }),
        caseCollisions: [
          {
            lowerPath: "configs/server.lua",
            paths: ["Configs/server.lua", "configs/server.lua"],
          },
        ],
      })
    );

    expect(plan.blockers).toHaveLength(2);
    for (const row of plan.blockers) {
      expect(row.decision).toBe("blocker");
      expect(row.rowNumber).toBe(9);
      expect(row.blockerCode).toBe("CASE_COLLISION_DETECTED");
      expect(row.blockerDetail).toContain("case collision");
    }
    const paths = plan.blockers.map((r) => r.path).sort();
    expect(paths).toEqual(["Configs/server.lua", "configs/server.lua"]);
  });
});

describe("computeDeployPlan — row 10 (encrypted tamper blocker)", () => {
  it("emits blocker when live != pristine on a .fxap path", () => {
    const plan = computeDeployPlan(
      input({
        pristineHashes: m({ "resource.fxap": "original" }),
        liveHashes: m({ "resource.fxap": "tampered" }),
        packHashes: m({ "resource.fxap": "original" }),
      })
    );

    expect(plan.blockers).toHaveLength(1);
    const row = plan.blockers[0]!;
    expect(row.decision).toBe("blocker");
    expect(row.rowNumber).toBe(10);
    expect(row.blockerCode).toBe("ENCRYPTED_TAMPER_DETECTED");
    expect(row.blockerDetail).toContain("encrypted path");
    expect(row.liveSha).toBe("tampered");
    expect(row.pristineSha).toBe("original");
  });

  it("emits blocker under encrypted/ directory (case-insensitive)", () => {
    const plan = computeDeployPlan(
      input({
        pristineHashes: m({ "Encrypted/secret.dat": "orig" }),
        liveHashes: m({ "Encrypted/secret.dat": "modified" }),
        packHashes: m({ "Encrypted/secret.dat": "orig" }),
      })
    );

    expect(plan.blockers).toHaveLength(1);
    expect(plan.blockers[0]!.blockerCode).toBe("ENCRYPTED_TAMPER_DETECTED");
  });

  it("does NOT block a brand-new encrypted file from the pack (no pristine)", () => {
    const plan = computeDeployPlan(
      input({
        pristineHashes: m({}),
        liveHashes: m({}),
        packHashes: m({ "new.fxap": "fresh" }),
      })
    );

    expect(plan.blockers).toEqual([]);
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]!.decision).toBe("take-newPack");
  });
});

// ---------------------------------------------------------------------------
// combo tests
// ---------------------------------------------------------------------------

describe("computeDeployPlan — combo: multiple rows in one input", () => {
  it("handles a real-world mix of rows 1,2,3,4,5,6 simultaneously", () => {
    const plan = computeDeployPlan(
      input({
        pristineHashes: m({
          "unchanged.lua": "u", // row 1
          "vendor-edit.lua": "orig", // row 2
          "user-edit.lua": "orig", // row 3
          "both-edit.lua": "base", // row 4
          "dropped.lua": "gone", // row 6
        }),
        liveHashes: m({
          "unchanged.lua": "u",
          "vendor-edit.lua": "orig",
          "user-edit.lua": "mine",
          "both-edit.lua": "mine-v2",
          "orphan.lua": "custom", // row 5
        }),
        packHashes: m({
          "unchanged.lua": "u",
          "vendor-edit.lua": "updated",
          "user-edit.lua": "orig",
          "both-edit.lua": "vendor-v2",
        }),
      })
    );

    expect(plan.rows).toHaveLength(6);
    expect(findRow(plan.rows, "unchanged.lua").rowNumber).toBe(1);
    expect(findRow(plan.rows, "vendor-edit.lua").rowNumber).toBe(2);
    expect(findRow(plan.rows, "user-edit.lua").rowNumber).toBe(3);
    expect(findRow(plan.rows, "both-edit.lua").rowNumber).toBe(4);
    expect(findRow(plan.rows, "orphan.lua").rowNumber).toBe(5);
    expect(findRow(plan.rows, "dropped.lua").rowNumber).toBe(6);

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]!.path).toBe("both-edit.lua");
    expect(plan.blockers).toEqual([]);

    // Deterministic ordering: paths sorted ASCII-ascending.
    const paths = plan.rows.map((r) => r.path);
    expect(paths).toEqual([...paths].sort());
  });
});

describe("computeDeployPlan — combo: conflict + resolution round-trip", () => {
  it("rewrites row 4 conflict to preserve-live when take-live resolution is supplied", () => {
    const plan = computeDeployPlan(
      input({
        pristineHashes: m({ "config.lua": "base" }),
        liveHashes: m({ "config.lua": "user" }),
        packHashes: m({ "config.lua": "vendor" }),
        conflictResolutions: { "config.lua": "take-live" },
      })
    );

    expect(plan.conflicts).toHaveLength(0);
    expect(plan.rows).toHaveLength(1);
    const row = plan.rows[0]!;
    expect(row.decision).toBe("preserve-live");
    expect(row.rowNumber).toBe(4);
    expect(row.conflictOptions).toBeUndefined();
  });

  it("rewrites row 4 conflict to take-newPack when take-pack resolution is supplied", () => {
    const plan = computeDeployPlan(
      input({
        pristineHashes: m({ "config.lua": "base" }),
        liveHashes: m({ "config.lua": "user" }),
        packHashes: m({ "config.lua": "vendor" }),
        conflictResolutions: { "config.lua": "take-pack" },
      })
    );

    const row = plan.rows[0]!;
    expect(row.decision).toBe("take-newPack");
    expect(row.rowNumber).toBe(4);
  });

  it("keeps conflict decision but records resolution for merge-diff3", () => {
    const plan = computeDeployPlan(
      input({
        pristineHashes: m({ "config.lua": "base" }),
        liveHashes: m({ "config.lua": "user" }),
        packHashes: m({ "config.lua": "vendor" }),
        conflictResolutions: { "config.lua": "merge-diff3" },
      })
    );

    const row = plan.rows[0]!;
    expect(row.decision).toBe("conflict");
    expect(row.resolution).toBe("merge-diff3");
  });

  it("keeps conflict decision for take-live-at-new-path on row 8", () => {
    const plan = computeDeployPlan(
      input({
        pristineHashes: m({ "old.lua": "base" }),
        liveHashes: m({ "old.lua": "user-edit" }),
        packHashes: m({ "new.lua": "base" }),
        renamePairs: [{ oldPath: "old.lua", newPath: "new.lua" }],
        conflictResolutions: { "new.lua": "take-live-at-new-path" },
      })
    );

    const row = findRow(plan.rows, "new.lua");
    expect(row.decision).toBe("conflict");
    expect(row.rowNumber).toBe(8);
    expect(row.resolution).toBe("take-live-at-new-path");
  });

  it("ignores a resolution choice that isn't in the row's options", () => {
    const plan = computeDeployPlan(
      input({
        pristineHashes: m({ "config.lua": "base" }),
        liveHashes: m({ "config.lua": "user" }),
        packHashes: m({ "config.lua": "vendor" }),
        // take-live-at-new-path is a row-8-only option, not valid for row 4.
        conflictResolutions: { "config.lua": "take-live-at-new-path" },
      })
    );

    const row = plan.rows[0]!;
    expect(row.decision).toBe("conflict");
    expect(row.resolution).toBeUndefined();
  });
});

describe("computeDeployPlan — combo: blocker short-circuits", () => {
  it("emits row-9 blockers alongside normal rows without masking them", () => {
    const plan = computeDeployPlan(
      input({
        pristineHashes: m({
          "Configs/a.lua": "aaa",
          "fxmanifest.lua": "fx",
        }),
        liveHashes: m({
          "Configs/a.lua": "aaa",
          "configs/a.lua": "bbb",
          "fxmanifest.lua": "fx",
        }),
        packHashes: m({
          "configs/a.lua": "bbb",
          "fxmanifest.lua": "fx-new",
        }),
        caseCollisions: [
          {
            lowerPath: "configs/a.lua",
            paths: ["Configs/a.lua", "configs/a.lua"],
          },
        ],
      })
    );

    // Two blocker rows (one per colliding path) + one fxmanifest row 2.
    expect(plan.blockers).toHaveLength(2);
    for (const b of plan.blockers) {
      expect(b.blockerCode).toBe("CASE_COLLISION_DETECTED");
    }
    const fx = findRow(plan.rows, "fxmanifest.lua");
    expect(fx.decision).toBe("take-newPack");
    expect(fx.rowNumber).toBe(2);

    // The colliding paths appear only as blocker rows, not as regular rows too.
    const nonBlockerPaths = plan.rows
      .filter((r) => r.decision !== "blocker")
      .map((r) => r.path);
    expect(nonBlockerPaths).not.toContain("Configs/a.lua");
    expect(nonBlockerPaths).not.toContain("configs/a.lua");
  });

  it("passes packValidationFailures through unchanged", () => {
    const failures = [
      { path: "symlink-bad", reason: "symlink-refused" as const },
      { path: "../traversal", reason: "path-traversal-refused" as const },
    ];
    const plan = computeDeployPlan(
      input({
        packHashes: m({ "ok.lua": "xyz" }),
        packValidationFailures: failures,
      })
    );

    expect(plan.packValidationFailures).toEqual(failures);
  });
});

// ---------------------------------------------------------------------------
// purity + sanity
// ---------------------------------------------------------------------------

describe("computeDeployPlan — purity & determinism", () => {
  it("returns identical output across two calls with the same input", () => {
    const inp = input({
      pristineHashes: m({ "a.lua": "1", "b.lua": "2", "c.lua": "3" }),
      liveHashes: m({ "a.lua": "1", "b.lua": "user", "d.lua": "custom" }),
      packHashes: m({ "a.lua": "1", "b.lua": "vendor", "e.lua": "new" }),
    });

    const p1 = computeDeployPlan(inp);
    const p2 = computeDeployPlan(inp);

    expect(JSON.stringify(p1)).toBe(JSON.stringify(p2));
  });

  it("handles empty maps without error", () => {
    const plan = computeDeployPlan(input({}));
    expect(plan.rows).toEqual([]);
    expect(plan.blockers).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.packValidationFailures).toEqual([]);
  });

  it("handles single-path trees", () => {
    const plan = computeDeployPlan(
      input({ packHashes: m({ "lone.lua": "zzz" }) })
    );
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]!.decision).toBe("take-newPack");
  });
});

describe("isEncryptedPath", () => {
  it("matches .fxap case-insensitively", () => {
    expect(isEncryptedPath("resource.fxap")).toBe(true);
    expect(isEncryptedPath("resource.FXAP")).toBe(true);
    expect(isEncryptedPath("path/to/resource.fxap")).toBe(true);
  });

  it("matches encrypted/ at any depth", () => {
    expect(isEncryptedPath("encrypted/secret")).toBe(true);
    expect(isEncryptedPath("ENCRYPTED/secret")).toBe(true);
    expect(isEncryptedPath("some/dir/encrypted/secret.dat")).toBe(true);
  });

  it("does not match plain paths", () => {
    expect(isEncryptedPath("config/server.lua")).toBe(false);
    expect(isEncryptedPath("fxmanifest.lua")).toBe(false);
    // `encryptedname.lua` is NOT under `encrypted/` — just starts with those
    // letters.
    expect(isEncryptedPath("encryptedname.lua")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// perf smoke — 10k entries each side, should complete in < 200ms
// ---------------------------------------------------------------------------

describe("computeDeployPlan — perf smoke (10k entries)", () => {
  it("completes in well under 200ms", () => {
    const SIZE = 10_000;
    const pristine = new Map<string, string>();
    const live = new Map<string, string>();
    const pack = new Map<string, string>();

    // Build a mix: 70% unchanged (row 1), 10% vendor-changed (row 2),
    // 10% user-changed (row 3), 5% conflict (row 4), 5% orphan (row 5).
    for (let i = 0; i < SIZE; i++) {
      const p = `resource/${(i % 100).toString().padStart(3, "0")}/file_${i}.lua`;
      const bucket = i % 20;
      if (bucket < 14) {
        // row 1
        pristine.set(p, `sha_${i}`);
        live.set(p, `sha_${i}`);
        pack.set(p, `sha_${i}`);
      } else if (bucket < 16) {
        // row 2
        pristine.set(p, `sha_${i}`);
        live.set(p, `sha_${i}`);
        pack.set(p, `sha_${i}_new`);
      } else if (bucket < 18) {
        // row 3
        pristine.set(p, `sha_${i}`);
        live.set(p, `sha_${i}_user`);
        pack.set(p, `sha_${i}`);
      } else if (bucket < 19) {
        // row 4
        pristine.set(p, `sha_${i}`);
        live.set(p, `sha_${i}_user`);
        pack.set(p, `sha_${i}_vendor`);
      } else {
        // row 5 orphan
        live.set(p, `sha_${i}_custom`);
      }
    }

    const inp = input({
      pristineHashes: pristine,
      liveHashes: live,
      packHashes: pack,
    });

    const t0 = performance.now();
    const plan = computeDeployPlan(inp);
    const elapsed = performance.now() - t0;

    // eslint-disable-next-line no-console
    console.log(`  perf: ${SIZE} entries → ${plan.rows.length} rows in ${elapsed.toFixed(1)}ms`);

    expect(elapsed).toBeLessThan(200);
    expect(plan.rows.length).toBeGreaterThan(0);
    // Sanity: no unexpected blockers.
    expect(plan.blockers).toEqual([]);
  });
});
