import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.js";
import { assertContentTypeAllowed, type ListContentInput } from "../schemas.js";
import type { ContentItemSummary, OrchardCoreClient } from "../orchardcore-client.js";
import { isOrchardCoreError } from "../errors.js";

function toTextResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function toErrorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function listContent(
  input: ListContentInput,
  client: OrchardCoreClient,
  config: AppConfig,
): Promise<CallToolResult> {
  try {
    const options = { first: input.first, skip: input.skip, status: input.status };

    let items: ContentItemSummary[];
    if (input.contentType) {
      assertContentTypeAllowed(input.contentType, config.allowedContentTypes);
      items = await client.listContentByType(input.contentType, options);
    } else {
      // No type given: fan out one bounded call per allow-listed type in
      // parallel (the allow-list is finite and translator-controlled, not a
      // caller-driven amplification vector), then merge and trim.
      const perTypeResults = await Promise.all(
        config.allowedContentTypes.map((type) =>
          client.listContentByType(type, { ...options, first: input.first }),
        ),
      );
      items = perTypeResults
        .flat()
        .sort((a, b) => (b.createdUtc ?? "").localeCompare(a.createdUtc ?? ""))
        .slice(0, input.first);
    }

    return toTextResult({
      count: items.length,
      status: input.status,
      first: input.first,
      skip: input.skip,
      items,
    });
  } catch (err) {
    if (isOrchardCoreError(err)) {
      return toErrorResult(err.message);
    }
    throw err;
  }
}
