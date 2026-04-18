import fs from "node:fs/promises";
import { DiskSpaceLowError } from "../errors.js";

export async function checkDiskSpace(anyPathOnFs: string, neededBytes: number): Promise<void> {
  const stat = await fs.statfs(anyPathOnFs);
  const freeBytes = Number(stat.bavail) * Number(stat.bsize);
  if (freeBytes < neededBytes) throw new DiskSpaceLowError(neededBytes, freeBytes);
}
