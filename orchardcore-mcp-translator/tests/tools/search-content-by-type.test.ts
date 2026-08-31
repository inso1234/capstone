import { describe, expect, it, vi } from "vitest";
import { OrchardCoreClient, type ContentItemSummary } from "../../src/orchardcore-client.js";
import { searchContentByTypeInputSchema } from "../../src/schemas.js";
import { searchContentByType } from "../../src/tools/search-content-by-type.js";
import { buildTestConfig } from "../setup.js";

const config = buildTestConfig();
const schema = searchContentByTypeInputSchema(config.maxPageSize);

describe("search_content_by_type tool", () => {
  it("rejects a missing or empty query before calling the client", () => {
    expect(schema.safeParse({ contentType: "BlogPost" }).success).toBe(false);
    expect(schema.safeParse({ contentType: "BlogPost", query: "" }).success).toBe(false);
  });

  it("rejects a content type outside the allow-list before calling the client", async () => {
    const scopedConfig = buildTestConfig({ allowedContentTypes: ["BlogPost"] });
    const client = new OrchardCoreClient(scopedConfig, vi.fn());
    const searchSpy = vi.spyOn(client, "searchContentByType");

    const input = schema.parse({
      contentType: "SecretAdminType",
      query: "x",
    });
    const result = await searchContentByType(input, client, scopedConfig);

    expect(result.isError).toBe(true);
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("passes the content type, query, and pagination through to the client unchanged", async () => {
    const scopedConfig = buildTestConfig({ allowedContentTypes: ["BlogPost"] });
    const client = new OrchardCoreClient(scopedConfig, vi.fn());
    const item: ContentItemSummary = {
      contentItemId: "id-1",
      contentType: "BlogPost",
      displayText: "Orchard Match",
      published: true,
      latest: true,
      createdUtc: "2026-08-01T00:00:00Z",
      modifiedUtc: "2026-08-01T00:00:00Z",
      owner: "admin",
    };
    vi.spyOn(client, "searchContentByType").mockResolvedValue([item]);

    const input = schema.parse({
      contentType: "BlogPost",
      query: "orchard",
      first: 5,
    });
    const result = await searchContentByType(input, client, scopedConfig);

    expect(client.searchContentByType).toHaveBeenCalledWith(
      "BlogPost",
      "orchard",
      expect.objectContaining({ first: 5, skip: 0, status: "PUBLISHED" }),
    );
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.items).toHaveLength(1);
    expect(payload.query).toBe("orchard");
  });
});
