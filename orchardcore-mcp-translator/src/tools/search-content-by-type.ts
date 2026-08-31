import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.js";
import { assertContentTypeAllowed, type SearchContentByTypeInput } from "../schemas.js";
import type { OrchardCoreClient } from "../orchardcore-client.js";
import { isOrchardCoreError } from "../errors.js";

function toTextResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function toErrorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function searchContentByType(
  input: SearchContentByTypeInput,
  client: OrchardCoreClient,
  config: AppConfig,
): Promise<CallToolResult> {
  try {
    assertContentTypeAllowed(input.contentType, config.allowedContentTypes);

    const items = await client.searchContentByType(input.contentType, input.query, {
      first: input.first,
      skip: input.skip,
      status: input.status,
    });

    return toTextResult({
      count: items.length,
      contentType: input.contentType,
      query: input.query,
      status: input.status,
      items,
    });
  } catch (err) {
    if (isOrchardCoreError(err)) {
      return toErrorResult(err.message);
    }
    throw err;
  }
}
