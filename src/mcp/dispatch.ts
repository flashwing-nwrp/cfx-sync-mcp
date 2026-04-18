// Dispatch table for MCP tool names → lib calls.
// Each handler is added by Tasks 21-24.

export async function dispatch(name: string, _args: unknown): Promise<unknown> {
  throw new Error(`Handler for tool "${name}" not yet wired. See Tasks 21-24.`);
}
