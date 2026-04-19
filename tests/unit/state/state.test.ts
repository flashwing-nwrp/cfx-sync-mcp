import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { State } from "../../../src/lib/state/state.js";
import { StateSchemaTooNewError } from "../../../src/lib/errors.js";

describe("State", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "cfx-state-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("load() returns empty state if file missing", async () => {
    const s = new State(dir);
    await s.load();
    expect(s.all()).toEqual([]);
    expect(s.lastPolledAt("local")).toBe(null);
  });

  it("upsert + save + load round-trips", async () => {
    const s = new State(dir);
    await s.load();
    s.upsert({
      grantId: 111, assetId: 555, slug: "qs_inventory", assetName: "QS Inventory",
      versionId: 5001, packId: 700,
      updatedAt: "2026-02-01T00:00:00Z", sha256: "abc",
      cachedZipPath: "/c/111-5001.zip",
      deployedPath: "/srv/[qs]/qs-inventory", deployedAt: "2026-02-02T00:00:00Z",
      backups: ["2026-02-01T10:00:00Z"],
      pristineVersionId: null, pristineCapturedAt: null, pristineHashes: null,
    });
    s.setLastPolledAt("local", "2026-02-02T00:00:00Z");
    await s.save();

    const s2 = new State(dir);
    await s2.load();
    expect(s2.get(111)?.slug).toBe("qs_inventory");
    expect(s2.lastPolledAt("local")).toBe("2026-02-02T00:00:00Z");
  });

  it("migrates v1 → v3 (lifts single lastPolledAt into rateLimit.local)", async () => {
    const file = path.join(dir, "state.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        lastPolledAt: "2026-01-01T00:00:00Z",
        assets: {},
      })
    );
    const s = new State(dir);
    await s.load();
    expect(s.lastPolledAt("local")).toBe("2026-01-01T00:00:00Z");
    await s.save();
    const on_disk = JSON.parse(readFileSync(file, "utf8"));
    expect(on_disk.version).toBe(3);
    expect(on_disk.rateLimit.local.lastPolledAt).toBe("2026-01-01T00:00:00Z");
    expect(on_disk.lastPolledAt).toBeUndefined();
  });

  it("writes atomically (tmp + rename)", async () => {
    const s = new State(dir);
    await s.load();
    s.upsert({
      grantId: 222, assetId: 1, slug: "s", assetName: "S Asset",
      versionId: 1, packId: 1,
      updatedAt: "2026-01-01T00:00:00Z", sha256: "x",
      cachedZipPath: "", deployedPath: "", deployedAt: "", backups: [],
      pristineVersionId: null, pristineCapturedAt: null, pristineHashes: null,
    });
    await s.save();
    const tmp = path.join(dir, "state.json.tmp");
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(path.join(dir, "state.json"))).toBe(true);
  });

  it("throws on malformed JSON (surfaces path in message)", async () => {
    const file = path.join(dir, "state.json");
    writeFileSync(file, "{not valid json");
    const s = new State(dir);
    await expect(s.load()).rejects.toThrow();
  });

  it("throws on unknown version with file path in message", async () => {
    const file = path.join(dir, "state.json");
    writeFileSync(file, JSON.stringify({ version: 99, assets: {} }));
    const s = new State(dir);
    // Unknown versions newer than current code version now throw StateSchemaTooNewError
    // (which includes the version number in its message), so this regex still matches.
    await expect(s.load()).rejects.toThrow(/99/);
  });

  it("migrates v2 → v3 preserving prior fields and backfilling pristine fields to null", async () => {
    const file = path.join(dir, "state.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        rateLimit: { local: { lastPolledAt: "2026-03-01T00:00:00Z" } },
        assets: {
          "111": {
            grantId: 111, assetId: 555, slug: "qs_inventory", assetName: "QS Inventory",
            versionId: 5001, packId: 700,
            updatedAt: "2026-02-01T00:00:00Z", sha256: "abc",
            cachedZipPath: "/c/111-5001.zip",
            deployedPath: "/srv/[qs]/qs-inventory", deployedAt: "2026-02-02T00:00:00Z",
            backups: ["2026-02-01T10:00:00Z"],
          },
        },
      })
    );
    const s = new State(dir);
    await s.load();
    const entry = s.get(111);
    expect(entry).toBeDefined();
    // Prior fields preserved
    expect(entry?.slug).toBe("qs_inventory");
    expect(entry?.assetName).toBe("QS Inventory");
    expect(entry?.versionId).toBe(5001);
    expect(entry?.deployedPath).toBe("/srv/[qs]/qs-inventory");
    expect(entry?.backups).toEqual(["2026-02-01T10:00:00Z"]);
    // New pristine fields backfilled to null
    expect(entry?.pristineVersionId).toBe(null);
    expect(entry?.pristineCapturedAt).toBe(null);
    expect(entry?.pristineHashes).toBe(null);
    // Rate limit preserved
    expect(s.lastPolledAt("local")).toBe("2026-03-01T00:00:00Z");
    // On save, written as v3
    await s.save();
    const on_disk = JSON.parse(readFileSync(file, "utf8"));
    expect(on_disk.version).toBe(3);
    expect(on_disk.assets["111"].pristineVersionId).toBe(null);
    expect(on_disk.assets["111"].pristineCapturedAt).toBe(null);
    expect(on_disk.assets["111"].pristineHashes).toBe(null);
  });

  it("round-trips v3 with pristine fields populated", async () => {
    const s = new State(dir);
    await s.load();
    s.upsert({
      grantId: 777, assetId: 1, slug: "foo", assetName: "Foo",
      versionId: 10, packId: 1,
      updatedAt: "2026-04-01T00:00:00Z", sha256: "hash",
      cachedZipPath: "/c/777.zip",
      deployedPath: "/srv/foo", deployedAt: "2026-04-02T00:00:00Z",
      backups: [],
      pristineVersionId: 10,
      pristineCapturedAt: "2026-04-02T00:00:00Z",
      pristineHashes: { "file.lua": "deadbeef" },
    });
    await s.save();
    const s2 = new State(dir);
    await s2.load();
    const e = s2.get(777);
    expect(e?.pristineVersionId).toBe(10);
    expect(e?.pristineCapturedAt).toBe("2026-04-02T00:00:00Z");
    expect(e?.pristineHashes).toEqual({ "file.lua": "deadbeef" });
  });

  it("refuses v4 with StateSchemaTooNewError", async () => {
    const file = path.join(dir, "state.json");
    writeFileSync(
      file,
      JSON.stringify({ version: 4, rateLimit: {}, assets: {} })
    );
    const s = new State(dir);
    await expect(s.load()).rejects.toThrow(StateSchemaTooNewError);
    // Hint should mention required binary
    try {
      await s.load();
    } catch (e) {
      expect(e).toBeInstanceOf(StateSchemaTooNewError);
      const err = e as StateSchemaTooNewError;
      expect(err.onDiskVersion).toBe(4);
      expect(err.codeVersion).toBe(3);
      expect(err.requiredBinary).toMatch(/cfx-sync-mcp/);
      expect(err.hint).toMatch(/cfx-sync-mcp/);
    }
  });

  it("cleans up orphaned .tmp file on load", async () => {
    const file = path.join(dir, "state.json");
    writeFileSync(file, JSON.stringify({ version: 2, rateLimit: {}, assets: {} }));
    writeFileSync(file + ".tmp", "stale orphan from prior crash");
    const s = new State(dir);
    await s.load();
    expect(existsSync(file + ".tmp")).toBe(false);
  });
});
