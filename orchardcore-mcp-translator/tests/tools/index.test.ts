import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OrchardCoreClient } from "../../src/orchardcore-client.js";
import { registerTools } from "../../src/tools/index.js";
import { buildTestConfig } from "../setup.js";

describe("registerTools", () => {
  it("registers exactly the 3 sanctioned tools, by name", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const config = buildTestConfig();
    const client = new OrchardCoreClient(config, vi.fn());

    registerTools(server, client, config);

    const registeredNames = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    ).sort();

    expect(registeredNames).toEqual(["create_content", "list_content", "search_content_by_type"]);
  });
});
