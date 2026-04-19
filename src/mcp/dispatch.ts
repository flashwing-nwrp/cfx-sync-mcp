import { cfx_login } from "./tools/login.js";
import { cfx_logout } from "./tools/logout.js";
import { cfx_status } from "./tools/status.js";
import { cfx_list_grants } from "./tools/list_grants.js";
import { cfx_check_updates } from "./tools/check_updates.js";
import { cfx_scan_updates } from "./tools/scan_updates.js";
import { cfx_discover } from "./tools/discover.js";
import { cfx_approve_mapping } from "./tools/approve_mapping.js";
import { cfx_download_asset } from "./tools/download_asset.js";
import { cfx_deploy_asset } from "./tools/deploy_asset.js";
import { cfx_sync_all } from "./tools/sync_all.js";
import { cfx_rollback } from "./tools/rollback.js";
import { cfx_scan_configs } from "./tools/scan_configs.js";
import { cfx_reset_pristine } from "./tools/reset_pristine.js";

// Each handler accepts its own validated input type. The dispatch boundary
// receives `unknown` from the MCP transport and passes it through — validation
// is the caller's responsibility (see server.ts). We cast once here rather
// than sprinkling `any` into every tool module.
type Handler = (args: unknown) => Promise<unknown>;

function wrap<T>(fn: (input: T) => Promise<unknown>): Handler {
  return (args) => fn(args as T);
}

const HANDLERS: Record<string, Handler> = {
  cfx_login:           wrap(cfx_login),
  cfx_logout:          wrap(cfx_logout),
  cfx_status:          wrap(cfx_status),
  cfx_list_grants:     wrap(cfx_list_grants),
  cfx_check_updates:   wrap(cfx_check_updates),
  cfx_scan_updates:    wrap(cfx_scan_updates),
  cfx_discover:        wrap(cfx_discover),
  cfx_approve_mapping: wrap(cfx_approve_mapping),
  cfx_download_asset:  wrap(cfx_download_asset),
  cfx_deploy_asset:    wrap(cfx_deploy_asset),
  cfx_sync_all:        wrap(cfx_sync_all),
  cfx_rollback:        wrap(cfx_rollback),
  cfx_scan_configs:    wrap(cfx_scan_configs),
  cfx_reset_pristine:  wrap(cfx_reset_pristine),
};

export async function dispatch(name: string, args: unknown): Promise<unknown> {
  const h = HANDLERS[name];
  if (!h) throw new Error(`Unknown tool "${name}"`);
  return h(args);
}
