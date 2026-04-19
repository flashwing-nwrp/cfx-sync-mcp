import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scoreContent,
  scoreFile,
  LAYER_1_THRESHOLD,
} from "../../../src/lib/preservation/contentSignature.js";

describe("contentSignature", () => {
  describe("LAYER_1_THRESHOLD", () => {
    it("is exported as a number in [0, 1]", () => {
      expect(typeof LAYER_1_THRESHOLD).toBe("number");
      expect(LAYER_1_THRESHOLD).toBeGreaterThanOrEqual(0);
      expect(LAYER_1_THRESHOLD).toBeLessThanOrEqual(1);
    });

    it("has the calibrated value 0.60 (reconcile pass against this scorer)", () => {
      expect(LAYER_1_THRESHOLD).toBe(0.6);
    });
  });

  describe("scoreContent — acceptance criteria", () => {
    it("returns > 0.9 for a pure Config = { ... } file", () => {
      const src = `
Config = {
  jobs = {
    { name = 'lspd', label = 'LSPD' },
    { name = 'ems',  label = 'EMS'  },
    { name = 'bcso', label = 'BCSO' },
  },
  prices = {
    pizza = 15,
    soda  = 3,
    beer  = 8,
  },
  enabled = true,
}
`;
      const score = scoreContent(src);
      expect(score).toBeGreaterThan(0.9);
    });

    it("returns < 0.3 for a heavy-function module file", () => {
      const src = `
local M = {}

function M.init()
  print('init')
  for i = 1, 10 do
    if i % 2 == 0 then
      print(i)
    end
  end
end

function M.tick(dt)
  local player = GetPlayerFromServerId(source)
  if not player then
    return
  end
  local pos = GetEntityCoords(player)
  SetEntityCoords(player, pos.x, pos.y, pos.z + 1)
  TriggerEvent('something:update', player)
end

function M.cleanup()
  for _, v in ipairs(M._handles) do
    if DoesEntityExist(v) then
      DeleteEntity(v)
    end
  end
end

return M
`;
      const score = scoreContent(src);
      expect(score).toBeLessThan(0.3);
    });

    it("returns a middling score (0.3..0.9) for a mixed file", () => {
      const src = `
-- A mixed file: data table + a couple of helpers.
local data = {
  categories = {
    { id = 1, name = 'food',  tax = 0.08 },
    { id = 2, name = 'drink', tax = 0.10 },
    { id = 3, name = 'fuel',  tax = 0.15 },
  },
}

function data.getCategory(id)
  for _, c in ipairs(data.categories) do
    if c.id == id then
      return c
    end
  end
end

return data
`;
      const score = scoreContent(src);
      expect(score).toBeGreaterThan(0.3);
      expect(score).toBeLessThan(0.9);
    });

    it("is a pure function — same input returns the same output", () => {
      const src = `Config = { foo = 1, bar = 2 }`;
      const a = scoreContent(src);
      const b = scoreContent(src);
      const c = scoreContent(src);
      expect(a).toBe(b);
      expect(b).toBe(c);
    });

    it("returns a value in [0, 1] for arbitrary input", () => {
      const samples = [
        "",
        "\n\n\n",
        "-- only comments\n-- like this\n",
        "local x = 1",
        "function foo() end function bar() end function baz() end",
        "require('something')\nrequire('else')\n",
      ];
      for (const s of samples) {
        const v = scoreContent(s);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("scoreContent — concrete shape heuristics", () => {
    it("return { ... } style config file scores high", () => {
      const src = `
return {
  debug = false,
  maxPlayers = 48,
  zones = {
    { name = 'downtown', radius = 500 },
    { name = 'airport',  radius = 1000 },
  },
}
`;
      expect(scoreContent(src)).toBeGreaterThan(0.8);
    });

    it("penalizes presence of require() calls", () => {
      const withRequire = `
local lib = require('ox_lib')
local util = require('util')
Config = { foo = 1 }
`;
      const withoutRequire = `
Config = { foo = 1 }
`;
      const sWith = scoreContent(withRequire);
      const sWithout = scoreContent(withoutRequire);
      expect(sWith).toBeLessThan(sWithout);
    });

    it("penalizes presence of dofile() calls", () => {
      const withDofile = `
dofile('resource/init.lua')
Config = { foo = 1 }
`;
      const withoutDofile = `
Config = { foo = 1 }
`;
      expect(scoreContent(withDofile)).toBeLessThan(scoreContent(withoutDofile));
    });

    it("penalizes many function definitions", () => {
      const manyFns = `
Config = { x = 1 }
function a() end
function b() end
function c() end
function d() end
`;
      const fewFns = `
Config = { x = 1 }
`;
      expect(scoreContent(manyFns)).toBeLessThan(scoreContent(fewFns));
    });

    it("ignores blank lines and comments in the line count denominator", () => {
      // These two should score similarly (both pure config); comments/blanks shouldn't drown the signal.
      const dense = `Config = { foo = 1, bar = 2 }`;
      const sparse = `
-- header comment
-- another comment

Config = {
  foo = 1,
  bar = 2,
}

-- trailing comment
`;
      const dScore = scoreContent(dense);
      const sScore = scoreContent(sparse);
      expect(dScore).toBeGreaterThan(0.8);
      expect(sScore).toBeGreaterThan(0.8);
    });

    it("empty or comment-only input returns 0 (nothing to score)", () => {
      expect(scoreContent("")).toBe(0);
      expect(scoreContent("\n\n\n")).toBe(0);
      expect(scoreContent("-- comment\n-- comment\n")).toBe(0);
    });
  });

  describe("scoreFile", () => {
    let tmpDir: string;

    it("reads a .lua file and returns its scoreContent value", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "cfx-contentsig-"));
      try {
        const luaPath = join(tmpDir, "Config.lua");
        const src = `Config = { foo = 1, bar = 2, baz = { 1, 2, 3 } }`;
        await writeFile(luaPath, src, "utf8");
        const s = await scoreFile(luaPath);
        expect(s).not.toBeNull();
        expect(s).toBe(scoreContent(src));
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns null for a non-.lua file (e.g., .fxap encrypted bytecode)", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "cfx-contentsig-"));
      try {
        const fxapPath = join(tmpDir, "core.fxap");
        await writeFile(fxapPath, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
        const s = await scoreFile(fxapPath);
        expect(s).toBeNull();
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("returns null for a missing file (unreadable)", async () => {
      const missing = join(tmpdir(), "cfx-contentsig-does-not-exist.lua");
      const s = await scoreFile(missing);
      expect(s).toBeNull();
    });

    it("does NOT perform fs access for scoreContent (pure function contract)", () => {
      // If scoreContent touched the fs, calling it with a path-like string would fail or leak.
      // It should treat its argument as Lua source text, not a path.
      const pathLike = "/this/is/not/really/a/file.lua";
      const score = scoreContent(pathLike);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });
});
