import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Mapping, MappingEntry } from "../../../src/lib/state/mapping.js";
import { StateSchemaTooNewError } from "../../../src/lib/errors.js";

async function mkTempStateDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "mapping-v4-"));
  return dir;
}

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
        status: "active",
        reviewedByUser: true,
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

  it("status:'disabled' marks entry as skip-list", async () => {
    const m = new Mapping(dir);
    m.approveFromProposed({
      "1": { slug: "a", target: "/x", assetName: "A", discoveredTier: 1, discoveredConfidence: 1,
             status: "disabled", reviewedByUser: true },
    });
    expect(m.isDisabled(1)).toBe(true);
    expect(m.isDisabled(2)).toBe(false);
  });

  it("get(grantId) returns entry or undefined", async () => {
    const m = new Mapping(dir);
    m.approveFromProposed({
      "1": { slug: "a", target: "/x", status: "active", reviewedByUser: true, assetName: "A", discoveredTier: 1, discoveredConfidence: 1 },
    });
    expect(m.get(1)?.slug).toBe("a");
    expect(m.get(999)).toBeUndefined();
  });

  it("migrates v1 → v4 preserving prior fields and backfilling preservePaths fields to null", async () => {
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
    expect(entry?.assetName).toBe("QS Inventory");
    expect(entry?.discoveredTier).toBe(1);
    expect(entry?.discoveredConfidence).toBe(1.0);
    expect(entry?.notes).toBe("some note");
    // New preservePaths fields backfilled to null
    expect(entry?.preservePaths).toBe(null);
    expect(entry?.preservePathsSource).toBe(null);
    // v4 fields: tier-1 auto-acks to active + reviewed
    expect(entry?.status).toBe("active");
    expect(entry?.reviewedByUser).toBe(true);
    // Legacy `disabled` field stripped in v4
    expect(entry).not.toHaveProperty("disabled");
    // On save, written as v4
    await m.save();
    const on_disk = JSON.parse(readFileSync(file, "utf8"));
    expect(on_disk.version).toBe(4);
    expect(on_disk.entries["12345"].preservePaths).toBe(null);
    expect(on_disk.entries["12345"].preservePathsSource).toBe(null);
    expect(on_disk.entries["12345"].status).toBe("active");
    expect(on_disk.entries["12345"].reviewedByUser).toBe(true);
    expect(on_disk.entries["12345"]).not.toHaveProperty("disabled");
    expect(on_disk.newInstalls).toEqual([999]);
    expect(on_disk.orphaned).toEqual(["old_slug"]);
  });

  it("round-trips v2 with preservePaths fields populated", async () => {
    const m = new Mapping(dir);
    m.approveFromProposed({
      "42": {
        slug: "foo",
        target: "/srv/foo",
        assetName: "Foo",
        discoveredTier: 2,
        discoveredConfidence: 0.9,
        preservePaths: ["config/server.lua", "data/players.json"],
        preservePathsSource: "scan-v1",
        status: "active",
        reviewedByUser: true,
      },
    });
    await m.save();
    const m2 = new Mapping(dir);
    await m2.load();
    const entry = m2.get(42);
    expect(entry?.preservePaths).toEqual(["config/server.lua", "data/players.json"]);
    expect(entry?.preservePathsSource).toBe("scan-v1");
    expect(entry?.status).toBe("active");
    expect(entry?.reviewedByUser).toBe(true);
    const on_disk = JSON.parse(readFileSync(path.join(dir, "cfx-sync-map.json"), "utf8"));
    expect(on_disk.version).toBe(4);
  });

  it("refuses v5 mapping with StateSchemaTooNewError citing v4 as max", async () => {
    const file = path.join(dir, "cfx-sync-map.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 5,
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
      expect(err.onDiskVersion).toBe(5);
      expect(err.codeVersion).toBe(4);
      expect(err.requiredBinary).toMatch(/cfx-sync-mcp/);
      expect(err.requiredBinary).toMatch(/0\.4\.0/);
    }
  });

  it("migrates v2 → v4: fork-mode fields default undefined, on-disk writes version 4", async () => {
    const file = path.join(dir, "cfx-sync-map.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        approvedAt: "2026-03-01T00:00:00Z",
        entries: {
          "99": {
            slug: "some_resource",
            target: "server/resources/[some]/some_resource",
            disabled: false,
            assetName: "Some Resource",
            discoveredTier: 1,
            discoveredConfidence: 0.95,
            preservePaths: ["config/server.lua"],
            preservePathsSource: "scan-v1",
          },
        },
        newInstalls: [],
        orphaned: [],
      })
    );
    const m = new Mapping(dir);
    await m.load();
    const entry = m.get(99);
    expect(entry).toBeDefined();
    // Prior fields preserved
    expect(entry?.slug).toBe("some_resource");
    expect(entry?.preservePaths).toEqual(["config/server.lua"]);
    expect(entry?.preservePathsSource).toBe("scan-v1");
    // v3 fork-mode fields absent (undefined, not null)
    expect(entry?.ignoreUpstreamUpdates).toBeUndefined();
    expect(entry?.ignoreUpstreamUpdatesReason).toBeUndefined();
    expect(entry?.ignoreUpstreamUpdatesSetAt).toBeUndefined();
    // v4 fields: tier-1 auto-acks to active + reviewed
    expect(entry?.status).toBe("active");
    expect(entry?.reviewedByUser).toBe(true);
    // Legacy `disabled` field stripped in v4
    expect(entry).not.toHaveProperty("disabled");
    // On save, written as v4
    await m.save();
    const on_disk = JSON.parse(readFileSync(file, "utf8"));
    expect(on_disk.version).toBe(4);
    expect(on_disk.entries["99"].status).toBe("active");
    expect(on_disk.entries["99"].reviewedByUser).toBe(true);
    expect(on_disk.entries["99"]).not.toHaveProperty("disabled");
  });

  it("round-trips v4 with fork-mode fields populated", async () => {
    const m = new Mapping(dir);
    m.approveFromProposed({
      "77": {
        slug: "bar",
        target: "/srv/bar",
        assetName: "Bar",
        discoveredTier: 1,
        discoveredConfidence: 0.8,
        ignoreUpstreamUpdates: true,
        ignoreUpstreamUpdatesReason: "heavily customized — do not overwrite",
        ignoreUpstreamUpdatesSetAt: "2026-04-18T12:00:00.000Z",
        status: "active",
        reviewedByUser: true,
      },
    });
    await m.save();
    const m2 = new Mapping(dir);
    await m2.load();
    const entry = m2.get(77);
    expect(entry?.ignoreUpstreamUpdates).toBe(true);
    expect(entry?.ignoreUpstreamUpdatesReason).toBe("heavily customized — do not overwrite");
    expect(entry?.ignoreUpstreamUpdatesSetAt).toBe("2026-04-18T12:00:00.000Z");
    expect(entry?.status).toBe("active");
    expect(entry?.reviewedByUser).toBe(true);
    const on_disk = JSON.parse(readFileSync(path.join(dir, "cfx-sync-map.json"), "utf8"));
    expect(on_disk.version).toBe(4);
  });

  it("new MappingEntry without fork-mode fields has undefined (not null) for those fields", async () => {
    const m = new Mapping(dir);
    m.approveFromProposed({
      "55": {
        slug: "baz",
        target: "/srv/baz",
        status: "active",
        reviewedByUser: true,
        assetName: "Baz",
        discoveredTier: 1,
        discoveredConfidence: 1.0,
      },
    });
    await m.save();
    const m2 = new Mapping(dir);
    await m2.load();
    const entry = m2.get(55);
    expect(entry?.ignoreUpstreamUpdates).toBeUndefined();
    expect(entry?.ignoreUpstreamUpdatesReason).toBeUndefined();
    expect(entry?.ignoreUpstreamUpdatesSetAt).toBeUndefined();
  });
});

describe("Mapping v3→v4 migration", () => {
  const tempDirs: string[] = [];
  async function makeDir(): Promise<string> {
    const d = await mkTempStateDir();
    tempDirs.push(d);
    return d;
  }
  afterEach(() => {
    while (tempDirs.length > 0) {
      const d = tempDirs.pop()!;
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("defaults status to 'active' when legacy disabled is false/absent", async () => {
    const stateDir = await makeDir();
    await fs.writeFile(
      path.join(stateDir, "cfx-sync-map.json"),
      JSON.stringify({
        version: 3,
        approvedAt: "2026-01-01T00:00:00.000Z",
        entries: {
          "100": { slug: "a", target: "/tmp/a", disabled: false, assetName: "A",
                   discoveredTier: 1, discoveredConfidence: 1.0 },
        },
        newInstalls: [], orphaned: [],
      }, null, 2)
    );
    const m = new Mapping(stateDir);
    await m.load();
    const e = m.get(100)!;
    expect(e.status).toBe("active");
    expect(e.reviewedByUser).toBe(true); // tier 1 auto-ack
  });

  it("migrates legacy disabled:true to status:'disabled'", async () => {
    const stateDir = await makeDir();
    await fs.writeFile(
      path.join(stateDir, "cfx-sync-map.json"),
      JSON.stringify({
        version: 3, approvedAt: "2026-01-01T00:00:00.000Z",
        entries: {
          "200": { slug: "b", target: "/tmp/b", disabled: true, assetName: "B",
                   discoveredTier: 2, discoveredConfidence: 1.0 },
        },
        newInstalls: [], orphaned: [],
      })
    );
    const m = new Mapping(stateDir);
    await m.load();
    expect(m.get(200)!.status).toBe("disabled");
    expect(m.get(200)!.reviewedByUser).toBe(true);
  });

  it("tier 3/4 entries default reviewedByUser=false unless conf>=0.9 AND target exists", async () => {
    const stateDir = await makeDir();
    // conf 0.85 tier-3 → false regardless of target existence
    // conf 0.92 tier-4 with existing target → true
    // conf 0.7 tier-4 with existing target → false
    const existingTarget = path.join(stateDir, "real_folder");
    await fs.mkdir(existingTarget, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "cfx-sync-map.json"),
      JSON.stringify({
        version: 3, approvedAt: "2026-01-01T00:00:00.000Z",
        entries: {
          "300": { slug: "c", target: "/tmp/missing", disabled: false, assetName: "C",
                   discoveredTier: 3, discoveredConfidence: 0.85 },
          "400": { slug: "d", target: existingTarget, disabled: false, assetName: "D",
                   discoveredTier: 4, discoveredConfidence: 0.92 },
          "500": { slug: "e", target: existingTarget, disabled: false, assetName: "E",
                   discoveredTier: 4, discoveredConfidence: 0.70 },
        },
        newInstalls: [], orphaned: [],
      })
    );
    const m = new Mapping(stateDir);
    await m.load();
    expect(m.get(300)!.reviewedByUser).toBe(false);
    expect(m.get(400)!.reviewedByUser).toBe(true);
    expect(m.get(500)!.reviewedByUser).toBe(false);
  });

  it("round-trips v1 on-disk to v4 in-memory via the full chain", async () => {
    const stateDir = await makeDir();
    await fs.writeFile(
      path.join(stateDir, "cfx-sync-map.json"),
      JSON.stringify({
        version: 1, approvedAt: "2026-01-01T00:00:00.000Z",
        entries: {
          "600": { slug: "f", target: "/tmp/f", disabled: false, assetName: "F",
                   discoveredTier: 1, discoveredConfidence: 1.0 },
        },
        newInstalls: [], orphaned: [],
      })
    );
    const m = new Mapping(stateDir);
    await m.load();
    const f = m.getFile();
    expect(f.version).toBe(4);
    expect(m.get(600)!.status).toBe("active");
    expect(m.get(600)!.reviewedByUser).toBe(true);
    expect(m.get(600)!.preservePaths).toBeNull();  // v1→v2 field
    expect(m.get(600)!.preservePathsSource).toBeNull();
  });

  it("v4 writes omit the legacy 'disabled' field", async () => {
    const stateDir = await makeDir();
    const m = new Mapping(stateDir);
    m.approveFromProposed({
      "700": { slug: "g", target: "/tmp/g", disabled: false, assetName: "G",
               discoveredTier: 1, discoveredConfidence: 1.0,
               status: "active", reviewedByUser: true } as MappingEntry,
    });
    await m.save();
    const raw = JSON.parse(await fs.readFile(path.join(stateDir, "cfx-sync-map.json"), "utf8"));
    expect(raw.version).toBe(4);
    expect(raw.entries["700"]).not.toHaveProperty("disabled");
    expect(raw.entries["700"].status).toBe("active");
    expect(raw.entries["700"].reviewedByUser).toBe(true);
  });
});
