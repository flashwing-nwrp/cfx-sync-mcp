export type CfxErrorCode =
  | "AUTH_EXPIRED" | "AUTH_MISSING"
  | "INVALID_TARGET" | "FORBIDDEN_ENDPOINT"
  | "MAPPING_UNAPPROVED" | "NOT_FOUND" | "AMBIGUOUS_SLUG"
  | "VALIDATION_FAILED" | "MULTI_PACK_UNSUPPORTED"
  | "TARGET_PARENT_MISSING" | "DISK_SPACE_LOW" | "STALL_TIMEOUT"
  | "UNKNOWN_LAYOUT" | "PLAYWRIGHT_NOT_INSTALLED"
  | "PORTAL_DISABLED"
  | "NETWORK" | "IO" | "LOCK_HELD" | "RATE_LIMITED" | "CONFIG"
  | "FORBIDDEN" | "PORTAL_RATE_LIMIT"
  | "STATE_SCHEMA_TOO_NEW" | "CASE_COLLISION_DETECTED"
  | "ENCRYPTED_TAMPER_DETECTED" | "PRISTINE_CORRUPTED"
  | "CONFLICTS_UNRESOLVED" | "DEPLOY_INTERRUPTED"
  | "PATH_TOO_LONG";

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
export class ForbiddenError extends CfxError {
  constructor(url: string) {
    super(
      "FORBIDDEN",
      `Portal returned 403 for ${url} — grant or resource forbidden.`,
      "Grant may have been revoked; check the portal UI. Don't retry."
    );
  }
}
export class PortalRateLimitError extends CfxError {
  constructor(retryAfterSec: number | null) {
    super(
      "PORTAL_RATE_LIMIT",
      retryAfterSec !== null
        ? `Portal rate-limited this request; retry-after ${retryAfterSec}s.`
        : `Portal rate-limited this request; retry later.`,
      "Wait before retrying. Use `force: true` judiciously to avoid repeat limits.",
      true  // retryable
    );
  }
}
export class ConfigError extends CfxError {
  constructor(message: string) { super("CONFIG", message, "Fix .env or env vars."); }
}

// --- Phase 1.5 (preservation) errors ---------------------------------------

export class StateSchemaTooNewError extends CfxError {
  readonly onDiskVersion: number;
  readonly codeVersion: number;
  readonly requiredBinary: string;
  constructor(onDiskVersion: number, codeVersion: number, requiredBinary: string) {
    super(
      "STATE_SCHEMA_TOO_NEW",
      `State schema on disk is version ${onDiskVersion}, but this binary only understands up to version ${codeVersion}. Requires ${requiredBinary}.`,
      `Upgrade the binary to at least ${requiredBinary} (schema version ${onDiskVersion}) before continuing.`
    );
    this.onDiskVersion = onDiskVersion;
    this.codeVersion = codeVersion;
    this.requiredBinary = requiredBinary;
  }
}

export class CaseCollisionDetectedError extends CfxError {
  readonly pathA: string;
  readonly pathB: string;
  constructor(pathA: string, pathB: string = "") {
    super(
      "CASE_COLLISION_DETECTED",
      `Case-insensitive collision between "${pathA}" and "${pathB}" — both map to the same deploy target on Windows/macOS.`,
      "Rename one locally to resolve; deploy is case-safe only with distinct lowercase paths."
    );
    this.pathA = pathA;
    this.pathB = pathB;
  }
}

export class EncryptedTamperDetectedError extends CfxError {
  readonly path: string;
  constructor(path: string) {
    super(
      "ENCRYPTED_TAMPER_DETECTED",
      `Encrypted file has been modified since last deploy: ${path}`,
      "Run cfx_reset_pristine <grantId> to re-baseline, or cfx_rollback to restore from backup."
    );
    this.path = path;
  }
}

export class PristineCorruptedError extends CfxError {
  readonly grantId: number | string;
  readonly reason: string;
  constructor(grantId: number | string, reason: string = "pristine dir missing or hashes don't match state.json") {
    super(
      "PRISTINE_CORRUPTED",
      `Pristine baseline for grant ${grantId} is corrupted: ${reason}`,
      `Run cfx_reset_pristine ${grantId}; next deploy will treat as first-deploy.`
    );
    this.grantId = grantId;
    this.reason = reason;
  }
}

export class ConflictsUnresolvedError extends CfxError {
  readonly paths: string[];
  constructor(paths: string[] | string = []) {
    const list = Array.isArray(paths) ? paths : [paths];
    super(
      "CONFLICTS_UNRESOLVED",
      list.length > 0
        ? `Deploy plan has ${list.length} unresolved conflict(s): ${list.join(", ")}`
        : `Deploy plan has unresolved conflicts.`,
      "Pass conflictResolutions {path: resolution} to deploy — one entry per conflicting path (resolution = 'keep-local' | 'take-upstream' | 'merge')."
    );
    this.paths = list;
  }
}

export class DeployInterruptedError extends CfxError {
  readonly grantId: number;
  readonly stagingPath: string;
  readonly backupPath: string | null;
  readonly markerPath: string;
  constructor(
    grantId: number,
    stagingPath: string,
    backupPath: string | null = null,
    markerPath: string = ""
  ) {
    const backupDescr = backupPath === null ? "<first-deploy: no prior backup>" : backupPath;
    super(
      "DEPLOY_INTERRUPTED",
      `Prior deploy of grantId ${grantId} did not complete; in-flight marker detected (staging=${stagingPath}, backup=${backupDescr}).`,
      backupPath !== null
        ? `To recover: run cfx_rollback --grantId ${grantId} --toTimestamp <backup-iso> to restore pre-crash state, then retry deploy. Marker: ${markerPath}`
        : `First-deploy crash (no prior live to restore). Manually remove leftover staging at ${stagingPath} and any partial live dir, then delete the marker (${markerPath}) and retry deploy.`
    );
    this.grantId = grantId;
    this.stagingPath = stagingPath;
    this.backupPath = backupPath;
    this.markerPath = markerPath;
  }
}

/**
 * Windows MAX_PATH preflight guard. Raised by deploy_asset BEFORE any
 * filesystem mutation when a pack entry's eventual deploy path would exceed
 * the platform's maximum path length (260 chars on Windows without the
 * long-path-aware manifest / registry opt-in). Never raised on non-Windows.
 */
export class PathTooLongError extends CfxError {
  readonly path: string;
  readonly length: number;
  readonly limit: number;
  constructor(pathStr: string, length: number, limit: number) {
    super(
      "PATH_TOO_LONG",
      `Path exceeds maximum length (${length} > ${limit}): ${pathStr}. On Windows, enable long-path support OR move CFX_STATE_DIR to a shorter root.`,
      "Enable Windows long-path support (LongPathsEnabled registry key + app manifest) OR set CFX_STATE_DIR / CFX_SERVER_RESOURCES to a shorter root."
    );
    this.path = pathStr;
    this.length = length;
    this.limit = limit;
  }
}
