import { describe, it, expect } from "vitest";
import { detectCaseCollisions } from "../../../src/lib/preservation/caseDetection.js";

describe("detectCaseCollisions", () => {
  it("detects Configs/ vs configs/ collision within same tree", () => {
    // Directory-level case divergence surfaces as file-path collisions.
    const paths = [
      "Configs/server.lua",
      "configs/server.lua",
    ];

    const result = detectCaseCollisions(paths);

    expect(result).toHaveLength(1);
    expect(result[0].lowerPath).toBe("configs/server.lua");
    expect([...result[0].paths].sort()).toEqual([
      "Configs/server.lua",
      "configs/server.lua",
    ]);
  });

  it("detects Configs/Config.lua vs configs/config.lua", () => {
    const paths = [
      "Configs/Config.lua",
      "configs/config.lua",
    ];

    const result = detectCaseCollisions(paths);

    expect(result).toHaveLength(1);
    expect(result[0].lowerPath).toBe("configs/config.lua");
    expect([...result[0].paths].sort()).toEqual([
      "Configs/Config.lua",
      "configs/config.lua",
    ]);
  });

  it("does not false-positive on distinct filenames", () => {
    const paths = [
      "config/server.lua",
      "config/client.lua",
      "config/shared.lua",
      "fxmanifest.lua",
    ];

    const result = detectCaseCollisions(paths);

    expect(result).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(detectCaseCollisions([])).toEqual([]);
  });

  it("returns empty array for single-element input", () => {
    expect(detectCaseCollisions(["config/server.lua"])).toEqual([]);
  });

  it("dedupes exact-duplicate paths (same string twice is not a collision)", () => {
    // If the caller passes the same path twice it's a degenerate input, not a
    // real filesystem case collision. A collision requires 2+ DIFFERENT paths
    // that lowercase to the same value.
    const paths = ["config/server.lua", "config/server.lua"];

    const result = detectCaseCollisions(paths);

    expect(result).toEqual([]);
  });

  it("handles 3-way collision (three different casings of same lowered path)", () => {
    const paths = [
      "Config/Server.lua",
      "config/server.lua",
      "CONFIG/SERVER.LUA",
    ];

    const result = detectCaseCollisions(paths);

    expect(result).toHaveLength(1);
    expect(result[0].lowerPath).toBe("config/server.lua");
    expect([...result[0].paths].sort()).toEqual([
      "CONFIG/SERVER.LUA",
      "Config/Server.lua",
      "config/server.lua",
    ]);
  });

  it("emits multiple independent collision groups", () => {
    const paths = [
      "Configs/a.lua",
      "configs/a.lua",
      "Data/b.lua",
      "data/b.lua",
      "unique.lua",
    ];

    const result = detectCaseCollisions(paths);

    expect(result).toHaveLength(2);
    const byKey = new Map(result.map((g) => [g.lowerPath, g]));
    expect(byKey.has("configs/a.lua")).toBe(true);
    expect(byKey.has("data/b.lua")).toBe(true);
    expect([...byKey.get("configs/a.lua")!.paths].sort()).toEqual([
      "Configs/a.lua",
      "configs/a.lua",
    ]);
    expect([...byKey.get("data/b.lua")!.paths].sort()).toEqual([
      "Data/b.lua",
      "data/b.lua",
    ]);
  });
});
