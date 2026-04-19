/**
 * Phase 1.6 Task 11 — cfx_set_fork_mode MCP tool tests.
 *
 * Covers the 7 semantic cases from the spec §cfx_set_fork_mode plus schema
 * guards + registry wiring. Uses a disposable tmp stateDir per test (same
 * pattern as scan_configs.test.ts).
 */

import type { z } from "zod";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { cfx_set_fork_mode } from "../../../src/mcp/tools/set_fork_mode.js";
import {
  SetForkModeInput,
  SetForkModeOutput,
} from "../../../src/mcp/schemas/index.js";
import { TOOLS, toolNames } from "../../../src/mcp/tools/index.js";
import { dispatch } from "../../../src/mcp/dispatch.js";
import {
  MappingUnapprovedError,
  NotFoundError,
  CfxError,
} from "../../../src/lib/errors.js";
import type {
  MappingFile,
  MappingEntry,
} from "../../../src/lib/state/mapping.js";

type SetForkModeOutputT = z.infer<typeof SetForkModeOutput>;

function makeMappingEntry(
  partial: Partial<MappingEntry> & { slug: string; target: string }
): MappingEntry {
  return {
    status: "active",
    reviewedByUser: true,
    assetName: partial.slug,
    discoveredTier: 1,
    discoveredConfidence: 1.0,
    preservePaths: null,
    preservePathsSource: null,
    ...partial,
  };
}

function writeMapping(
  stateDir: string,
  entries: Record<string, MappingEntry>
): void {
  const file: MappingFile = {
    version: 4,
    approvedAt: "2026-04-19T10:00:00.000Z",
    entries,
    newInstalls: [],
    orphaned: [],
  };
  writeFileSync(
    path.join(stateDir, "cfx-sync-map.json"),
    JSON.stringify(file, null, 2)
  );
}

function readMapping(stateDir: string): MappingFile {
  return JSON.parse(
    readFileSync(path.join(stateDir, "cfx-sync-map.json"), "utf8")
  ) as MappingFile;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("SetForkModeInput schema", () => {
  it("accepts slug + enabled", () => {
    expect(
      SetForkModeInput.safeParse({ slug: "ulc_bodycams", enabled: true }).success
    ).toBe(true);
  });

  it("accepts grantId + enabled", () => {
    expect(
      SetForkModeInput.safeParse({ grantId: 1234, enabled: false }).success
    ).toBe(true);
  });

  it("accepts optional reason", () => {
    expect(
      SetForkModeInput.safeParse({
        slug: "ulc_bodycams",
        enabled: true,
        reason: "Local fork 1.9.0 ahead of upstream",
      }).success
    ).toBe(true);
  });

  it("rejects neither slug nor grantId (exactly-one rule)", () => {
    expect(SetForkModeInput.safeParse({ enabled: true }).success).toBe(false);
  });

  it("rejects both slug and grantId (exactly-one rule)", () => {
    expect(
      SetForkModeInput.safeParse({
        slug: "x",
        grantId: 5,
        enabled: true,
      }).success
    ).toBe(false);
  });

  it("rejects missing enabled", () => {
    expect(SetForkModeInput.safeParse({ slug: "x" }).success).toBe(false);
  });

  it("rejects non-positive grantId", () => {
    expect(
      SetForkModeInput.safeParse({ grantId: 0, enabled: true }).success
    ).toBe(false);
    expect(
      SetForkModeInput.safeParse({ grantId: -1, enabled: true }).success
    ).toBe(false);
  });

  it("rejects non-integer grantId", () => {
    expect(
      SetForkModeInput.safeParse({ grantId: 1.5, enabled: true }).success
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Registry + dispatch
// ---------------------------------------------------------------------------

describe("TOOLS registry integration", () => {
  it("includes cfx_set_fork_mode", () => {
    expect(toolNames()).toContain("cfx_set_fork_mode");
  });

  it("cfx_set_fork_mode is marked destructive", () => {
    const t = TOOLS.find((x) => x.name === "cfx_set_fork_mode");
    expect(t).toBeDefined();
    expect(t!.destructive).toBe(true);
  });

  it("cfx_set_fork_mode description references fork / ignoreUpstream", () => {
    const t = TOOLS.find((x) => x.name === "cfx_set_fork_mode");
    expect(t?.description).toMatch(/fork|ignoreUpstream/i);
  });

  it("dispatch handler exists for cfx_set_fork_mode", async () => {
    // Calling with {} will fail schema/runtime but must NOT hit the
    // "Unknown tool" code path.
    try {
      await dispatch("cfx_set_fork_mode", { slug: "nope", enabled: true });
    } catch (e) {
      expect((e as Error).message).not.toMatch(/Unknown tool/);
      return;
    }
  });
});

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

describe("cfx_set_fork_mode behavior", () => {
  let dir: string;
  let stateDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cfx-setfork-"));
    stateDir = path.join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    process.env.CFX_SERVER_RESOURCES = dir;
    process.env.CFX_STATE_DIR = stateDir;
    process.env.CFX_CACHE_DIR = path.join(dir, "cache");
    process.env.CFX_STAGING_DIR = path.join(dir, "staging");
    process.env.CFX_BACKUP_DIR = path.join(dir, "backups");
    process.env.CFX_COOKIE_FILE = path.join(dir, ".cookies.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Case 1: enabled: true on valid mapping → fields written, setAt stamped ISO.
  it("enabled:true on valid mapping writes the triad with ISO setAt", async () => {
    writeMapping(stateDir, {
      "100": makeMappingEntry({ slug: "ulc_bodycams", target: path.join(dir, "t") }),
    });

    const result = await cfx_set_fork_mode({
      grantId: 100,
      enabled: true,
      reason: "Local 1.9.0 ahead of upstream 1.8.0",
    });

    const parsed = SetForkModeOutput.parse(result);
    expect(parsed.slug).toBe("ulc_bodycams");
    expect(parsed.grantId).toBe(100);
    expect(parsed.ignoreUpstreamUpdates).toBe(true);
    expect(parsed.reason).toBe("Local 1.9.0 ahead of upstream 1.8.0");
    // ISO 8601 parse check — Date.parse returns NaN on invalid input.
    expect(Number.isFinite(Date.parse(parsed.setAt))).toBe(true);

    const onDisk = readMapping(stateDir);
    const entry = onDisk.entries["100"]!;
    expect(entry.ignoreUpstreamUpdates).toBe(true);
    expect(entry.ignoreUpstreamUpdatesReason).toBe(
      "Local 1.9.0 ahead of upstream 1.8.0"
    );
    expect(entry.ignoreUpstreamUpdatesSetAt).toBe(parsed.setAt);
  });

  it("resolves by slug when grantId is omitted", async () => {
    writeMapping(stateDir, {
      "100": makeMappingEntry({ slug: "my_mod", target: path.join(dir, "t") }),
    });

    const result = await cfx_set_fork_mode({
      slug: "my_mod",
      enabled: true,
      reason: "fork",
    });

    expect(result.grantId).toBe(100);
    expect(result.ignoreUpstreamUpdates).toBe(true);
  });

  // Case 2: enabled: true idempotent → second call refreshes reason + setAt.
  it("enabled:true is idempotent and refreshes reason + setAt on re-call", async () => {
    writeMapping(stateDir, {
      "100": makeMappingEntry({ slug: "ulc_bodycams", target: path.join(dir, "t") }),
    });

    const first = await cfx_set_fork_mode({
      grantId: 100,
      enabled: true,
      reason: "v1",
    });
    // Force a tick forward so the timestamps differ.
    await new Promise((r) => setTimeout(r, 15));
    const second = await cfx_set_fork_mode({
      grantId: 100,
      enabled: true,
      reason: "v2 — updated notes",
    });

    expect(second.ignoreUpstreamUpdates).toBe(true);
    expect(second.reason).toBe("v2 — updated notes");
    expect(Date.parse(second.setAt)).toBeGreaterThan(Date.parse(first.setAt));

    const onDisk = readMapping(stateDir);
    expect(onDisk.entries["100"]!.ignoreUpstreamUpdatesReason).toBe(
      "v2 — updated notes"
    );
    expect(onDisk.entries["100"]!.ignoreUpstreamUpdatesSetAt).toBe(second.setAt);
  });

  // Case 3: enabled: false clears all three audit fields back to absent.
  it("enabled:false clears all three audit fields on a flagged entry", async () => {
    writeMapping(stateDir, {
      "100": makeMappingEntry({
        slug: "ulc_bodycams",
        target: path.join(dir, "t"),
        ignoreUpstreamUpdates: true,
        ignoreUpstreamUpdatesReason: "Local 1.9.0 ahead",
        ignoreUpstreamUpdatesSetAt: "2026-04-18T00:00:00.000Z",
      }),
    });

    const result = await cfx_set_fork_mode({ grantId: 100, enabled: false });

    expect(result.ignoreUpstreamUpdates).toBe(false);
    expect(result.reason).toBeUndefined();
    // Preserved the pre-clear `setAt` so the operator can see what was just
    // cleared (implementation choice documented in the tool's JSDoc).
    expect(result.setAt).toBe("2026-04-18T00:00:00.000Z");

    // Disk: the triad fields are gone (JSON.stringify omits undefined).
    const onDisk = readMapping(stateDir);
    const entry = onDisk.entries["100"]!;
    expect(entry.ignoreUpstreamUpdates).toBeUndefined();
    expect(entry.ignoreUpstreamUpdatesReason).toBeUndefined();
    expect(entry.ignoreUpstreamUpdatesSetAt).toBeUndefined();
    // Make sure we didn't nuke the rest of the entry.
    expect(entry.slug).toBe("ulc_bodycams");
    expect(entry.status).toBe("active");
  });

  // Case 4: enabled: false on unflagged resource → idempotent no-op.
  it("enabled:false on unflagged entry is an idempotent no-op returning current state", async () => {
    writeMapping(stateDir, {
      "100": makeMappingEntry({ slug: "my_mod", target: path.join(dir, "t") }),
    });

    const before = readFileSync(
      path.join(stateDir, "cfx-sync-map.json"),
      "utf8"
    );

    const result = await cfx_set_fork_mode({ grantId: 100, enabled: false });
    expect(result.ignoreUpstreamUpdates).toBe(false);
    expect(result.grantId).toBe(100);
    expect(result.slug).toBe("my_mod");

    // Mapping file unchanged — the tool skipped the save for the no-op path.
    const after = readFileSync(
      path.join(stateDir, "cfx-sync-map.json"),
      "utf8"
    );
    expect(after).toBe(before);
  });

  // Case 5: Target not found (bad slug / grantId) → NotFoundError.
  it("throws NotFoundError for a missing grantId", async () => {
    writeMapping(stateDir, {
      "100": makeMappingEntry({ slug: "my_mod", target: path.join(dir, "t") }),
    });

    await expect(
      cfx_set_fork_mode({ grantId: 99999, enabled: true })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError for a missing slug", async () => {
    writeMapping(stateDir, {
      "100": makeMappingEntry({ slug: "my_mod", target: path.join(dir, "t") }),
    });

    await expect(
      cfx_set_fork_mode({ slug: "does_not_exist", enabled: true })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // Case 6: Mapping unapproved → MappingUnapprovedError.
  it("throws MappingUnapprovedError when cfx-sync-map.json is absent", async () => {
    await expect(
      cfx_set_fork_mode({ grantId: 100, enabled: true })
    ).rejects.toBeInstanceOf(MappingUnapprovedError);
  });

  it("throws CfxError subclass (MappingUnapprovedError) — baseline contract", async () => {
    await expect(
      cfx_set_fork_mode({ grantId: 100, enabled: true })
    ).rejects.toBeInstanceOf(CfxError);
  });

  // Case 7: Concurrent set_fork_mode calls under StateLock.
  //
  // StateLock is cross-PROCESS exclusion, not intra-process reentrant — two
  // Promise.all'd acquires from the same PID arbitrate via O_EXCL, one wins,
  // the other throws LockHeldError. This matches the documented behavior in
  // tests/unit/state/lock.test.ts ("two concurrent in-process acquires").
  // Clean serialization = exactly one call completes its write; the loser
  // surfaces the typed error and the mapping on disk is consistent with the
  // winner's mutation (no half-written state).
  //
  // The follow-up sequential call (after the loser's retry) should succeed,
  // proving the lock is properly released on the failure path.
  it("concurrent set_fork_mode calls serialize cleanly via StateLock", async () => {
    writeMapping(stateDir, {
      "100": makeMappingEntry({ slug: "a", target: path.join(dir, "a") }),
      "200": makeMappingEntry({ slug: "b", target: path.join(dir, "b") }),
    });

    const results = await Promise.allSettled([
      cfx_set_fork_mode({ grantId: 100, enabled: true, reason: "fork-a" }),
      cfx_set_fork_mode({ grantId: 200, enabled: true, reason: "fork-b" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The loser sees a typed LockHeldError (CfxError with code LOCK_HELD).
    const loserReason = (rejected[0] as PromiseRejectedResult).reason as CfxError;
    expect(loserReason).toBeInstanceOf(CfxError);
    expect(loserReason.code).toBe("LOCK_HELD");

    // The winner's mutation is on disk; the loser's target is untouched.
    const onDisk = readMapping(stateDir);
    const winner = (fulfilled[0] as PromiseFulfilledResult<SetForkModeOutputT>).value;
    expect(onDisk.entries[String(winner.grantId)]!.ignoreUpstreamUpdates).toBe(
      true
    );

    // After both settle, lock is released — the loser's grant can be set in a
    // fresh call, proving the release path runs even on failure.
    const loserGrantId = winner.grantId === 100 ? 200 : 100;
    const retry = await cfx_set_fork_mode({
      grantId: loserGrantId,
      enabled: true,
      reason: "retry",
    });
    expect(retry.ignoreUpstreamUpdates).toBe(true);
    expect(retry.grantId).toBe(loserGrantId);

    const finalMapping = readMapping(stateDir);
    expect(finalMapping.entries["100"]!.ignoreUpstreamUpdates).toBe(true);
    expect(finalMapping.entries["200"]!.ignoreUpstreamUpdates).toBe(true);
  });

  // --- Supplementary coverage ---------------------------------------------

  it("enabled:true without reason writes the triad but omits reason on disk", async () => {
    writeMapping(stateDir, {
      "100": makeMappingEntry({ slug: "m", target: path.join(dir, "t") }),
    });

    const result = await cfx_set_fork_mode({ grantId: 100, enabled: true });
    expect(result.ignoreUpstreamUpdates).toBe(true);
    expect(result.reason).toBeUndefined();

    const onDisk = readMapping(stateDir);
    const entry = onDisk.entries["100"]!;
    expect(entry.ignoreUpstreamUpdates).toBe(true);
    expect(entry.ignoreUpstreamUpdatesReason).toBeUndefined();
    expect(entry.ignoreUpstreamUpdatesSetAt).toBeDefined();
  });

  it("output round-trips through SetForkModeOutput schema", async () => {
    writeMapping(stateDir, {
      "100": makeMappingEntry({ slug: "m", target: path.join(dir, "t") }),
    });
    const result = await cfx_set_fork_mode({
      grantId: 100,
      enabled: true,
      reason: "fork",
    });
    expect(SetForkModeOutput.parse(result)).toEqual(result);
  });
});
