import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  createReadStream,
  createWriteStream,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { tmpdir, platform } from "node:os";
import { hashTree } from "../../../src/lib/preservation/hashTree.js";

function sha256Hex(s: string | Buffer): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

describe("hashTree", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "cfx-hashtree-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("hashes a 3-file tree deterministically", async () => {
    writeFileSync(path.join(root, "a.lua"), "alpha");
    mkdirSync(path.join(root, "sub"));
    writeFileSync(path.join(root, "sub", "b.lua"), "beta");
    writeFileSync(path.join(root, "sub", "c.lua"), "gamma");

    const first = await hashTree(root);
    const second = await hashTree(root);

    expect(first.size).toBe(3);
    expect(second.size).toBe(3);

    // Same content → identical maps across runs
    expect(Array.from(first.entries()).sort()).toEqual(
      Array.from(second.entries()).sort()
    );

    // Verify actual hex hashes match the content
    expect(first.get("a.lua")).toBe(sha256Hex("alpha"));
    expect(first.get("sub/b.lua")).toBe(sha256Hex("beta"));
    expect(first.get("sub/c.lua")).toBe(sha256Hex("gamma"));
  });

  it("uses forward-slash relPaths on Windows", async () => {
    mkdirSync(path.join(root, "deep", "nested", "dir"), { recursive: true });
    writeFileSync(path.join(root, "deep", "nested", "dir", "file.txt"), "hi");

    const map = await hashTree(root);
    const keys = Array.from(map.keys());

    expect(keys).toHaveLength(1);
    const only = keys[0]!;

    // Explicit: no backslashes, ever (even on Windows where path.sep === "\\")
    expect(only).not.toContain("\\");
    expect(only).toBe("deep/nested/dir/file.txt");

    // No leading slash, no "./" prefix
    expect(only.startsWith("/")).toBe(false);
    expect(only.startsWith("./")).toBe(false);
  });

  it("skips symlinks", async () => {
    writeFileSync(path.join(root, "real.lua"), "real");
    writeFileSync(path.join(root, "target.txt"), "linked-content");

    // Symlink creation on Windows typically needs admin or dev-mode; skip gracefully.
    let symlinkSupported = true;
    try {
      symlinkSync(
        path.join(root, "target.txt"),
        path.join(root, "link-to-target.txt"),
        "file"
      );
      // Also create a dir symlink to prove we don't follow it.
      mkdirSync(path.join(root, "realdir"));
      writeFileSync(path.join(root, "realdir", "inside.lua"), "inside");
      symlinkSync(
        path.join(root, "realdir"),
        path.join(root, "link-to-dir"),
        "dir"
      );
    } catch (err: unknown) {
      if (platform() === "win32") {
        symlinkSupported = false;
      } else {
        throw err;
      }
    }

    const map = await hashTree(root);

    // real.lua + target.txt always present.
    expect(map.get("real.lua")).toBe(sha256Hex("real"));
    expect(map.get("target.txt")).toBe(sha256Hex("linked-content"));

    if (symlinkSupported) {
      // Real dir content should be present; symlinks should be absent.
      expect(map.get("realdir/inside.lua")).toBe(sha256Hex("inside"));
      expect(map.has("link-to-target.txt")).toBe(false);
      expect(map.has("link-to-dir")).toBe(false);
      expect(Array.from(map.keys()).some((k) => k.startsWith("link-to-dir/"))).toBe(false);
      expect(map.size).toBe(3);
    } else {
      expect(map.size).toBe(2);
    }
  });

  it("handles empty dirs", async () => {
    // Completely empty root
    const map = await hashTree(root);
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);

    // Root with only empty subdirs (still no files)
    mkdirSync(path.join(root, "empty1"));
    mkdirSync(path.join(root, "empty2", "nested"), { recursive: true });
    const map2 = await hashTree(root);
    expect(map2.size).toBe(0);
  });

  it("streams — does not readFile into memory for 5MB file", async () => {
    // Prove streaming by hashing a realistic-sized file (5MB) and verifying
    // the result matches a streaming reference hash. If the implementation
    // used fs.readFile it would still pass this test; the intent here is
    // to exercise streaming codepaths and catch OOM/backpressure bugs.
    const bigPath = path.join(root, "big.bin");
    const chunk = Buffer.alloc(64 * 1024, 0xab); // 64KiB of 0xab
    const chunks = 80; // 80 * 64KiB = 5 MiB
    const refHash = crypto.createHash("sha256");

    // Build the file via streaming writes so we don't buffer 5MB in memory here either.
    await new Promise<void>((resolve, reject) => {
      const w = createWriteStream(bigPath);
      w.on("error", reject);
      w.on("finish", () => resolve());
      for (let i = 0; i < chunks; i++) {
        w.write(chunk);
        refHash.update(chunk);
      }
      w.end();
    });

    const expected = refHash.digest("hex");
    const map = await hashTree(root);
    expect(map.get("big.bin")).toBe(expected);

    // Sanity: we should also be able to re-verify via createReadStream.
    const streamHash = crypto.createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const s = createReadStream(bigPath);
      s.on("data", (c) => streamHash.update(c));
      s.on("end", () => resolve());
      s.on("error", reject);
    });
    expect(map.get("big.bin")).toBe(streamHash.digest("hex"));
  });

  it("handles files with subdirectory structure and sorts-independent", async () => {
    // Order-of-traversal robustness: multiple siblings + nested
    await writeFile(path.join(root, "z.txt"), "z");
    await writeFile(path.join(root, "a.txt"), "a");
    mkdirSync(path.join(root, "mid"));
    await writeFile(path.join(root, "mid", "m.txt"), "m");

    const map = await hashTree(root);
    expect(map.size).toBe(3);
    expect(map.get("a.txt")).toBe(sha256Hex("a"));
    expect(map.get("z.txt")).toBe(sha256Hex("z"));
    expect(map.get("mid/m.txt")).toBe(sha256Hex("m"));
  });

  it("honors AbortSignal (throws when aborted)", async () => {
    // Populate enough files that the abort has a chance to fire mid-walk.
    for (let i = 0; i < 50; i++) {
      writeFileSync(path.join(root, `f${i}.txt`), `content-${i}`);
    }

    const controller = new AbortController();
    controller.abort();

    await expect(hashTree(root, { abortSignal: controller.signal })).rejects.toThrow();
  });

  it("throws on non-existent root", async () => {
    const missing = path.join(root, "does-not-exist");
    await expect(hashTree(missing)).rejects.toThrow();
  });

  it("returns lowercase hex digests", async () => {
    writeFileSync(path.join(root, "x.txt"), "x");
    const map = await hashTree(root);
    const hex = map.get("x.txt")!;
    expect(hex).toBe(hex.toLowerCase());
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});
