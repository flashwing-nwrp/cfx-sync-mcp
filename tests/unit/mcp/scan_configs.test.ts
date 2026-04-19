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
import { cfx_scan_configs } from "../../../src/mcp/tools/scan_configs.js";
import { ScanConfigsInput, ScanConfigsOutput } from "../../../src/mcp/schemas/index.js";
import { MappingUnapprovedError, CfxError } from "../../../src/lib/errors.js";
import type { MappingFile, MappingEntry } from "../../../src/lib/state/mapping.js";

/** Builds a minimal resource dir containing `files` (relative paths → contents). */
function makeResource(root: string, files: Record<string, string>): string {
  mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

function makeMappingEntry(partial: Partial<MappingEntry> & { slug: string; target: string }): MappingEntry {
  return {
    disabled: false,
    assetName: partial.slug,
    discoveredTier: 1,
    discoveredConfidence: 1.0,
    preservePaths: null,
    preservePathsSource: null,
    ...partial,
  };
}

function writeMapping(stateDir: string, entries: Record<string, MappingEntry>): void {
  const file: MappingFile = {
    version: 3,
    approvedAt: "2026-04-17T10:30:00.000Z",
    entries,
    newInstalls: [],
    orphaned: [],
  };
  writeFileSync(path.join(stateDir, "cfx-sync-map.json"), JSON.stringify(file, null, 2));
}

function readMapping(stateDir: string): MappingFile {
  return JSON.parse(readFileSync(path.join(stateDir, "cfx-sync-map.json"), "utf8")) as MappingFile;
}

describe("cfx_scan_configs", () => {
  let dir: string;
  let stateDir: string;
  let resourcesDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cfx-scan-"));
    stateDir = path.join(dir, "state");
    resourcesDir = path.join(dir, "resources");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(resourcesDir, { recursive: true });
    process.env.CFX_SERVER_RESOURCES = resourcesDir;
    process.env.CFX_STATE_DIR = stateDir;
    process.env.CFX_CACHE_DIR = path.join(dir, "cache");
    process.env.CFX_STAGING_DIR = path.join(dir, "staging");
    process.env.CFX_BACKUP_DIR = path.join(dir, "backups");
    process.env.CFX_COOKIE_FILE = path.join(dir, ".cookies.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws MappingUnapprovedError when no mapping exists", async () => {
    await expect(cfx_scan_configs({})).rejects.toBeInstanceOf(MappingUnapprovedError);
  });

  it("scans all non-disabled entries when called with no args", async () => {
    const rA = makeResource(path.join(resourcesDir, "resA"), {
      "config.lua": "return { a = 1 }",
      "configs/extra.lua": "return { b = 2 }",
      "client/main.lua": "function M() end",
    });
    const rB = makeResource(path.join(resourcesDir, "resB"), {
      "shared.lua": "return { x = true }",
    });

    writeMapping(stateDir, {
      "100": makeMappingEntry({ slug: "res_a", target: rA }),
      "200": makeMappingEntry({ slug: "res_b", target: rB }),
    });

    const result = await cfx_scan_configs({});
    const parsed = ScanConfigsOutput.parse(result);
    expect(parsed.scanned.length).toBe(2);

    const byId = new Map(parsed.scanned.map((s) => [s.grantId, s]));
    expect(byId.get(100)?.preservePaths).toEqual(["config.lua", "configs/extra.lua"]);
    expect(byId.get(100)?.count).toBe(2);
    expect(byId.get(200)?.preservePaths).toEqual(["shared.lua"]);
    expect(parsed.totalPreservePaths).toBe(3);

    // Mapping written back with source tag.
    const onDisk = readMapping(stateDir);
    expect(onDisk.entries["100"]!.preservePaths).toEqual(["config.lua", "configs/extra.lua"]);
    expect(onDisk.entries["100"]!.preservePathsSource).toBe("scan-v1");
    expect(onDisk.entries["200"]!.preservePaths).toEqual(["shared.lua"]);
    expect(onDisk.entries["200"]!.preservePathsSource).toBe("scan-v1");
  });

  it("treats {all: true} identically to {}", async () => {
    const rA = makeResource(path.join(resourcesDir, "resA"), {
      "config.lua": "return { a = 1 }",
    });
    writeMapping(stateDir, {
      "100": makeMappingEntry({ slug: "res_a", target: rA }),
    });
    const result = await cfx_scan_configs({ all: true });
    expect(result.scanned.length).toBe(1);
    expect(result.scanned[0]!.grantId).toBe(100);
  });

  it("skips disabled entries", async () => {
    const rA = makeResource(path.join(resourcesDir, "resA"), {
      "config.lua": "return { a = 1 }",
    });
    const rB = makeResource(path.join(resourcesDir, "resB"), {
      "config.lua": "return { b = 2 }",
    });

    writeMapping(stateDir, {
      "100": makeMappingEntry({ slug: "res_a", target: rA }),
      "200": makeMappingEntry({ slug: "res_b", target: rB, disabled: true }),
    });

    const result = await cfx_scan_configs({});
    expect(result.scanned.length).toBe(1);
    expect(result.scanned[0]!.grantId).toBe(100);
    expect(result.skipped?.length ?? 0).toBe(1);
    expect(result.skipped?.[0]?.grantId).toBe(200);
    expect(result.skipped?.[0]?.reason).toBe("disabled");

    // Disabled entry's preservePaths left untouched.
    const onDisk = readMapping(stateDir);
    expect(onDisk.entries["200"]!.preservePaths).toBeNull();
  });

  it("scans a single grant by grantId", async () => {
    const rA = makeResource(path.join(resourcesDir, "resA"), {
      "config.lua": "return { a = 1 }",
    });
    const rB = makeResource(path.join(resourcesDir, "resB"), {
      "shared.lua": "return { b = 2 }",
    });

    writeMapping(stateDir, {
      "100": makeMappingEntry({ slug: "res_a", target: rA }),
      "200": makeMappingEntry({ slug: "res_b", target: rB }),
    });

    const result = await cfx_scan_configs({ grantId: 200 });
    expect(result.scanned.length).toBe(1);
    expect(result.scanned[0]!.grantId).toBe(200);
    expect(result.scanned[0]!.preservePaths).toEqual(["shared.lua"]);

    // Only scanned entry got written; other untouched.
    const onDisk = readMapping(stateDir);
    expect(onDisk.entries["200"]!.preservePathsSource).toBe("scan-v1");
    expect(onDisk.entries["100"]!.preservePathsSource).toBeNull();
  });

  it("throws NotFoundError when grantId missing from mapping", async () => {
    writeMapping(stateDir, {});
    await expect(cfx_scan_configs({ grantId: 999 })).rejects.toBeInstanceOf(CfxError);
  });

  it("throws when grantId references a disabled entry", async () => {
    const rA = makeResource(path.join(resourcesDir, "resA"), {
      "config.lua": "return { a = 1 }",
    });
    writeMapping(stateDir, {
      "100": makeMappingEntry({ slug: "res_a", target: rA, disabled: true }),
    });
    await expect(cfx_scan_configs({ grantId: 100 })).rejects.toBeInstanceOf(CfxError);
  });

  it("rejects passing both grantId and all via schema refinement", () => {
    const parsed = ScanConfigsInput.safeParse({ grantId: 100, all: true });
    expect(parsed.success).toBe(false);
  });

  it("emits skipped for grants whose target directory is missing (all-mode)", async () => {
    const rA = makeResource(path.join(resourcesDir, "resA"), {
      "config.lua": "return { a = 1 }",
    });
    // resB's target is never created.
    writeMapping(stateDir, {
      "100": makeMappingEntry({ slug: "res_a", target: rA }),
      "200": makeMappingEntry({
        slug: "res_b",
        target: path.join(resourcesDir, "does_not_exist"),
      }),
    });

    const result = await cfx_scan_configs({});
    expect(result.scanned.length).toBe(1);
    expect(result.scanned[0]!.grantId).toBe(100);
    expect(result.skipped?.length ?? 0).toBe(1);
    expect(result.skipped?.[0]?.grantId).toBe(200);
    expect(result.skipped?.[0]?.reason).toBe("target-not-found");
  });

  it("is idempotent — re-running with no changes yields the same preservePaths", async () => {
    const rA = makeResource(path.join(resourcesDir, "resA"), {
      "config.lua": "return { a = 1 }",
      "configs/extra.lua": "return { b = 2 }",
    });
    writeMapping(stateDir, {
      "100": makeMappingEntry({ slug: "res_a", target: rA }),
    });

    const first = await cfx_scan_configs({});
    const firstOnDisk = readMapping(stateDir);

    const second = await cfx_scan_configs({});
    const secondOnDisk = readMapping(stateDir);

    expect(second.scanned[0]!.preservePaths).toEqual(first.scanned[0]!.preservePaths);
    expect(secondOnDisk.entries["100"]!.preservePaths).toEqual(
      firstOnDisk.entries["100"]!.preservePaths
    );
    expect(secondOnDisk.entries["100"]!.preservePathsSource).toBe("scan-v1");
  });

  it("output round-trips through ScanConfigsOutput schema without dropping fields", async () => {
    const rA = makeResource(path.join(resourcesDir, "resA"), {
      "config.lua": "return { a = 1 }",
    });
    writeMapping(stateDir, {
      "100": makeMappingEntry({ slug: "res_a", target: rA }),
    });
    const result = await cfx_scan_configs({});
    const roundTripped = ScanConfigsOutput.parse(result);
    expect(roundTripped).toEqual(result);
  });
});
