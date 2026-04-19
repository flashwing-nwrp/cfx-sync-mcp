import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  writeInFlightMarker,
  readInFlightMarker,
  clearInFlightMarker,
  markerPath,
  type InFlightMarker,
} from "../../../src/lib/deploy/inFlight.js";

describe("in-flight deploy marker helpers", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(tmpdir(), "cfx-inflight-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("writeInFlightMarker + readInFlightMarker round-trip", async () => {
    const m: InFlightMarker = {
      grantId: 42,
      stagingPath: "/tmp/staging/extract-abc",
      backupPath: "/tmp/backups/my_asset/2026-04-18T00-00-00-000Z",
      startedAt: "2026-04-18T00:00:00.000Z",
    };
    const writtenPath = await writeInFlightMarker(stateDir, m);
    expect(writtenPath).toBe(markerPath(stateDir, 42));
    expect(existsSync(writtenPath)).toBe(true);

    const read = await readInFlightMarker(stateDir, 42);
    expect(read).toEqual(m);
  });

  it("supports backupPath: null for first-deploy crashes", async () => {
    const m: InFlightMarker = {
      grantId: 7,
      stagingPath: "/tmp/staging/extract-xyz",
      backupPath: null,
      startedAt: "2026-04-18T00:00:00.000Z",
    };
    await writeInFlightMarker(stateDir, m);
    const read = await readInFlightMarker(stateDir, 7);
    expect(read).not.toBeNull();
    expect(read!.backupPath).toBeNull();
  });

  it("readInFlightMarker returns null when no marker exists", async () => {
    const r = await readInFlightMarker(stateDir, 99);
    expect(r).toBeNull();
  });

  it("readInFlightMarker returns null on malformed JSON", async () => {
    const dir = path.join(stateDir, "in-flight");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "5.json"), "{not valid json");
    const r = await readInFlightMarker(stateDir, 5);
    expect(r).toBeNull();
  });

  it("readInFlightMarker returns null when required fields are missing", async () => {
    const dir = path.join(stateDir, "in-flight");
    mkdirSync(dir, { recursive: true });
    // grantId missing
    writeFileSync(
      path.join(dir, "5.json"),
      JSON.stringify({ stagingPath: "/x", backupPath: null, startedAt: "2026-04-18T00:00:00Z" })
    );
    const r = await readInFlightMarker(stateDir, 5);
    expect(r).toBeNull();
  });

  it("clearInFlightMarker removes the marker file", async () => {
    const m: InFlightMarker = {
      grantId: 11,
      stagingPath: "/s",
      backupPath: "/b",
      startedAt: "2026-04-18T00:00:00.000Z",
    };
    const p = await writeInFlightMarker(stateDir, m);
    expect(existsSync(p)).toBe(true);
    await clearInFlightMarker(stateDir, 11);
    expect(existsSync(p)).toBe(false);
  });

  it("clearInFlightMarker is ENOENT-tolerant (no throw when marker absent)", async () => {
    // Nothing to clear — must not throw.
    await expect(clearInFlightMarker(stateDir, 404)).resolves.toBeUndefined();
  });

  it("writeInFlightMarker overwrites a prior marker atomically", async () => {
    const m1: InFlightMarker = {
      grantId: 3,
      stagingPath: "/old",
      backupPath: "/old-backup",
      startedAt: "2026-04-18T00:00:00.000Z",
    };
    const m2: InFlightMarker = {
      grantId: 3,
      stagingPath: "/new",
      backupPath: "/new-backup",
      startedAt: "2026-04-18T01:00:00.000Z",
    };
    await writeInFlightMarker(stateDir, m1);
    await writeInFlightMarker(stateDir, m2);
    const read = await readInFlightMarker(stateDir, 3);
    expect(read).toEqual(m2);
    // On-disk file should contain the latest payload, not a concatenation.
    const raw = readFileSync(markerPath(stateDir, 3), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.stagingPath).toBe("/new");
  });

  it("markers for different grantIds are independent", async () => {
    await writeInFlightMarker(stateDir, {
      grantId: 1,
      stagingPath: "/s1",
      backupPath: null,
      startedAt: "2026-04-18T00:00:00.000Z",
    });
    await writeInFlightMarker(stateDir, {
      grantId: 2,
      stagingPath: "/s2",
      backupPath: "/b2",
      startedAt: "2026-04-18T00:00:00.000Z",
    });
    await clearInFlightMarker(stateDir, 1);
    expect(await readInFlightMarker(stateDir, 1)).toBeNull();
    expect(await readInFlightMarker(stateDir, 2)).not.toBeNull();
  });
});
