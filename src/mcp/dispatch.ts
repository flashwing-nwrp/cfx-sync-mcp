// Dispatch table for MCP tool names → lib calls.
// Each handler is added by Tasks 21-24.

import { cfx_login } from "./tools/login.js";
import { cfx_logout } from "./tools/logout.js";
import { cfx_status } from "./tools/status.js";

const HANDLERS: Record<string, (args: any) => Promise<unknown>> = {
  cfx_login,
  cfx_logout,
  cfx_status,
};

export async function dispatch(name: string, args: unknown): Promise<unknown> {
  const h = HANDLERS[name];
  if (!h) throw new Error(`Handler for tool "${name}" not wired (see Tasks 22-24).`);
  return h(args as any);
}
