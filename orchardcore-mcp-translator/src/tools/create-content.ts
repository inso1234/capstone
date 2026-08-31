import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "../config.js";
import { assertContentTypeAllowed, type CreateContentInput } from "../schemas.js";
import type { OrchardCoreClient } from "../orchardcore-client.js";
import { isOrchardCoreError, OrchardCoreValidationError } from "../errors.js";

function toTextResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function toErrorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function createContent(
  input: CreateContentInput,
  client: OrchardCoreClient,
  config: AppConfig,
): Promise<CallToolResult> {
  try {
    assertContentTypeAllowed(input.contentType, config.allowedContentTypes);

    // input.properties is guaranteed to hold no "draft"/"publish" key thanks
    // to createContentInputSchema's .strict() — this is the second,
    // independent layer of defense on top of createDraftContent's hardcoded
    // ?draft=true.
    const created = await client.createDraftContent(
      input.contentType,
      input.displayText,
      input.properties,
    );

    // Never say "published" here, even though the underlying service
    // principal technically has the OrchardCore permission to do so.
    return toTextResult({
      contentItemId: created.contentItemId,
      contentType: created.contentType,
      displayText: created.displayText,
      status: "draft",
      createdUtc: created.createdUtc,
    });
  } catch (err) {
    if (err instanceof OrchardCoreValidationError) {
      return toErrorResult(
        `OrchardCore rejected this content: ${JSON.stringify(err.fieldErrors, null, 2)}`,
      );
    }
    if (isOrchardCoreError(err)) {
      return toErrorResult(err.message);
    }
    throw err;
  }
}
