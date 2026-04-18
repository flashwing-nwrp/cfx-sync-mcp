import fs from "node:fs/promises";
import { DiskSpaceLowError } from "../errors.js";

export async function checkDiskSpace(anyPathOnFs: string, neededBytes: number): Promise<void> {
  const stat = await fs.statfs(anyPathOnFs);
  // Use bigint to avoid precision loss on huge volumes (bavail > 2^53 / bsize)
  const freeBytesBig = BigInt(stat.bavail) * BigInt(stat.bsize);
  const neededBig = BigInt(Math.ceil(neededBytes));
  if (freeBytesBig < neededBig) {
    // For the error message, clamp to MAX_SAFE_INTEGER for display
    const freeClamped = freeBytesBig > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(freeBytesBig);
    throw new DiskSpaceLowError(neededBytes, freeClamped);
  }
}
