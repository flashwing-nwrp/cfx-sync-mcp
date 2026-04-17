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
  serverResources: string;
  stateDir: string;
  cacheDir: string;
  stagingDir: string;
  backupDir: string;
  backupRetain: number;
  rateLimitTtlMs: number;
  stallTimeoutMs: number;
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

  const cfg: Config = {
    apiBase: apiBaseParsed.data,
    authMode: authModeParsed.data,
    cookieFile: resolve(opt("CFX_COOKIE_FILE", "./.cookies.json")),
    serverResources: resolve(req("CFX_SERVER_RESOURCES")),
    stateDir: resolve(opt("CFX_STATE_DIR", "./state")),
    cacheDir: resolve(opt("CFX_CACHE_DIR", "./cache")),
    stagingDir: resolve(opt("CFX_STAGING_DIR", "./staging")),
    backupDir: resolve(opt("CFX_BACKUP_DIR", "./state/backups")),
    backupRetain: int("CFX_BACKUP_RETAIN", 5),
    rateLimitTtlMs: int("CFX_RATE_LIMIT_TTL_MS", 3_600_000),
    stallTimeoutMs: int("CFX_STALL_TIMEOUT_MS", 60_000),
  };

  for (const d of [cfg.stateDir, cfg.cacheDir, cfg.stagingDir, cfg.backupDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return cfg;
}
