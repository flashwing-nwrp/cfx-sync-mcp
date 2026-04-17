import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/lib/config.js";
import { ConfigError } from "../../src/lib/errors.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";

describe("loadConfig", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let tmp: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tmp = mkdtempSync(path.join(tmpdir(), "cfxsync-"));
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("CFX_")) delete process.env[k];
    }
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws CONFIG when CFX_SERVER_RESOURCES is missing", () => {
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("loads all defaults when only CFX_SERVER_RESOURCES is set", () => {
    process.env.CFX_SERVER_RESOURCES = tmp;
    const cfg = loadConfig();
    expect(cfg.authMode).toBe("file");
    expect(cfg.apiBase).toBe("https://portal-api.cfx.re");
    expect(cfg.rateLimitTtlMs).toBe(3600000);
    expect(cfg.stallTimeoutMs).toBe(60000);
    expect(cfg.backupRetain).toBe(5);
  });

  it("rejects invalid CFX_AUTH_MODE", () => {
    process.env.CFX_SERVER_RESOURCES = tmp;
    process.env.CFX_AUTH_MODE = "invalid";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("creates state/cache/staging/backup dirs", () => {
    process.env.CFX_SERVER_RESOURCES = tmp;
    process.env.CFX_STATE_DIR = path.join(tmp, "state");
    process.env.CFX_CACHE_DIR = path.join(tmp, "cache");
    process.env.CFX_STAGING_DIR = path.join(tmp, "staging");
    process.env.CFX_BACKUP_DIR = path.join(tmp, "backups");
    const cfg = loadConfig();
    for (const d of [cfg.stateDir, cfg.cacheDir, cfg.stagingDir, cfg.backupDir]) {
      expect(fs.existsSync(d)).toBe(true);
    }
  });

  it("rejects non-integer CFX_BACKUP_RETAIN", () => {
    process.env.CFX_SERVER_RESOURCES = tmp;
    process.env.CFX_BACKUP_RETAIN = "abc";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("rejects negative integer env var", () => {
    process.env.CFX_SERVER_RESOURCES = tmp;
    process.env.CFX_RATE_LIMIT_TTL_MS = "-100";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("rejects invalid CFX_API_BASE URL", () => {
    process.env.CFX_SERVER_RESOURCES = tmp;
    process.env.CFX_API_BASE = "not-a-url";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("rejects empty CFX_SERVER_RESOURCES (set but empty string)", () => {
    process.env.CFX_SERVER_RESOURCES = "";
    expect(() => loadConfig()).toThrow(ConfigError);
  });
});
