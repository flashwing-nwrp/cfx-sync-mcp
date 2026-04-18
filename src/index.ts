#!/usr/bin/env node
import { runMcpServer } from "./mcp/server.js";

runMcpServer().catch((e) => {
  console.error("[cfx-sync-mcp] fatal:", e);
  process.exit(1);
});
