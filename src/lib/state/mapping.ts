import fs from "node:fs/promises";
import path from "node:path";
import { StateSchemaTooNewError } from "../errors.js";

const MAPPING_CODE_VERSION = 4;
const MAPPING_REQUIRED_BINARY = "cfx-sync-mcp >=0.4.0";

export type PreservePathsSource = "scan-v1" | "kb-v1" | "user";
export type EntryStatus = "active" | "new-install" | "disabled";

export interface MappingEntry {
  slug: string;
  target: string;                      // "" iff status === "new-install"
  assetName: string;
  discoveredTier: number;
  discoveredConfidence: number;
  notes?: string;
  preservePaths?: string[] | null;
  preservePathsSource?: PreservePathsSource | null;
  ignoreUpstreamUpdates?: boolean;
  ignoreUpstreamUpdatesReason?: string;
  ignoreUpstreamUpdatesSetAt?: string;
  // v4 additions
  status: EntryStatus;
  reviewedByUser: boolean;
}

// Legacy v1/v2/v3 shapes retain the `disabled` field.
type LegacyEntryCommon = {
  slug: string;
  target: string;
  disabled: boolean;
  assetName: string;
  discoveredTier: number;
  discoveredConfidence: number;
  notes?: string;
};
type MappingEntryV1 = LegacyEntryCommon;
type MappingEntryV2 = LegacyEntryCommon & {
  preservePaths?: string[] | null;
  preservePathsSource?: PreservePathsSource | null;
};
type MappingEntryV3 = MappingEntryV2 & {
  ignoreUpstreamUpdates?: boolean;
  ignoreUpstreamUpdatesReason?: string;
  ignoreUpstreamUpdatesSetAt?: string;
};

export interface MappingFile {
  version: 4;
  approvedAt: string;
  entries: Record<string, MappingEntry>;
  newInstalls: number[];
  orphaned: string[];
}
interface MappingFileV3 { version: 3; approvedAt: string; entries: Record<string, MappingEntryV3>; newInstalls: number[]; orphaned: string[]; }
interface MappingFileV2 { version: 2; approvedAt: string; entries: Record<string, MappingEntryV2>; newInstalls: number[]; orphaned: string[]; }
interface MappingFileV1 { version: 1; approvedAt: string; entries: Record<string, MappingEntryV1>; newInstalls: number[]; orphaned: string[]; }

function isV1(o: unknown): o is MappingFileV1 { return (o as MappingFileV1)?.version === 1; }
function isV2(o: unknown): o is MappingFileV2 { return (o as MappingFileV2)?.version === 2; }
function isV3(o: unknown): o is MappingFileV3 { return (o as MappingFileV3)?.version === 3; }
function isV4(o: unknown): o is MappingFile   { return (o as MappingFile)?.version   === 4; }

function migrateV1ToV2(v1: MappingFileV1): MappingFileV2 {
  const entries: Record<string, MappingEntryV2> = {};
  for (const [k, v] of Object.entries(v1.entries)) {
    entries[k] = { ...v, preservePaths: null, preservePathsSource: null };
  }
  return { version: 2, approvedAt: v1.approvedAt, entries, newInstalls: v1.newInstalls, orphaned: v1.orphaned };
}

function migrateV2ToV3(v2: MappingFileV2): MappingFileV3 {
  // v2→v3 is a no-op on entries; the three ignoreUpstream* fields default undefined.
  return { version: 3, approvedAt: v2.approvedAt, entries: v2.entries as Record<string, MappingEntryV3>, newInstalls: v2.newInstalls, orphaned: v2.orphaned };
}

async function migrateV3ToV4(v3: MappingFileV3, _stateDir: string): Promise<MappingFile> {
  const entries: Record<string, MappingEntry> = {};
  for (const [k, v] of Object.entries(v3.entries)) {
    const status: EntryStatus = v.disabled === true ? "disabled" : "active";
    let reviewed = v.discoveredTier <= 2;
    if (!reviewed && v.discoveredConfidence >= 0.9) {
      try {
        await fs.stat(v.target);
        reviewed = true;
      } catch {
        // target missing → keep unreviewed
      }
    }
    // Strip legacy `disabled` from v4 shape; carry all other fields forward.
    const { disabled: _disabled, ...carry } = v;
    entries[k] = { ...carry, status, reviewedByUser: reviewed };
  }
  return { version: 4, approvedAt: v3.approvedAt, entries, newInstalls: v3.newInstalls, orphaned: v3.orphaned };
}

export class Mapping {
  private file: string;
  private stateDir: string;
  private data: MappingFile | null = null;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.file = path.join(stateDir, "cfx-sync-map.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const onDisk = (parsed as Record<string, unknown>)?.["version"];
      if (typeof onDisk === "number" && onDisk > MAPPING_CODE_VERSION) {
        throw new StateSchemaTooNewError(onDisk, MAPPING_CODE_VERSION, MAPPING_REQUIRED_BINARY);
      }
      if (isV4(parsed)) this.data = parsed;
      else if (isV3(parsed)) this.data = await migrateV3ToV4(parsed, this.stateDir);
      else if (isV2(parsed)) this.data = await migrateV3ToV4(migrateV2ToV3(parsed), this.stateDir);
      else if (isV1(parsed)) this.data = await migrateV3ToV4(migrateV2ToV3(migrateV1ToV2(parsed)), this.stateDir);
      else throw new Error(`Unknown cfx-sync-map.json version: ${String(onDisk)} (file: ${this.file})`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") { this.data = null; return; }
      throw e;
    }
  }

  isApproved(): boolean { return this.data !== null; }

  entries(): Record<string, MappingEntry> { return this.data?.entries ?? {}; }

  /**
   * Returns only entries with status === "active". Use this for any iteration
   * that reaches into `entry.target` — new-install entries have target === ""
   * and will crash downstream file-system calls.
   */
  getActiveEntries(): Record<string, MappingEntry> {
    const src = this.data?.entries ?? {};
    const out: Record<string, MappingEntry> = {};
    for (const [k, v] of Object.entries(src)) {
      if (v.status === "active") out[k] = v;
    }
    return out;
  }

  getFile(): MappingFile {
    if (this.data !== null) return this.data;
    return { version: 4, approvedAt: "1970-01-01T00:00:00.000Z", entries: {}, newInstalls: [], orphaned: [] };
  }

  get(grantId: number): MappingEntry | undefined { return this.data?.entries[String(grantId)]; }

  isDisabled(grantId: number): boolean {
    return this.data?.entries[String(grantId)]?.status === "disabled";
  }

  approveFromProposed(rawEntries: Record<string, MappingEntry>): void {
    // Strip any legacy `disabled` field that callers may pass (e.g. during migration from v3 data).
    const entries: Record<string, MappingEntry> = {};
    for (const [k, v] of Object.entries(rawEntries)) {
      const { disabled: _disabled, ...rest } = v as MappingEntry & { disabled?: boolean };
      entries[k] = rest as MappingEntry;
    }
    this.data = { version: 4, approvedAt: new Date().toISOString(), entries, newInstalls: [], orphaned: [] };
  }

  /** Replace one entry in-place. Used by wizard tools. */
  setEntry(grantId: number, entry: MappingEntry): void {
    if (!this.data) throw new Error("Cannot setEntry: mapping not approved");
    this.data.entries[String(grantId)] = entry;
  }

  async save(): Promise<void> {
    if (!this.data) throw new Error("Cannot save: mapping not approved");
    const tmp = this.file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }
}
