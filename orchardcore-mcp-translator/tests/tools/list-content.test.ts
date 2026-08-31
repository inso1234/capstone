import { describe, expect, it, vi } from "vitest";
import { OrchardCoreClient, type ContentItemSummary } from "../../src/orchardcore-client.js";
import { listContentInputSchema } from "../../src/schemas.js";
import { listContent } from "../../src/tools/list-content.js";
import { buildTestConfig } from "../setup.js";

function item(overrides: Partial<ContentItemSummary>): ContentItemSummary {
  return {
    contentItemId: "id-1",
    contentType: "BlogPost",
    displayText: "Item",
    published: true,
    latest: true,
    createdUtc: "2026-08-01T00:00:00Z",
    modifiedUtc: "2026-08-01T00:00:00Z",
    owner: "admin",
    ...overrides,
  };
}

describe("list_content tool", () => {
  it("rejects out-of-range first/skip before ever calling the client", async () => {
    const config = buildTestConfig();
    const client = new OrchardCoreClient(config, vi.fn());
    const listSpy = vi.spyOn(client, "listContentByType");
    const schema = listContentInputSchema(config.maxPageSize);

    for (const bad of [{ first: 0 }, { first: 51 }, { skip: -1 }]) {
      const parsed = schema.safeParse(bad);
      expect(parsed.success).toBe(false);
    }
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("derives the first ceiling from ORCHARDCORE_MAX_PAGE_SIZE, not a hardcoded constant", () => {
    const schema = listContentInputSchema(200);
    expect(schema.safeParse({ first: 150 }).success).toBe(true);
    expect(schema.safeParse({ first: 201 }).success).toBe(false);
  });

  it("rejects a content type outside the allow-list before calling the client", async () => {
    const config = buildTestConfig({ allowedContentTypes: ["BlogPost"] });
    const client = new OrchardCoreClient(config, vi.fn());
    const listSpy = vi.spyOn(client, "listContentByType");

    const input = listContentInputSchema(config.maxPageSize).parse({ contentType: "SecretAdminType" });
    const result = await listContent(input, client, config);

    expect(result.isError).toBe(true);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("fans out one call per allow-listed type when contentType is omitted", async () => {
    const config = buildTestConfig({ allowedContentTypes: ["BlogPost", "Page"] });
    const client = new OrchardCoreClient(config, vi.fn());
    vi.spyOn(client, "listContentByType").mockImplementation(async (type: string) => [
      item({ contentItemId: `${type}-1`, contentType: type, createdUtc: "2026-08-01T00:00:00Z" }),
    ]);

    const input = listContentInputSchema(config.maxPageSize).parse({});
    const result = await listContent(input, client, config);

    expect(client.listContentByType).toHaveBeenCalledTimes(2);
    const text = (result.content[0] as { text: string }).text;
    const payload = JSON.parse(text);
    expect(payload.count).toBe(2);
  });

  it("calls the client exactly once for a single content type", async () => {
    const config = buildTestConfig({ allowedContentTypes: ["BlogPost", "Page"] });
    const client = new OrchardCoreClient(config, vi.fn());
    vi.spyOn(client, "listContentByType").mockResolvedValue([item({})]);

    const input = listContentInputSchema(config.maxPageSize).parse({ contentType: "BlogPost" });
    const result = await listContent(input, client, config);

    expect(client.listContentByType).toHaveBeenCalledTimes(1);
    expect(client.listContentByType).toHaveBeenCalledWith(
      "BlogPost",
      expect.objectContaining({ first: 20, skip: 0, status: "PUBLISHED" }),
    );
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.items).toHaveLength(1);
  });
});
