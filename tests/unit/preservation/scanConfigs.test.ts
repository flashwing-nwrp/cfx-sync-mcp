import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { scanConfigs } from "../../../src/lib/preservation/scanConfigs.js";
import {
  scoreFile,
  LAYER_1_THRESHOLD,
} from "../../../src/lib/preservation/contentSignature.js";

/** Pure-config Lua source guaranteed to score >= LAYER_1_THRESHOLD. */
const PURE_CONFIG_SRC = `
return {
  debug = false,
  maxPlayers = 48,
  zones = {
    { name = 'downtown', radius = 500 },
    { name = 'airport',  radius = 1000 },
  },
  prices = {
    pizza = 15,
    soda = 3,
    beer = 8,
  },
  enabled = true,
}
`;

/** Heavy-function logic Lua source guaranteed to score well below LAYER_1_THRESHOLD. */
const LOGIC_SRC = `
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

describe("scanConfigs", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "cfx-scanconfigs-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("captures root pattern files (case-insensitive)", async () => {
    // Standard-name root configs.
    writeFileSync(path.join(root, "config.lua"), LOGIC_SRC);
    writeFileSync(path.join(root, "cfg.lua"), LOGIC_SRC);
    writeFileSync(path.join(root, "shared.lua"), LOGIC_SRC);
    writeFileSync(path.join(root, "permissions.lua"), LOGIC_SRC);
    writeFileSync(path.join(root, "settings.lua"), LOGIC_SRC);
    // Non-pattern file that also scores low — must NOT be captured.
    writeFileSync(path.join(root, "fxmanifest.lua"), LOGIC_SRC);

    const results = await scanConfigs(root);
    expect(results).toContain("config.lua");
    expect(results).toContain("cfg.lua");
    expect(results).toContain("shared.lua");
    expect(results).toContain("permissions.lua");
    expect(results).toContain("settings.lua");
    expect(results).not.toContain("fxmanifest.lua");
  });

  it("root pattern matching is case-insensitive", async () => {
    writeFileSync(path.join(root, "Config.lua"), LOGIC_SRC);
    writeFileSync(path.join(root, "CFG.LUA"), LOGIC_SRC);
    writeFileSync(path.join(root, "Shared.Lua"), LOGIC_SRC);

    const results = await scanConfigs(root);
    // Results are reported as the actual on-disk filename, forward-slashed.
    // The scan decision is case-insensitive but the returned path preserves
    // the original casing of the fs entry.
    const lower = results.map((r) => r.toLowerCase());
    expect(lower).toContain("config.lua");
    expect(lower).toContain("cfg.lua");
    expect(lower).toContain("shared.lua");
  });

  it("recursively captures files under config/, configs/, cfg/, settings/, locales/ (dir patterns)", async () => {
    // Build nested trees under every dir pattern. All content is LOGIC_SRC to
    // prove these are matched via *path*, not content-sig.
    for (const d of ["config", "configs", "cfg", "settings", "locales"]) {
      mkdirSync(path.join(root, d, "nested"), { recursive: true });
      writeFileSync(path.join(root, d, "top.lua"), LOGIC_SRC);
      writeFileSync(path.join(root, d, "nested", "deep.lua"), LOGIC_SRC);
    }
    // Sanity: non-pattern dir with logic content should NOT be captured.
    mkdirSync(path.join(root, "client"));
    writeFileSync(path.join(root, "client", "main.lua"), LOGIC_SRC);

    const results = await scanConfigs(root);
    for (const d of ["config", "configs", "cfg", "settings", "locales"]) {
      expect(results).toContain(`${d}/top.lua`);
      expect(results).toContain(`${d}/nested/deep.lua`);
    }
    expect(results).not.toContain("client/main.lua");
  });

  it("dir pattern matching is case-insensitive", async () => {
    mkdirSync(path.join(root, "Configs", "Nested"), { recursive: true });
    writeFileSync(path.join(root, "Configs", "Server.lua"), LOGIC_SRC);
    writeFileSync(
      path.join(root, "Configs", "Nested", "Locales.lua"),
      LOGIC_SRC,
    );

    const results = await scanConfigs(root);
    // Case preserved in output; path match was CI.
    const lower = results.map((r) => r.toLowerCase());
    expect(lower).toContain("configs/server.lua");
    expect(lower).toContain("configs/nested/locales.lua");
  });

  it("data/ is NOT a path pattern — entries land there only via content-sig", async () => {
    // Two files inside data/:
    //   prices.lua — pure config source (would score >= threshold)
    //   logic.lua  — heavy function source (scores well below threshold)
    //
    // If data/** were a path pattern, BOTH would be in results. Because it's
    // NOT a path pattern, only `prices.lua` makes it in (via content-sig).
    mkdirSync(path.join(root, "data"));
    writeFileSync(path.join(root, "data", "prices.lua"), PURE_CONFIG_SRC);
    writeFileSync(path.join(root, "data", "logic.lua"), LOGIC_SRC);

    // Precondition: confirm our fixtures actually have the scores we assume.
    // Guards against weight drift in contentSignature.ts silently breaking
    // this test's semantic meaning.
    const pricesScore = await scoreFile(path.join(root, "data", "prices.lua"));
    const logicScore = await scoreFile(path.join(root, "data", "logic.lua"));
    expect(pricesScore).not.toBeNull();
    expect(logicScore).not.toBeNull();
    expect(pricesScore!).toBeGreaterThanOrEqual(LAYER_1_THRESHOLD);
    expect(logicScore!).toBeLessThan(LAYER_1_THRESHOLD);

    const results = await scanConfigs(root);
    expect(results).toContain("data/prices.lua"); // via content-sig
    expect(results).not.toContain("data/logic.lua"); // data/ not path-captured
  });

  it("content signature catches config-like files at non-standard paths", async () => {
    // A config file at an "unusual" path — NOT matched by any path pattern.
    // Layer-1 should still flag it via content-sig.
    mkdirSync(path.join(root, "unusual", "dir"), { recursive: true });
    writeFileSync(
      path.join(root, "unusual", "dir", "config-like.lua"),
      PURE_CONFIG_SRC,
    );
    // And a sibling logic file — should NOT be captured.
    writeFileSync(path.join(root, "unusual", "dir", "handlers.lua"), LOGIC_SRC);

    const results = await scanConfigs(root);
    expect(results).toContain("unusual/dir/config-like.lua");
    expect(results).not.toContain("unusual/dir/handlers.lua");
  });

  it("pattern captures a dir-pattern file regardless of its content", async () => {
    // settings/weird-name.lua — matches dir pattern. Content is pure logic,
    // i.e. would NOT be caught by content-sig. Pattern must still win.
    mkdirSync(path.join(root, "settings"));
    writeFileSync(path.join(root, "settings", "weird-name.lua"), LOGIC_SRC);

    const results = await scanConfigs(root);
    expect(results).toContain("settings/weird-name.lua");
  });

  it("returns unique, forward-slash, repo-relative, sorted paths", async () => {
    // Set up a tree with files that could theoretically be double-matched
    // (config/ dir + config.lua root file) and verify invariants.
    mkdirSync(path.join(root, "config"));
    writeFileSync(path.join(root, "config.lua"), LOGIC_SRC); // root pattern
    writeFileSync(path.join(root, "config", "server.lua"), LOGIC_SRC); // dir pattern
    writeFileSync(path.join(root, "config", "client.lua"), LOGIC_SRC); // dir pattern
    writeFileSync(path.join(root, "shared.lua"), LOGIC_SRC); // root pattern

    const results = await scanConfigs(root);

    // No duplicates
    expect(new Set(results).size).toBe(results.length);
    // No backslashes
    for (const r of results) {
      expect(r).not.toContain("\\");
      expect(r.startsWith("/")).toBe(false);
      expect(r.startsWith("./")).toBe(false);
    }
    // Sorted ASCII-ascending
    const sorted = [...results].sort();
    expect(results).toEqual(sorted);
  });

  it("ignores non-.lua files entirely (neither pattern-captured nor scored)", async () => {
    // .json files live under locales/ legitimately; the spec says directory
    // patterns capture the dir tree recursively. We check content-sig only
    // for .lua files, but dir-pattern capture is file-type-agnostic — a
    // locales/en.json is a real resource file authors tweak.
    //
    // For this test we only need the weaker invariant: at non-standard paths,
    // non-.lua files are NOT captured via content-sig.
    writeFileSync(path.join(root, "README.md"), "# hello");
    writeFileSync(
      path.join(root, "notes.txt"),
      "= { foo = 1, bar = 2, baz = 3 }",
    );

    const results = await scanConfigs(root);
    expect(results).not.toContain("README.md");
    expect(results).not.toContain("notes.txt");
  });

  it("captures locales/*.json under the locales dir pattern", async () => {
    // Locales dir pattern is tree-recursive and file-type-agnostic: .json
    // locale files are the common case and must be picked up.
    mkdirSync(path.join(root, "locales"));
    writeFileSync(path.join(root, "locales", "en.json"), "{}");
    writeFileSync(path.join(root, "locales", "fr.json"), "{}");

    const results = await scanConfigs(root);
    expect(results).toContain("locales/en.json");
    expect(results).toContain("locales/fr.json");
  });

  it("returns [] for an empty directory", async () => {
    const results = await scanConfigs(root);
    expect(results).toEqual([]);
  });

  it("is deterministic — identical input yields identical output", async () => {
    writeFileSync(path.join(root, "config.lua"), LOGIC_SRC);
    mkdirSync(path.join(root, "configs"));
    writeFileSync(path.join(root, "configs", "a.lua"), LOGIC_SRC);
    writeFileSync(path.join(root, "configs", "b.lua"), LOGIC_SRC);
    mkdirSync(path.join(root, "unusual"));
    writeFileSync(
      path.join(root, "unusual", "config-ish.lua"),
      PURE_CONFIG_SRC,
    );

    const first = await scanConfigs(root);
    const second = await scanConfigs(root);
    expect(second).toEqual(first);
  });
});
