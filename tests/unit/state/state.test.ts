import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { State } from "../../../src/lib/state/state.js";

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
    });
    s.setLastPolledAt("local", "2026-02-02T00:00:00Z");
    await s.save();

    const s2 = new State(dir);
    await s2.load();
    expect(s2.get(111)?.slug).toBe("qs_inventory");
    expect(s2.lastPolledAt("local")).toBe("2026-02-02T00:00:00Z");
  });

  it("migrates v1 → v2 (lifts single lastPolledAt into rateLimit.local)", async () => {
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
    expect(on_disk.version).toBe(2);
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
    await expect(s.load()).rejects.toThrow(/Unknown state\.json version: 99.*state\.json/);
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
