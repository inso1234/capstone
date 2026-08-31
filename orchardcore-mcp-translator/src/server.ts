import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { OrchardCoreClient } from "./orchardcore-client.js";
import { registerTools } from "./tools/index.js";

// Resolve .env relative to this file's own location (the repo root, one
// level up from dist/), not process.cwd() — Claude Code invokes this server
// with an absolute path from whatever project happens to be open, so a
// cwd-relative dotenv lookup would silently miss the translator's own .env.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// quiet: true is load-bearing, not cosmetic — this server talks to Claude
// Code over stdio (StdioServerTransport below), and dotenv writes an
// unsolicited "tip" line to stdout by default, which would corrupt the MCP
// JSON-RPC stream.
loadDotenv({ path: path.join(__dirname, "..", ".env"), quiet: true });

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new OrchardCoreClient(config);

  const server = new McpServer({
    name: "orchardcore-mcp-translator",
    version: "0.1.0",
  });

  registerTools(server, client, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("orchardcore-mcp-translator failed to start:", err);
  process.exit(1);
});
