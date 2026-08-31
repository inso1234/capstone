import { describe, expect, it, vi } from "vitest";
import { OrchardCoreClient } from "../../src/orchardcore-client.js";
import { createContentInputSchema } from "../../src/schemas.js";
import { createContent } from "../../src/tools/create-content.js";
import { OrchardCoreValidationError } from "../../src/errors.js";
import { buildTestConfig } from "../setup.js";

describe("create_content tool", () => {
  it("rejects an input containing a draft or publish key via .strict()", () => {
    expect(
      createContentInputSchema.safeParse({ contentType: "BlogPost", draft: false }).success,
    ).toBe(false);
    expect(
      createContentInputSchema.safeParse({ contentType: "BlogPost", publish: true }).success,
    ).toBe(false);
  });

  it("rejects a content type outside the allow-list before calling the client", async () => {
    const config = buildTestConfig({ allowedContentTypes: ["BlogPost"] });
    const client = new OrchardCoreClient(config, vi.fn());
    const createSpy = vi.spyOn(client, "createDraftContent");

    const input = createContentInputSchema.parse({ contentType: "SecretAdminType" });
    const result = await createContent(input, client, config);

    expect(result.isError).toBe(true);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("returns status: 'draft' and never the word 'published' on success", async () => {
    const config = buildTestConfig({ allowedContentTypes: ["BlogPost"] });
    const client = new OrchardCoreClient(config, vi.fn());
    vi.spyOn(client, "createDraftContent").mockResolvedValue({
      contentItemId: "new-1",
      contentType: "BlogPost",
      displayText: "My Draft",
      createdUtc: "2026-08-31T00:00:00Z",
    });

    const input = createContentInputSchema.parse({
      contentType: "BlogPost",
      displayText: "My Draft",
    });
    const result = await createContent(input, client, config);

    const text = (result.content[0] as { text: string }).text;
    const payload = JSON.parse(text);
    expect(payload.status).toBe("draft");
    expect(text.toLowerCase()).not.toContain("published");
  });

  it("surfaces OrchardCoreValidationError as an MCP error result with field messages intact", async () => {
    const config = buildTestConfig({ allowedContentTypes: ["BlogPost"] });
    const client = new OrchardCoreClient(config, vi.fn());
    vi.spyOn(client, "createDraftContent").mockRejectedValue(
      new OrchardCoreValidationError("invalid", { DisplayText: ["The DisplayText field is required."] }),
    );

    const input = createContentInputSchema.parse({ contentType: "BlogPost" });
    const result = await createContent(input, client, config);

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("DisplayText field is required");
  });
});
