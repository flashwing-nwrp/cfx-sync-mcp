import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { Mapping } from "../../../src/lib/state/mapping.js";

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
});
