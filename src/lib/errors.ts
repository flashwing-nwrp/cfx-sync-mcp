export type CfxErrorCode =
  | "AUTH_EXPIRED" | "AUTH_MISSING"
  | "INVALID_TARGET" | "FORBIDDEN_ENDPOINT"
  | "MAPPING_UNAPPROVED" | "NOT_FOUND" | "AMBIGUOUS_SLUG"
  | "VALIDATION_FAILED" | "MULTI_PACK_UNSUPPORTED"
  | "TARGET_PARENT_MISSING" | "DISK_SPACE_LOW" | "STALL_TIMEOUT"
  | "UNKNOWN_LAYOUT" | "PLAYWRIGHT_NOT_INSTALLED"
  | "PORTAL_DISABLED"
  | "NETWORK" | "IO" | "LOCK_HELD" | "RATE_LIMITED" | "CONFIG";

export interface CfxErrorEnvelope {
  success: false;
  error: { code: CfxErrorCode; message: string; hint?: string; retryable?: boolean };
}

export class CfxError extends Error {
  readonly code: CfxErrorCode;
  readonly hint?: string;
  readonly retryable: boolean;
  constructor(code: CfxErrorCode, message: string, hint?: string, retryable = false) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.retryable = retryable;
    this.name = this.constructor.name;
  }
  toEnvelope(): CfxErrorEnvelope {
    return {
      success: false,
      error: { code: this.code, message: this.message, hint: this.hint, retryable: this.retryable },
    };
  }
}

export class AuthExpiredError extends CfxError {
  constructor(message = "Portal session expired or invalid.") {
    super("AUTH_EXPIRED", message, "Run the `cfx_login` tool to re-authenticate.");
  }
}
export class AuthMissingError extends CfxError {
  constructor(message = "No cookie file found.") {
    super("AUTH_MISSING", message, "Run the `cfx_login` tool.");
  }
}
export class InvalidTargetError extends CfxError {
  constructor(message: string) {
    super("INVALID_TARGET", message, "This is a bug — file an issue; should never fire.");
  }
}
export class ForbiddenEndpointError extends CfxError {
  constructor(message: string) {
    super("FORBIDDEN_ENDPOINT", message, "This is a bug — file an issue; should never fire.");
  }
}
export class MappingUnapprovedError extends CfxError {
  constructor(message = "Operation requires an approved cfx-sync-map.json.") {
    super("MAPPING_UNAPPROVED", message, "Run `cfx_discover` then `cfx_approve_mapping` first.");
  }
}
export class NotFoundError extends CfxError {
  constructor(message: string) { super("NOT_FOUND", message); }
}
export class AmbiguousSlugError extends CfxError {
  constructor(slug: string, grantIds: number[] = []) {
    super(
      "AMBIGUOUS_SLUG",
      `Slug "${slug}" matched multiple grants: ${grantIds.join(", ")}.`,
      "Pass `grantId` explicitly."
    );
  }
}
export class ValidationFailedError extends CfxError {
  constructor(message: string) {
    super("VALIDATION_FAILED", message, "Usually a bad pack from portal; retry or skip.");
  }
}
export class MultiPackUnsupportedError extends CfxError {
  constructor(packCount: number) {
    super(
      "MULTI_PACK_UNSUPPORTED",
      `Asset version has ${packCount} packs; Phase 1 requires explicit selection.`,
      "Pass `packIndex: N` to select which pack to download."
    );
  }
}
export class TargetParentMissingError extends CfxError {
  constructor(targetPath: string) {
    super(
      "TARGET_PARENT_MISSING",
      `Deploy target's parent directory does not exist: ${targetPath}`,
      "Re-run `cfx_discover` or edit cfx-sync-map.json to point at an existing category dir."
    );
  }
}
export class DiskSpaceLowError extends CfxError {
  constructor(needBytes: number, freeBytes: number) {
    super(
      "DISK_SPACE_LOW",
      `Need ~${needBytes} bytes free; have ${freeBytes}.`,
      "Free space or change CFX_CACHE_DIR / CFX_STAGING_DIR."
    );
  }
}
export class StallTimeoutError extends CfxError {
  constructor(afterMs: number) {
    super("STALL_TIMEOUT", `Download stalled (no bytes received for ${afterMs}ms).`, "Retry.", true);
  }
}
export class UnknownLayoutError extends CfxError {
  constructor(path: string) {
    super(
      "UNKNOWN_LAYOUT",
      `Could not detect categorized vs flat layout at ${path}.`,
      "Pass --layout categorized|flat explicitly."
    );
  }
}
export class PlaywrightNotInstalledError extends CfxError {
  constructor() {
    super(
      "PLAYWRIGHT_NOT_INSTALLED",
      "Chromium is not installed; Playwright login cannot launch.",
      "Run `npx playwright install chromium`, or set CFX_AUTH_MODE=file to use manual cookie export."
    );
  }
}
export class PortalDisabledError extends CfxError {
  constructor(assetName: string) {
    super(
      "PORTAL_DISABLED",
      `Asset "${assetName}" was disabled upstream (is_disabled=true).`,
      "Remove from cfx-sync-map.json; don't retry."
    );
  }
}
export class NetworkError extends CfxError {
  constructor(message: string) { super("NETWORK", message, "Check connectivity; retry.", true); }
}
export class IoError extends CfxError {
  constructor(message: string) { super("IO", message, "Check perms/disk."); }
}
export class LockHeldError extends CfxError {
  constructor(pid: number | null) {
    super(
      "LOCK_HELD",
      pid !== null
        ? `Another cfx-sync process (PID ${pid}) holds the state-dir lock.`
        : "State-dir lockfile exists but holder is unknown (possibly stale).",
      "Wait for the other run, or `--force-unlock` after verifying no process is active."
    );
  }
}
export class RateLimitedError extends CfxError {
  constructor(ageMs: number) {
    super(
      "RATE_LIMITED",
      `Last poll was ${Math.round(ageMs / 1000)}s ago; cache is still fresh.`,
      "Pass `force: true` to override the 1h soft cache.",
      true
    );
  }
}
export class ConfigError extends CfxError {
  constructor(message: string) { super("CONFIG", message, "Fix .env or env vars."); }
}
