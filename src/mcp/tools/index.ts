import type { z } from "zod";
import * as S from "../schemas/index.js";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  outputSchema: z.ZodTypeAny;
  destructive: boolean;
}

// Static const — any addition goes through code review + CI.
export const TOOLS: ToolDef[] = [
  { name: "cfx_login", description: "Authenticate to the Cfx.re portal (Playwright headed, or validate file-mode cookies).", inputSchema: S.LoginInput, outputSchema: S.LoginOutput, destructive: false },
  { name: "cfx_logout", description: "Wipe local cookie file and zero in-memory session.", inputSchema: S.LogoutInput, outputSchema: S.LogoutOutput, destructive: true },
  { name: "cfx_status", description: "Health snapshot: cookie age, mapping status, deploy counts.", inputSchema: S.StatusInput, outputSchema: S.StatusOutput, destructive: false },
  { name: "cfx_list_grants", description: "List portal grants (1h soft cache unless force:true).", inputSchema: S.ListGrantsInput, outputSchema: S.ListGrantsOutput, destructive: false },
  { name: "cfx_check_updates", description: "Diff portal grants vs local state; returns changed grants.", inputSchema: S.CheckUpdatesInput, outputSchema: S.CheckUpdatesOutput, destructive: false },
  { name: "cfx_scan_updates", description: "Scan for available resource updates by merging portal grant signal with in-game server-log notice signal. Returns 4 buckets: available (ready to update), suppressed (local-ahead/equal/ignore-upstream-updates), unknownSource (non-semver/missing), unmapped (log-only, unknown to cfx-sync-map). Pass logLines to enable notice detection; omit for portal-only scan.", inputSchema: S.ScanUpdatesInput, outputSchema: S.ScanUpdatesOutput, destructive: false },
  { name: "cfx_discover", description: "Scan local resources + portal grants, propose cfx-sync-map.json.", inputSchema: S.DiscoverInput, outputSchema: S.DiscoverOutput, destructive: false },
  { name: "cfx_approve_mapping", description: "Commit a proposed mapping to cfx-sync-map.json.", inputSchema: S.ApproveMappingInput, outputSchema: S.ApproveMappingOutput, destructive: true },
  { name: "cfx_scan_configs", description: "Layer 1 preservation scan: write advisory preservePaths into cfx-sync-map.json for one or all mapped grants.", inputSchema: S.ScanConfigsInput, outputSchema: S.ScanConfigsOutput, destructive: true },
  { name: "cfx_reset_pristine", description: "Drop pristine baseline (one grant or all); clears state pristine fields + GCs orphans. Next deploy treats as first-deploy.", inputSchema: S.ResetPristineInput, outputSchema: S.ResetPristineOutput, destructive: true },
  { name: "cfx_set_fork_mode", description: "Flag a mapping entry as a local fork (ignoreUpstreamUpdates triad). Suppresses the resource from cfx_scan_updates output regardless of portal/log signal. Pass enabled:true with an optional reason to enable; enabled:false to clear. Mutually exclusive {slug, grantId}; requires approved mapping.", inputSchema: S.SetForkModeInput, outputSchema: S.SetForkModeOutput, destructive: true },
  { name: "cfx_download_asset", description: "Stream a pack zip to cache. Does NOT deploy.", inputSchema: S.DownloadAssetInput, outputSchema: S.DownloadAssetOutput, destructive: true },
  { name: "cfx_deploy_asset", description: "Unzip + stage + swap with backup.", inputSchema: S.DeployAssetInput, outputSchema: S.DeployAssetOutput, destructive: true },
  { name: "cfx_sync_all", description: "check → download(changed) → deploy(downloaded).", inputSchema: S.SyncAllInput, outputSchema: S.SyncAllOutput, destructive: true },
  { name: "cfx_rollback", description: "Restore a previous backup.", inputSchema: S.RollbackInput, outputSchema: S.RollbackOutput, destructive: true },
];

export function toolNames(): string[] {
  return TOOLS.map((t) => t.name);
}
