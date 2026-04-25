import fs from "node:fs/promises";
import path from "node:path";

export interface ResolutionLogEntry {
  ts: string;
  grantId: number;
  author: string | null;
  assetName: string;
  action:
    | "accept"
    | "pick"
    | "override"
    | "skip"
    | "new-install"
    | "reactivate"
    | "auto-approve"
    | "remap"
    | "install-to";
  tierBefore: number | null;
  confidenceBefore: number | null;
  chosenBasename: string | null;
  overrideInput: string | null;
  category?: string | null;
}

export class ResolutionLog {
  private file: string;
  constructor(stateDir: string) {
    this.file = path.join(stateDir, "resolution-log.jsonl");
  }

  async append(entry: ResolutionLogEntry): Promise<void> {
    try {
      const line = JSON.stringify(entry) + "\n";
      await fs.appendFile(this.file, line, { mode: 0o600, flag: "a" });
    } catch (e) {
      // Best-effort: never block the mapping commit on log write failure.
      console.warn("[cfx-sync-mcp] resolution-log append failed:", (e as Error).message);
    }
  }
}
