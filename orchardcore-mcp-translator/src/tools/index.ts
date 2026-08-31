import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config.js";
import type { OrchardCoreClient } from "../orchardcore-client.js";
import {
  createContentInputSchema,
  listContentInputSchema,
  searchContentByTypeInputSchema,
} from "../schemas.js";
import { listContent } from "./list-content.js";
import { searchContentByType } from "./search-content-by-type.js";
import { createContent } from "./create-content.js";

// This file registers exactly 3 tools by design: list_content, create_content,
// search_content_by_type. Do not add a 4th tool, and do not widen any of the
// three (e.g. an edit/publish/delete action) without an explicit decision to
// change this project's scope — see the security/style notes in REVIEW.md and
// the top-level README. tests/tools/index.test.ts pins the registered tool
// names so this boundary fails loudly, not silently, if it's ever crossed.
export function registerTools(server: McpServer, client: OrchardCoreClient, config: AppConfig): void {
  server.registerTool(
    "list_content",
    {
      title: "List OrchardCore content",
      description:
        `Read-only. Lists content items from the running OrchardCore instance. ` +
        `If "contentType" is omitted, lists across every allow-listed content type ` +
        `(${config.allowedContentTypes.join(", ")}). Cannot create, edit, publish, or delete anything.`,
      inputSchema: listContentInputSchema(config.maxPageSize),
    },
    (input) => listContent(input, client, config),
  );

  server.registerTool(
    "search_content_by_type",
    {
      title: "Search OrchardCore content by type",
      description:
        `Read-only. Searches a single content type (must be one of: ` +
        `${config.allowedContentTypes.join(", ")}) for items whose display text contains ` +
        `the given search term. Cannot create, edit, publish, or delete anything.`,
      inputSchema: searchContentByTypeInputSchema(config.maxPageSize),
    },
    (input) => searchContentByType(input, client, config),
  );

  server.registerTool(
    "create_content",
    {
      title: "Create OrchardCore content (draft only)",
      description:
        `Creates a new content item of an allow-listed type ` +
        `(${config.allowedContentTypes.join(", ")}) as an unpublished draft. ` +
        `Always creates a draft; never publishes, regardless of any hint in the request. ` +
        `Cannot edit or delete existing content, and cannot publish.`,
      inputSchema: createContentInputSchema,
    },
    (input) => createContent(input, client, config),
  );
}
