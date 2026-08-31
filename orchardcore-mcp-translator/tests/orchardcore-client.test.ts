import { afterEach, describe, expect, it, vi } from "vitest";
import { OrchardCoreClient } from "../src/orchardcore-client.js";
import {
  OrchardCoreAuthError,
  OrchardCoreGraphQLError,
  OrchardCoreNetworkError,
  OrchardCoreValidationError,
} from "../src/errors.js";
import { buildTestConfig, jsonResponse, loadFixture, sentJsonBody, sentUrl } from "./setup.js";

const tokenResponse = loadFixture("token-response.json");
const graphqlListResponse = loadFixture("graphql-list-response.json");
const graphqlPermissionErrorResponse = loadFixture("graphql-permission-error-response.json");
const createSuccessResponse = loadFixture("create-content-success-response.json");
const createValidationErrorResponse = loadFixture("create-content-validation-error-response.json");

function isTokenRequest(url: string): boolean {
  return url.includes("/connect/token");
}

describe("OrchardCoreClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("caches the access token across multiple calls within its TTL", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (isTokenRequest(url)) return jsonResponse(200, tokenResponse);
      return jsonResponse(200, graphqlListResponse);
    });
    const client = new OrchardCoreClient(buildTestConfig(), fetchMock);

    await client.listContentByType("BlogPost");
    await client.listContentByType("BlogPost");

    const tokenCalls = fetchMock.mock.calls.filter((c) => isTokenRequest(c[0] as string));
    expect(tokenCalls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 token + 2 graphql
  });

  it("refreshes the token after it expires", async () => {
    vi.useFakeTimers();
    const shortLivedToken = { ...tokenResponse, expires_in: 60 };
    const fetchMock = vi.fn(async (url: string) => {
      if (isTokenRequest(url)) return jsonResponse(200, shortLivedToken);
      return jsonResponse(200, graphqlListResponse);
    });
    const client = new OrchardCoreClient(buildTestConfig(), fetchMock);

    await client.listContentByType("BlogPost");
    vi.advanceTimersByTime(61_000);
    await client.listContentByType("BlogPost");

    const tokenCalls = fetchMock.mock.calls.filter((c) => isTokenRequest(c[0] as string));
    expect(tokenCalls).toHaveLength(2);
  });

  it("single-flights concurrent token acquisition on a cold cache", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (isTokenRequest(url)) return jsonResponse(200, tokenResponse);
      return jsonResponse(200, graphqlListResponse);
    });
    const client = new OrchardCoreClient(buildTestConfig(), fetchMock);

    await Promise.all([
      client.listContentByType("BlogPost"),
      client.listContentByType("Page"),
      client.listContentByType("BlogPost"),
    ]);

    const tokenCalls = fetchMock.mock.calls.filter((c) => isTokenRequest(c[0] as string));
    expect(tokenCalls).toHaveLength(1);
  });

  it("throws OrchardCoreAuthError on token failure without leaking the secret", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(400, { error: "invalid_client" }));
    const config = buildTestConfig({ clientSecret: "super-secret-value" });
    const client = new OrchardCoreClient(config, fetchMock);

    await expect(client.listContentByType("BlogPost")).rejects.toBeInstanceOf(OrchardCoreAuthError);
    try {
      await client.listContentByType("BlogPost");
    } catch (err) {
      expect(String((err as Error).message)).not.toContain("super-secret-value");
    }
  });

  it("builds the expected GraphQL query for listContentByType with no filter", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (isTokenRequest(url)) return jsonResponse(200, tokenResponse);
      return jsonResponse(200, graphqlListResponse);
    });
    const client = new OrchardCoreClient(buildTestConfig(), fetchMock);

    await client.listContentByType("BlogPost", { first: 10, skip: 0, status: "PUBLISHED" });

    const body = sentJsonBody(fetchMock, 1) as { query: string; variables: Record<string, unknown> };
    expect(body.query).toContain("blogPost(");
    expect(body.query).not.toContain("displayText_contains");
    expect(body.variables).toEqual({ first: 10, skip: 0, status: "PUBLISHED" });
  });

  it("uses OrchardCore's actual GraphQL enum type name (Status) for the status variable", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (isTokenRequest(url)) return jsonResponse(200, tokenResponse);
      return jsonResponse(200, graphqlListResponse);
    });
    const client = new OrchardCoreClient(buildTestConfig(), fetchMock);

    await client.listContentByType("BlogPost");

    const body = sentJsonBody(fetchMock, 1) as { query: string };
    // OrchardCore's PublicationStatusGraphType declares Name = "Status" —
    // any other type name here fails GraphQL schema validation with an
    // HTTP 400 that a mocked-fetch test can't catch, since the mock never
    // validates the query against a real schema.
    expect(body.query).toContain("$status: Status");
    expect(body.query).not.toContain("PublicationStatusEnum");
  });

  it("never declares an unused $q variable when there is no search filter", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (isTokenRequest(url)) return jsonResponse(200, tokenResponse);
      return jsonResponse(200, graphqlListResponse);
    });
    const client = new OrchardCoreClient(buildTestConfig(), fetchMock);

    await client.listContentByType("BlogPost");

    const body = sentJsonBody(fetchMock, 1) as { query: string };
    // GraphQL's NO_UNUSED_VARIABLES validation rejects a variable declared
    // in the operation signature but never referenced in the query body —
    // $q must only appear here when a where-clause filter actually uses it.
    expect(body.query).not.toContain("$q");
  });

  it("builds the expected GraphQL query for searchContentByType with a filter", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (isTokenRequest(url)) return jsonResponse(200, tokenResponse);
      return jsonResponse(200, loadFixture("graphql-search-response.json"));
    });
    const client = new OrchardCoreClient(buildTestConfig(), fetchMock);

    await client.searchContentByType("BlogPost", "orchard");

    const body = sentJsonBody(fetchMock, 1) as { query: string; variables: Record<string, unknown> };
    expect(body.query).toContain("displayText_contains");
    expect(body.variables.q).toBe("orchard");
  });

  it("rejects an empty search query before making any network call", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, tokenResponse));
    const client = new OrchardCoreClient(buildTestConfig(), fetchMock);

    await expect(client.searchContentByType("BlogPost", "   ")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws OrchardCoreGraphQLError on an HTTP 200 response carrying an errors array", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (isTokenRequest(url)) return jsonResponse(200, tokenResponse);
      return jsonResponse(200, graphqlPermissionErrorResponse);
    });
    const client = new OrchardCoreClient(buildTestConfig(), fetchMock);

    await expect(client.listContentByType("BlogPost")).rejects.toBeInstanceOf(OrchardCoreGraphQLError);
  });

  it("clamps first/skip to the configured bounds before sending them", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (isTokenRequest(url)) return jsonResponse(200, tokenResponse);
      return jsonResponse(200, graphqlListResponse);
    });
    const client = new OrchardCoreClient(buildTestConfig({ maxPageSize: 50 }), fetchMock);

    await client.listContentByType("BlogPost", { first: 9999, skip: -5, status: "ALL" });

    const body = sentJsonBody(fetchMock, 1) as { variables: Record<string, unknown> };
    expect(body.variables.first).toBe(50);
    expect(body.variables.skip).toBe(0);
  });

  it("always issues the create request with a literal ?draft=true query string", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (isTokenRequest(url)) return jsonResponse(200, tokenResponse);
      return jsonResponse(200, createSuccessResponse);
    });
    const client = new OrchardCoreClient(buildTestConfig(), fetchMock);

    // Even if a caller tried to sneak a "draft: false" property through,
    // it only affects the JSON body, never the hardcoded query string.
    await client.createDraftContent("BlogPost", "Title", { draft: false, publish: true });

    const url = sentUrl(fetchMock, 1);
    expect(url).toContain("?draft=true");
    expect(url).not.toMatch(/draft=false/);
  });

  it("sends ContentType/DisplayText in the exact PascalCase OrchardCore's ContentItemConverter requires", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (isTokenRequest(url)) return jsonResponse(200, tokenResponse);
      return jsonResponse(200, createSuccessResponse);
    });
    const client = new OrchardCoreClient(buildTestConfig(), fetchMock);

    await client.createDraftContent("BlogPost", "My Title", undefined);

    const body = sentJsonBody(fetchMock, 1) as Record<string, unknown>;
    expect(body.ContentType).toBe("BlogPost");
    expect(body.DisplayText).toBe("My Title");
    // camelCase keys must never appear — OrchardCore's converter silently
    // drops them, which is what caused the original bug this guards against.
    expect(body.contentType).toBeUndefined();
    expect(body.displayText).toBeUndefined();
  });

  it("never lets properties override ContentType, ContentItemId, or other reserved body fields, in either casing", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (isTokenRequest(url)) return jsonResponse(200, tokenResponse);
      return jsonResponse(200, createSuccessResponse);
    });
    const client = new OrchardCoreClient(buildTestConfig(), fetchMock);

    await client.createDraftContent("BlogPost", "My Title", {
      ContentType: "SecretAdminType",
      ContentItemId: "some-existing-item-id",
      DisplayText: "Smuggled Title",
      Published: true,
      contentType: "AlsoSecretAdminType",
      contentItemId: "another-existing-item-id",
      displayText: "Also Smuggled Title",
      publish: true,
      TitlePart: { Title: "My Title" },
    });

    const body = sentJsonBody(fetchMock, 1) as Record<string, unknown>;
    expect(body.ContentType).toBe("BlogPost");
    expect(body.DisplayText).toBe("My Title");
    expect(body.ContentItemId).toBeUndefined();
    expect(body.Published).toBeUndefined();
    expect(body.contentType).toBeUndefined();
    expect(body.contentItemId).toBeUndefined();
    expect(body.displayText).toBeUndefined();
    expect(body.publish).toBeUndefined();
    expect(body.TitlePart).toEqual({ Title: "My Title" });
  });

  it("throws OrchardCoreValidationError on a 400 with OrchardCore's field errors intact", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (isTokenRequest(url)) return jsonResponse(200, tokenResponse);
      return jsonResponse(400, createValidationErrorResponse);
    });
    const client = new OrchardCoreClient(buildTestConfig(), fetchMock);

    try {
      await client.createDraftContent("BlogPost", undefined, {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OrchardCoreValidationError);
      expect((err as OrchardCoreValidationError).fieldErrors).toEqual(
        createValidationErrorResponse.errors,
      );
    }
  });

  it("throws OrchardCoreNetworkError on a network/timeout failure", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    });
    const client = new OrchardCoreClient(buildTestConfig(), fetchMock);

    await expect(client.listContentByType("BlogPost")).rejects.toBeInstanceOf(OrchardCoreNetworkError);
  });
});
