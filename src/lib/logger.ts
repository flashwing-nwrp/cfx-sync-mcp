// Structured logger — field allowlist, never stringifies arbitrary objects.
// Cookie-shaped data has no path into log output by construction.

const ALLOWED_FIELDS = new Set([
  "event", "level", "message",
  "grantId", "versionId", "packId", "slug", "assetName",
  "path", "bytes", "durationMs", "code", "hint",
  "count", "tier", "confidence", "stale",
  "lastPolledAt", "deployedAt", "backupPath",
  "callerId",
]);

export interface LogFields {
  event: string;
  grantId?: number;
  versionId?: number;
  packId?: number;
  slug?: string;
  assetName?: string;
  path?: string;
  bytes?: number;
  durationMs?: number;
  code?: string;
  hint?: string;
  count?: number;
  tier?: number;
  confidence?: number;
  stale?: boolean;
  lastPolledAt?: string;
  deployedAt?: string;
  backupPath?: string;
  callerId?: string;
  message?: string;
}

type Level = "info" | "warn" | "error";

function format(level: Level, fields: LogFields): string {
  const safe: Record<string, unknown> = { level };
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(k)) continue;
    if (typeof v === "object" && v !== null) continue; // drop objects
    safe[k] = v;
  }
  const prefix = `[cfx-sync][${level}]`;
  const parts = Object.entries(safe)
    .filter(([k]) => k !== "level")
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return `${prefix} ${parts.join(" ")}\n`;
}

export interface Logger {
  info: (fields: LogFields) => void;
  warn: (fields: LogFields) => void;
  error: (fields: LogFields) => void;
}

export function createLogger(): Logger {
  return {
    info: (f) => process.stderr.write(format("info", f)),
    warn: (f) => process.stderr.write(format("warn", f)),
    error: (f) => process.stderr.write(format("error", f)),
  };
}
