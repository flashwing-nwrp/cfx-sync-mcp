import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import { ConfigError } from "./errors.js";

const AuthMode = z.enum(["playwright", "file"]);
export type AuthMode = z.infer<typeof AuthMode>;

const ApiBase = z.string().url();

export interface Config {
  apiBase: string;
  authMode: AuthMode;
  cookieFile: string;
  playwrightProfileDir: string;
  serverResources: string;
  stateDir: string;
  cacheDir: string;
  stagingDir: string;
  backupDir: string;
  backupRetain: number;
  rateLimitTtlMs: number;
  stallTimeoutMs: number;
  /**
   * Phase 1.5 feature flag. When true (default), deploy uses the Layer 2
   * preservation diff engine + pristine rotate pipeline. When false, deploy
   * reverts to the v0.1.0 plain-swap behavior AND skips pristine capture
   * entirely — a pure rollback path for operators who hit preservation bugs.
   *
   * Parsed from `CFX_SYNC_PRESERVE` env: "0" / "false" → disabled. Anything
   * else (including unset) → enabled.
   */
  preserveEnabled: boolean;
  /** `<stateDir>/pristine` — current pristine baseline per grant. */
  pristineDir: string;
  /** `<stateDir>/pristine-history` — snapshots for rollback. */
  pristineHistoryDir: string;
  /** `<stateDir>/conflicts` — staged-for-merge sidecars (.live / .pack). */
  conflictDir: string;
}

/**
 * Paths that preservation-aware tools share. Extracted so `cfx_reset_pristine`,
 * `cfx_deploy_asset`, and `cfx_rollback` look them up the same way (previously
 * each inlined `path.join(stateDir, ...)` with room for drift).
 *
 * Prefers the env-overridden fields on `cfg`; falls back to `<stateDir>/<name>`
 * for callers passing a partial config (e.g. tests or legacy tool code that
 * hasn't been updated to plumb all four fields).
 */
export interface PristinePaths {
  pristineDir: string;
  pristineHistoryDir: string;
  conflictDir: string;
}

export function getPristinePaths(
  cfg: Pick<Config, "stateDir"> & Partial<Pick<Config, "pristineDir" | "pristineHistoryDir" | "conflictDir">>
): PristinePaths {
  return {
    pristineDir: cfg.pristineDir ?? path.join(cfg.stateDir, "pristine"),
    pristineHistoryDir: cfg.pristineHistoryDir ?? path.join(cfg.stateDir, "pristine-history"),
    conflictDir: cfg.conflictDir ?? path.join(cfg.stateDir, "conflicts"),
  };
}

function req(name: string): string {
  const v = process.env[name];
  if (v === undefined) throw new ConfigError(`Missing required env var ${name}`);
  if (v === "") throw new ConfigError(`Required env var ${name} is set but empty`);
  return v;
}

function opt(name: string, dflt: string): string {
  const v = process.env[name];
  return v === undefined ? dflt : v;
}

function int(name: string, dflt: number): number {
  const v = process.env[name];
  if (!v) return dflt;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new ConfigError(`Invalid integer for ${name}: "${v}"`);
  }
  return n;
}

function resolve(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function boolEnv(name: string, dflt: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return dflt;
  // Accept "0" / "false" (case-insensitive) as disable; anything else (incl.
  // "", "1", "true", "yes", "on") enables. "" set explicitly is treated as
  // "enable" to match the 12-factor convention of "set but unset = default".
  const low = v.toLowerCase();
  if (low === "0" || low === "false" || low === "off" || low === "no") return false;
  return true;
}

export function loadConfig(): Config {
  const authModeRaw = opt("CFX_AUTH_MODE", "file");
  const authModeParsed = AuthMode.safeParse(authModeRaw);
  if (!authModeParsed.success) {
    throw new ConfigError(
      `CFX_AUTH_MODE must be "playwright" or "file", got "${authModeRaw}"`
    );
  }

  const apiBaseRaw = opt("CFX_API_BASE", "https://portal-api.cfx.re");
  const apiBaseParsed = ApiBase.safeParse(apiBaseRaw);
  if (!apiBaseParsed.success) {
    throw new ConfigError(`CFX_API_BASE must be a valid URL, got "${apiBaseRaw}"`);
  }

  const stateDir = resolve(opt("CFX_STATE_DIR", "./state"));
  // Default the preservation paths under stateDir; env overrides for tests.
  const pristineDir = resolve(opt("CFX_PRISTINE_DIR", path.join(stateDir, "pristine")));
  const pristineHistoryDir = resolve(
    opt("CFX_PRISTINE_HISTORY_DIR", path.join(stateDir, "pristine-history"))
  );
  const conflictDir = resolve(opt("CFX_CONFLICT_DIR", path.join(stateDir, "conflicts")));

  const cfg: Config = {
    apiBase: apiBaseParsed.data,
    authMode: authModeParsed.data,
    cookieFile: resolve(opt("CFX_COOKIE_FILE", "./.cookies.json")),
    playwrightProfileDir: resolve(opt("CFX_PLAYWRIGHT_PROFILE_DIR", "./.playwright-profile")),
    serverResources: resolve(req("CFX_SERVER_RESOURCES")),
    stateDir,
    cacheDir: resolve(opt("CFX_CACHE_DIR", "./cache")),
    stagingDir: resolve(opt("CFX_STAGING_DIR", "./staging")),
    backupDir: resolve(opt("CFX_BACKUP_DIR", "./state/backups")),
    backupRetain: int("CFX_BACKUP_RETAIN", 5),
    rateLimitTtlMs: int("CFX_RATE_LIMIT_TTL_MS", 3_600_000),
    stallTimeoutMs: int("CFX_STALL_TIMEOUT_MS", 60_000),
    preserveEnabled: boolEnv("CFX_SYNC_PRESERVE", true),
    pristineDir,
    pristineHistoryDir,
    conflictDir,
  };

  for (const d of [cfg.stateDir, cfg.cacheDir, cfg.stagingDir, cfg.backupDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return cfg;
}
