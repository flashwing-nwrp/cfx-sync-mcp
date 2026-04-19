import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLogger, type LogFields } from "../../src/lib/logger.js";

describe("logger", () => {
  let stderr: string[];
  beforeEach(() => {
    stderr = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  it("writes structured fields from allowlist", () => {
    const log = createLogger();
    log.info({ event: "download_started", grantId: 12345, bytes: 1024 });
    expect(stderr.join("")).toContain("download_started");
    expect(stderr.join("")).toContain("12345");
    expect(stderr.join("")).toContain("1024");
  });

  it("silently drops non-allowlisted fields (no cookies leak even if passed)", () => {
    const log = createLogger();
    log.info({ event: "test", cookie: "SESSION=secret" } as unknown as LogFields);
    const line = stderr.join("");
    expect(line).not.toContain("SESSION");
    expect(line).not.toContain("secret");
  });

  it("never stringifies arbitrary objects", () => {
    const log = createLogger();
    const badObj = { headers: { "Set-Cookie": "X=Y" } };
    log.info({ event: "test", request: badObj } as unknown as LogFields);
    const line = stderr.join("");
    expect(line).not.toContain("Set-Cookie");
    expect(line).not.toContain("X=Y");
  });

  it("supports info/warn/error levels", () => {
    const log = createLogger();
    log.warn({ event: "stall", durationMs: 60000 });
    log.error({ event: "network_fail", code: "NETWORK" });
    expect(stderr.join("")).toContain("[warn]");
    expect(stderr.join("")).toContain("[error]");
  });
});
