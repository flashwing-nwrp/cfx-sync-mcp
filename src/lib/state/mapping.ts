import fs from "node:fs/promises";
import path from "node:path";
import { StateSchemaTooNewError } from "../errors.js";

const MAPPING_CODE_VERSION = 3;
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
  // v3: fork-mode flag triad. Undefined means "not set" (operator has not opted in).
  ignoreUpstreamUpdates?: boolean;
  ignoreUpstreamUpdatesReason?: string;
  ignoreUpstreamUpdatesSetAt?: string;  // ISO timestamp
}

// v1 MappingEntry shape — identical minus preservePaths* fields.
type MappingEntryV1 = Omit<MappingEntry, "preservePaths" | "preservePathsSource" | "ignoreUpstreamUpdates" | "ignoreUpstreamUpdatesReason" | "ignoreUpstreamUpdatesSetAt">;

// v2 MappingEntry shape — identical minus ignoreUpstreamUpdates* fields.
type MappingEntryV2 = Omit<MappingEntry, "ignoreUpstreamUpdates" | "ignoreUpstreamUpdatesReason" | "ignoreUpstreamUpdatesSetAt"> & {
  preservePaths?: string[] | null;
  preservePathsSource?: PreservePathsSource | null;
};

export interface MappingFile {
  version: 3;
  approvedAt: string;
  entries: Record<string /* grantId */, MappingEntry>;
  newInstalls: number[];
  orphaned: string[];
}

interface MappingFileV2 {
  version: 2;
  approvedAt: string;
  entries: Record<string, MappingEntryV2>;
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
function isV2(obj: unknown): obj is MappingFileV2 { return obj != null && (obj as MappingFileV2).version === 2; }
function isV3(obj: unknown): obj is MappingFile { return obj != null && (obj as MappingFile).version === 3; }

function migrateV1ToV2(v1: MappingFileV1): MappingFileV2 {
  const migratedEntries: Record<string, MappingEntryV2> = {};
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

// v2 → v3 is a no-op migration: the three ignoreUpstreamUpdates* fields default undefined (absent).
function migrateV2ToV3(v2: MappingFileV2): MappingFile {
  return {
    version: 3,
    approvedAt: v2.approvedAt,
    entries: v2.entries as Record<string, MappingEntry>,
    newInstalls: v2.newInstalls,
    orphaned: v2.orphaned,
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
      if (isV3(parsed)) this.data = parsed;
      else if (isV2(parsed)) this.data = migrateV2ToV3(parsed);
      else if (isV1(parsed)) this.data = migrateV2ToV3(migrateV1ToV2(parsed));
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

  /**
   * Return the full MappingFile object. Callers that need to pass the
   * mapping into pure functions (e.g. scanner.scanUpdates in Phase 1.6) use
   * this to get a typed MappingFile without reaching into `this.data`.
   *
   * When the file is not present on disk yet, returns a synthesized empty
   * v3 MappingFile (unapproved-shaped but still typed) so the scanner can
   * run with zero entries.
   */
  getFile(): MappingFile {
    if (this.data !== null) return this.data;
    return {
      version: 3,
      approvedAt: "1970-01-01T00:00:00.000Z",
      entries: {},
      newInstalls: [],
      orphaned: [],
    };
  }

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
      version: 3,
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
