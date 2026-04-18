import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { checkDiskSpace } from "../../../src/lib/deploy/preflight.js";
import { DiskSpaceLowError } from "../../../src/lib/errors.js";

describe("checkDiskSpace", () => {
  it("throws DISK_SPACE_LOW when needed > free (absurd requirement)", async () => {
    // Number.MAX_SAFE_INTEGER bytes is more than any real disk — always fails
    await expect(
      checkDiskSpace(tmpdir(), Number.MAX_SAFE_INTEGER)
    ).rejects.toBeInstanceOf(DiskSpaceLowError);
  });

  it("resolves when needed is trivially small", async () => {
    // 1 byte — any mounted filesystem will have at least this free
    await expect(checkDiskSpace(tmpdir(), 1)).resolves.toBeUndefined();
  });
});
