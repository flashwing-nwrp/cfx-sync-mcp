import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./tools/index.js";
import { CfxError, PreservationError } from "../lib/errors.js";
import { dispatch } from "./dispatch.js";

export async function runMcpServer() {
  const server = new Server(
    { name: "cfx-sync-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: `Unknown tool: ${req.params.name}` } }) }],
        isError: true,
      };
    }
    try {
      const args = tool.inputSchema.parse(req.params.arguments ?? {});
      const result = await dispatch(tool.name, args);
      tool.outputSchema.parse(result);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data: result }) }] };
    } catch (e) {
      const env = (e instanceof CfxError || e instanceof PreservationError)
        ? e.toEnvelope()
        : { success: false as const, error: { code: "IO", message: e instanceof Error ? e.message : String(e) } };
      return {
        content: [{ type: "text", text: JSON.stringify(env) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function zodToJsonSchema(_: unknown): unknown {
  // Minimal schema. MCP clients typically accept any object — the zod parse
  // at tool-call time is what actually enforces input validation.
  return { type: "object" };
}
