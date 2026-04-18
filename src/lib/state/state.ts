import fs from "node:fs/promises";
import path from "node:path";

export interface AssetState {
  grantId: number;
  assetId: number;
  slug: string;          // cached display-slug; grantId is identity
  assetName: string;     // human-readable name from portal (for stale-cache display)
  versionId: number;
  packId: number;
  updatedAt: string;     // ISO from portal at last deploy
  sha256: string;
  cachedZipPath: string;
  deployedPath: string;
  deployedAt: string;
  backups: string[];     // ISO timestamps, newest first
}

interface StateFileV2 {
  version: 2;
  rateLimit: Record<string, { lastPolledAt: string }>;
  assets: Record<string, AssetState>;
}

// v1 AssetState didn't have assetName; use a relaxed shape so migration can read it.
type AssetStateV1 = Omit<AssetState, "assetName"> & { assetName?: string };
interface StateFileV1 {
  version: 1;
  lastPolledAt: string | null;
  assets: Record<string, AssetStateV1>;
}

function isV1(obj: unknown): obj is StateFileV1 { return obj != null && (obj as StateFileV1).version === 1; }
function isV2(obj: unknown): obj is StateFileV2 { return obj != null && (obj as StateFileV2).version === 2; }

function migrateV1ToV2(v1: StateFileV1): StateFileV2 {
  // Backfill assetName on pre-existing AssetState entries (v1 didn't have
  // this field). The slug is a reasonable human-readable placeholder until
  // the next portal poll refreshes both slug + assetName together.
  const migratedAssets: Record<string, AssetState> = {};
  for (const [k, v] of Object.entries(v1.assets)) {
    migratedAssets[k] = { ...v, assetName: v.assetName ?? v.slug };
  }
  const out: StateFileV2 = { version: 2, rateLimit: {}, assets: migratedAssets };
  if (v1.lastPolledAt) out.rateLimit["local"] = { lastPolledAt: v1.lastPolledAt };
  return out;
}

export class State {
  private file: string;
  private data: StateFileV2 = { version: 2, rateLimit: {}, assets: {} };

  constructor(stateDir: string) {
    this.file = path.join(stateDir, "state.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (isV2(parsed)) this.data = parsed;
      else if (isV1(parsed)) this.data = migrateV1ToV2(parsed);
      else throw new Error(`Unknown state.json version: ${(parsed as Record<string, unknown>)?.["version"]} (file: ${this.file})`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw e;
    }
    // Belt-and-suspenders: clean up any orphaned .tmp from a prior crashed save.
    await fs.unlink(this.file + ".tmp").catch(() => { /* ignore */ });
  }

  async save(): Promise<void> {
    const tmp = this.file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  get(grantId: number): AssetState | undefined {
    return this.data.assets[String(grantId)];
  }

  upsert(a: AssetState): void {
    this.data.assets[String(a.grantId)] = a;
  }

  remove(grantId: number): void {
    delete this.data.assets[String(grantId)];
  }

  all(): AssetState[] {
    return Object.values(this.data.assets);
  }

  lastPolledAt(callerId: string): string | null {
    return this.data.rateLimit[callerId]?.lastPolledAt ?? null;
  }

  setLastPolledAt(callerId: string, iso: string): void {
    this.data.rateLimit[callerId] = { lastPolledAt: iso };
  }
}
