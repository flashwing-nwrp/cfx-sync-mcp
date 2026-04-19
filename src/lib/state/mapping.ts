import fs from "node:fs/promises";
import path from "node:path";
import { StateSchemaTooNewError } from "../errors.js";

const MAPPING_CODE_VERSION = 2;
const MAPPING_REQUIRED_BINARY = "cfx-sync-mcp >=0.2.0";

export type PreservePathsSource = "scan-v1" | "kb-v1" | "user";

export interface MappingEntry {
  slug: string;
  target: string;
  disabled: boolean;
  assetName: string;
  discoveredTier: number;
  discoveredConfidence: number;
  notes?: string;
  // v2: per-entry preservation list. Null means "not yet scanned / no rule"
  // (distinct from empty array which means "scanned, nothing to preserve").
  preservePaths?: string[] | null;
  preservePathsSource?: PreservePathsSource | null;
}

// v1 MappingEntry shape — identical minus preservePaths* fields.
type MappingEntryV1 = Omit<MappingEntry, "preservePaths" | "preservePathsSource">;

export interface MappingFile {
  version: 2;
  approvedAt: string;
  entries: Record<string /* grantId */, MappingEntry>;
  newInstalls: number[];
  orphaned: string[];
}

interface MappingFileV1 {
  version: 1;
  approvedAt: string;
  entries: Record<string, MappingEntryV1>;
  newInstalls: number[];
  orphaned: string[];
}

function isV1(obj: unknown): obj is MappingFileV1 { return obj != null && (obj as MappingFileV1).version === 1; }
function isV2(obj: unknown): obj is MappingFile { return obj != null && (obj as MappingFile).version === 2; }

function migrateV1ToV2(v1: MappingFileV1): MappingFile {
  const migratedEntries: Record<string, MappingEntry> = {};
  for (const [k, v] of Object.entries(v1.entries)) {
    migratedEntries[k] = {
      ...v,
      preservePaths: null,
      preservePathsSource: null,
    };
  }
  return {
    version: 2,
    approvedAt: v1.approvedAt,
    entries: migratedEntries,
    newInstalls: v1.newInstalls,
    orphaned: v1.orphaned,
  };
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
      const parsed: unknown = JSON.parse(raw);
      const onDiskVersion = (parsed as Record<string, unknown>)?.["version"];
      if (typeof onDiskVersion === "number" && onDiskVersion > MAPPING_CODE_VERSION) {
        throw new StateSchemaTooNewError(onDiskVersion, MAPPING_CODE_VERSION, MAPPING_REQUIRED_BINARY);
      }
      if (isV2(parsed)) this.data = parsed;
      else if (isV1(parsed)) this.data = migrateV1ToV2(parsed);
      else throw new Error(`Unknown cfx-sync-map.json version: ${String(onDiskVersion)} (file: ${this.file})`);
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

  /**
   * Replaces ALL entries wholesale. Prior `disabled` flags are lost — callers
   * are responsible for merging operator edits against a re-discovered proposal.
   * The standard flow is: discover → operator reviews+edits JSON → approve.
   */
  approveFromProposed(entries: Record<string, MappingEntry>): void {
    this.data = {
      version: 2,
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
