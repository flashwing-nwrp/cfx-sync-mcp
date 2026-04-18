import { describe, it, expect } from "vitest";
import {
  CfxError,
  AuthExpiredError,
  AuthMissingError,
  InvalidTargetError,
  ForbiddenEndpointError,
  MappingUnapprovedError,
  NotFoundError,
  AmbiguousSlugError,
  ValidationFailedError,
  MultiPackUnsupportedError,
  TargetParentMissingError,
  DiskSpaceLowError,
  StallTimeoutError,
  UnknownLayoutError,
  PlaywrightNotInstalledError,
  PortalDisabledError,
  NetworkError,
  IoError,
  LockHeldError,
  RateLimitedError,
  ForbiddenError,
  PortalRateLimitError,
  ConfigError,
  StateSchemaTooNewError,
  CaseCollisionDetectedError,
  EncryptedTamperDetectedError,
  PristineCorruptedError,
  ConflictsUnresolvedError,
  DeployInterruptedError,
} from "../../src/lib/errors.js";

describe("CfxError base class", () => {
  it("exposes code + message + hint", () => {
    const e = new AuthExpiredError();
    expect(e).toBeInstanceOf(CfxError);
    expect(e.code).toBe("AUTH_EXPIRED");
    expect(e.hint).toMatch(/cfx_login/);
  });

  it("serializes to { success: false, error }", () => {
    const e = new AuthMissingError();
    const shape = e.toEnvelope();
    expect(shape.success).toBe(false);
    expect(shape.error.code).toBe("AUTH_MISSING");
    expect(shape.error.hint).toBeDefined();
  });

  it("marks retryable errors as retryable", () => {
    expect(new NetworkError("timeout").retryable).toBe(true);
    expect(new AuthExpiredError().retryable).toBe(false);
  });
});

describe("All 28 error classes exist and have unique codes", () => {
  const classes = [
    AuthExpiredError, AuthMissingError, InvalidTargetError, ForbiddenEndpointError,
    MappingUnapprovedError, NotFoundError, AmbiguousSlugError, ValidationFailedError,
    MultiPackUnsupportedError, TargetParentMissingError, DiskSpaceLowError,
    StallTimeoutError, UnknownLayoutError, PlaywrightNotInstalledError,
    PortalDisabledError, NetworkError, IoError, LockHeldError, RateLimitedError,
    ForbiddenError, PortalRateLimitError, ConfigError,
    StateSchemaTooNewError, CaseCollisionDetectedError, EncryptedTamperDetectedError,
    PristineCorruptedError, ConflictsUnresolvedError, DeployInterruptedError,
  ];
  it("all instantiate without args (except dynamic-message ones)", () => {
    const codes = new Set<string>();
    for (const Cls of classes) {
      const instance = new (Cls as any)("test message");
      expect(instance.code).toBeTruthy();
      codes.add(instance.code);
    }
    expect(codes.size).toBe(classes.length);
  });
});
