/**
 * In-flight deploy marker — persists a breadcrumb on disk BEFORE the live→backup
 * rename and DELETES it AFTER the staging→live rename succeeds. If the process
 * is killed between those two renames, the marker survives and the next deploy
 * entry detects the torn state and throws DeployInterruptedError instead of
 * silently running as a fresh first-deploy (which would orphan the pre-crash
 * backup and give the operator no visibility).
 *
 * The marker lives under `<stateDir>/in-flight/<grantId>.json`. Writes are
 * atomic via tmp+rename; reads are ENOENT-tolerant (no marker → not in flight).
 * cfx_rollback clears the marker on successful rollback because the pre-crash
 * state has been restored — no longer in flight.
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface InFlightMarker {
  grantId: number;
  stagingPath: string;
  /** Null when this is a first-deploy (no prior live to back up). */
  backupPath: string | null;
  startedAt: string; // ISO
}

function markerDir(stateDir: string): string {
  return path.join(stateDir, "in-flight");
}

export function markerPath(stateDir: string, grantId: number): string {
  return path.join(markerDir(stateDir), `${grantId}.json`);
}

/**
 * Write the marker atomically (tmp+rename) so an interrupted write never
 * produces a half-written JSON payload.
 */
export async function writeInFlightMarker(
  stateDir: string,
  marker: InFlightMarker
): Promise<string> {
  const dir = markerDir(stateDir);
  await fs.mkdir(dir, { recursive: true });
  const dst = markerPath(stateDir, marker.grantId);
  const tmp = `${dst}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(marker, null, 2), { mode: 0o600 });
  await fs.rename(tmp, dst);
  return dst;
}

/**
 * Read the marker if it exists. Returns null on ENOENT or on malformed JSON —
 * a corrupt marker is still evidence of an interrupted deploy, but without
 * parseable paths it can't help recovery. Callers treating null as "no marker"
 * lose diagnostic info; treating malformed as "unrecoverable" blocks the
 * retry loop. We pick null-on-corrupt to keep the happy path unblocked, and
 * log to stderr so the operator sees the corruption.
 */
export async function readInFlightMarker(
  stateDir: string,
  grantId: number
): Promise<InFlightMarker | null> {
  const file = markerPath(stateDir, grantId);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<InFlightMarker>;
    if (
      typeof parsed.grantId !== "number" ||
      typeof parsed.stagingPath !== "string" ||
      (parsed.backupPath !== null && typeof parsed.backupPath !== "string") ||
      typeof parsed.startedAt !== "string"
    ) {
      process.stderr.write(`[cfx-sync][warn] Malformed in-flight marker at ${file}; ignoring.\n`);
      return null;
    }
    return {
      grantId: parsed.grantId,
      stagingPath: parsed.stagingPath,
      backupPath: parsed.backupPath ?? null,
      startedAt: parsed.startedAt,
    };
  } catch {
    process.stderr.write(`[cfx-sync][warn] Unparseable in-flight marker at ${file}; ignoring.\n`);
    return null;
  }
}

/**
 * Delete the marker. ENOENT-tolerant — if it's already gone, we treat that as
 * success (the caller wanted the marker cleared, and it is).
 */
export async function clearInFlightMarker(
  stateDir: string,
  grantId: number
): Promise<void> {
  const file = markerPath(stateDir, grantId);
  try {
    await fs.unlink(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
