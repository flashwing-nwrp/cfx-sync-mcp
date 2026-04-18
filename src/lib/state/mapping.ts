import fs from "node:fs/promises";
import path from "node:path";

export interface MappingEntry {
  slug: string;
  target: string;
  disabled: boolean;
  assetName: string;
  discoveredTier: number;
  discoveredConfidence: number;
  notes?: string;
}

export interface MappingFile {
  version: 1;
  approvedAt: string;
  entries: Record<string /* grantId */, MappingEntry>;
  newInstalls: number[];
  orphaned: string[];
}

export class Mapping {
  private file: string;
  private data: MappingFile | null = null;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, "cfx-sync-map.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      this.data = JSON.parse(raw) as MappingFile;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.data = null;
        return;
      }
      throw e;
    }
  }

  isApproved(): boolean { return this.data !== null; }

  entries(): Record<string, MappingEntry> { return this.data?.entries ?? {}; }

  get(grantId: number): MappingEntry | undefined { return this.data?.entries[String(grantId)]; }

  isDisabled(grantId: number): boolean {
    return this.data?.entries[String(grantId)]?.disabled === true;
  }

  approveFromProposed(entries: Record<string, MappingEntry>): void {
    this.data = {
      version: 1,
      approvedAt: new Date().toISOString(),
      entries,
      newInstalls: [],
      orphaned: [],
    };
  }

  async save(): Promise<void> {
    if (!this.data) throw new Error("Cannot save: mapping not approved");
    const tmp = this.file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }
}
