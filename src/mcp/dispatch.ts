// Dispatch table for MCP tool names → lib calls.
// Each handler is added by Tasks 21-24.

import { cfx_login } from "./tools/login.js";
import { cfx_logout } from "./tools/logout.js";
import { cfx_status } from "./tools/status.js";
import { cfx_list_grants } from "./tools/list_grants.js";
import { cfx_check_updates } from "./tools/check_updates.js";

const HANDLERS: Record<string, (args: any) => Promise<unknown>> = {
  cfx_login,
  cfx_logout,
  cfx_status,
  cfx_list_grants,
  cfx_check_updates,
};

export async function dispatch(name: string, args: unknown): Promise<unknown> {
  const h = HANDLERS[name];
  if (!h) throw new Error(`Handler for tool "${name}" not wired (see Tasks 23-24).`);
  return h(args as any);
}
