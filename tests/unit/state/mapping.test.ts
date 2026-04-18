import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Mapping } from "../../../src/lib/state/mapping.js";
import { StateSchemaTooNewError } from "../../../src/lib/errors.js";

describe("Mapping", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "cfx-map-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns isApproved=false when no file exists", async () => {
    const m = new Mapping(dir);
    await m.load();
    expect(m.isApproved()).toBe(false);
    expect(m.entries()).toEqual({});
  });

  it("approveFromProposed() writes cfx-sync-map.json", async () => {
    const m = new Mapping(dir);
    await m.load();
    m.approveFromProposed({
      "12345": {
        slug: "qs_inventory",
        target: "server/resources/[qs]/qs-inventory",
        disabled: false,
        assetName: "QS Inventory",
        discoveredTier: 1,
        discoveredConfidence: 1.0,
      },
    });
    await m.save();
    expect(m.isApproved()).toBe(true);
    const on_disk = JSON.parse(readFileSync(path.join(dir, "cfx-sync-map.json"), "utf8"));
    expect(on_disk.entries["12345"].slug).toBe("qs_inventory");
  });

  it("disabled flag marks entry as skip-list", async () => {
    const m = new Mapping(dir);
    m.approveFromProposed({
      "1": { slug: "a", target: "/x", disabled: true, assetName: "A", discoveredTier: 1, discoveredConfidence: 1 },
    });
    expect(m.isDisabled(1)).toBe(true);
    expect(m.isDisabled(2)).toBe(false);
  });

  it("get(grantId) returns entry or undefined", async () => {
    const m = new Mapping(dir);
    m.approveFromProposed({
      "1": { slug: "a", target: "/x", disabled: false, assetName: "A", discoveredTier: 1, discoveredConfidence: 1 },
    });
    expect(m.get(1)?.slug).toBe("a");
    expect(m.get(999)).toBeUndefined();
  });

  it("migrates v1 → v2 preserving prior fields and backfilling preservePaths fields to null", async () => {
    const file = path.join(dir, "cfx-sync-map.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        approvedAt: "2026-02-15T00:00:00Z",
        entries: {
          "12345": {
            slug: "qs_inventory",
            target: "server/resources/[qs]/qs-inventory",
            disabled: false,
            assetName: "QS Inventory",
            discoveredTier: 1,
            discoveredConfidence: 1.0,
            notes: "some note",
          },
        },
        newInstalls: [999],
        orphaned: ["old_slug"],
      })
    );
    const m = new Mapping(dir);
    await m.load();
    expect(m.isApproved()).toBe(true);
    const entry = m.get(12345);
    expect(entry).toBeDefined();
    // Prior fields preserved
    expect(entry?.slug).toBe("qs_inventory");
    expect(entry?.target).toBe("server/resources/[qs]/qs-inventory");
    expect(entry?.disabled).toBe(false);
    expect(entry?.assetName).toBe("QS Inventory");
    expect(entry?.discoveredTier).toBe(1);
    expect(entry?.discoveredConfidence).toBe(1.0);
    expect(entry?.notes).toBe("some note");
    // New preservePaths fields backfilled to null
    expect(entry?.preservePaths).toBe(null);
    expect(entry?.preservePathsSource).toBe(null);
    // On save, written as v2
    await m.save();
    const on_disk = JSON.parse(readFileSync(file, "utf8"));
    expect(on_disk.version).toBe(2);
    expect(on_disk.entries["12345"].preservePaths).toBe(null);
    expect(on_disk.entries["12345"].preservePathsSource).toBe(null);
    expect(on_disk.newInstalls).toEqual([999]);
    expect(on_disk.orphaned).toEqual(["old_slug"]);
  });

  it("round-trips v2 with preservePaths fields populated", async () => {
    const m = new Mapping(dir);
    m.approveFromProposed({
      "42": {
        slug: "foo",
        target: "/srv/foo",
        disabled: false,
        assetName: "Foo",
        discoveredTier: 2,
        discoveredConfidence: 0.9,
        preservePaths: ["config/server.lua", "data/players.json"],
        preservePathsSource: "scan-v1",
      },
    });
    await m.save();
    const m2 = new Mapping(dir);
    await m2.load();
    const entry = m2.get(42);
    expect(entry?.preservePaths).toEqual(["config/server.lua", "data/players.json"]);
    expect(entry?.preservePathsSource).toBe("scan-v1");
    const on_disk = JSON.parse(readFileSync(path.join(dir, "cfx-sync-map.json"), "utf8"));
    expect(on_disk.version).toBe(2);
  });

  it("refuses v3 mapping with StateSchemaTooNewError", async () => {
    const file = path.join(dir, "cfx-sync-map.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 3,
        approvedAt: "2026-05-01T00:00:00Z",
        entries: {},
        newInstalls: [],
        orphaned: [],
      })
    );
    const m = new Mapping(dir);
    await expect(m.load()).rejects.toThrow(StateSchemaTooNewError);
    try {
      await m.load();
    } catch (e) {
      expect(e).toBeInstanceOf(StateSchemaTooNewError);
      const err = e as StateSchemaTooNewError;
      expect(err.onDiskVersion).toBe(3);
      expect(err.codeVersion).toBe(2);
      expect(err.requiredBinary).toMatch(/cfx-sync-mcp/);
    }
  });
});
