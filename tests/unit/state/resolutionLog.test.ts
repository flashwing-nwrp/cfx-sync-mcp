import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { ResolutionLog, type ResolutionLogEntry } from "../../../src/lib/state/resolutionLog.js";

describe("ResolutionLog", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "reslog-"));
  });
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("appends one JSON object per line", async () => {
    const log = new ResolutionLog(stateDir);
    const entry: ResolutionLogEntry = {
      ts: "2026-04-19T00:00:00.000Z",
      grantId: 100,
      author: "BroFX",
      assetName: "brofx_mansion_10",
      action: "pick",
      tierBefore: 4,
      confidenceBefore: 0.82,
      chosenBasename: "brofx_mansion_10_v2",
      overrideInput: null,
    };
    await log.append(entry);
    await log.append({ ...entry, grantId: 200, action: "skip", chosenBasename: null });
    const raw = await fs.readFile(path.join(stateDir, "resolution-log.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).grantId).toBe(100);
    expect(JSON.parse(lines[1]!).grantId).toBe(200);
  });

  it("creates the file on first append (does not require pre-existence)", async () => {
    const log = new ResolutionLog(stateDir);
    await log.append({
      ts: "2026-04-19T00:00:00.000Z",
      grantId: 1,
      author: null,
      assetName: "x",
      action: "skip",
      tierBefore: null,
      confidenceBefore: null,
      chosenBasename: null,
      overrideInput: null,
    });
    await expect(fs.stat(path.join(stateDir, "resolution-log.jsonl"))).resolves.toBeDefined();
  });

  it("logs-and-continues on write failure (does not throw)", async () => {
    // Point the log at an unwritable directory (nonexistent tree).
    const badDir = path.join(stateDir, "nope", "nope2");
    const log = new ResolutionLog(badDir);
    await expect(
      log.append({
        ts: "2026-04-19T00:00:00.000Z",
        grantId: 1,
        author: null,
        assetName: "x",
        action: "skip",
        tierBefore: null,
        confidenceBefore: null,
        chosenBasename: null,
        overrideInput: null,
      })
    ).resolves.toBeUndefined();
  });
});
