import type { AppConfig } from "./config.js";
import {
  InvalidInputError,
  OrchardCoreAuthError,
  OrchardCoreForbiddenError,
  OrchardCoreGraphQLError,
  OrchardCoreHttpError,
  OrchardCoreNetworkError,
  OrchardCoreValidationError,
} from "./errors.js";

// Top-level ContentItem fields a caller must never be able to set via the
// free-form `properties` bag passed to createDraftContent — see the comment
// there for why each one matters. OrchardCore's ContentItemConverter (see
// ContentItemConverter.cs) does a case-sensitive switch on exact PascalCase
// property names for these — a lowercase "contentType" is silently ignored
// by that converter (falls through to being treated as arbitrary part data),
// while "ContentType" is the one that actually lands on ContentItem.ContentType.
// Both casings are blocked here: the PascalCase ones because they're the
// real attack surface, the lowercase/camelCase ones as defense-in-depth in
// case OrchardCore's serializer settings ever change.
const RESERVED_CONTENT_FIELDS = [
  "ContentType",
  "ContentItemId",
  "ContentItemVersionId",
  "DisplayText",
  "Latest",
  "Published",
  "Owner",
  "Author",
  "CreatedUtc",
  "ModifiedUtc",
  "PublishedUtc",
  "contentType",
  "contentItemId",
  "contentItemVersionId",
  "displayText",
  "draft",
  "publish",
  "published",
  "latest",
  "owner",
  "author",
  "createdUtc",
  "modifiedUtc",
  "publishedUtc",
] as const;

export type PublicationStatus = "PUBLISHED" | "DRAFT" | "LATEST" | "ALL";

export interface ContentItemSummary {
  contentItemId: string;
  contentType: string;
  displayText: string;
  published: boolean;
  latest: boolean;
  createdUtc: string | null;
  modifiedUtc: string | null;
  owner: string | null;
}

interface QueryOptions {
  first: number;
  skip: number;
  status: PublicationStatus;
}

export interface CreatedContentItem {
  contentItemId: string;
  contentType: string;
  displayText: string;
  createdUtc: string | null;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtEpochMs: number;
}

interface GraphQLResponseBody {
  data?: Record<string, unknown>;
  errors?: { message: string }[];
}

const TOKEN_REFRESH_SKEW_MS = 30_000;

function toCamelCase(contentType: string): string {
  return contentType.length === 0
    ? contentType
    : contentType[0]!.toLowerCase() + contentType.slice(1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

type FetchImpl = typeof fetch;

export class OrchardCoreClient {
  private readonly config: AppConfig;
  private readonly fetchImpl: FetchImpl;
  private cachedToken: CachedToken | null = null;
  private inFlightTokenRequest: Promise<CachedToken> | null = null;

  constructor(config: AppConfig, fetchImpl: FetchImpl = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (err) {
      throw new OrchardCoreNetworkError(
        `Network error calling OrchardCore at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtEpochMs - now > TOKEN_REFRESH_SKEW_MS) {
      return this.cachedToken.accessToken;
    }

    if (!this.inFlightTokenRequest) {
      this.inFlightTokenRequest = this.acquireToken().finally(() => {
        this.inFlightTokenRequest = null;
      });
    }

    const token = await this.inFlightTokenRequest;
    this.cachedToken = token;
    return token.accessToken;
  }

  private async acquireToken(): Promise<CachedToken> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    const res = await this.request(this.config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      // Never include the client secret in the error message.
      throw new OrchardCoreAuthError(
        `Failed to acquire an access token from OrchardCore (status ${res.status}). Check the McpTranslator OpenID application's client id/secret and that the Client Credentials flow is enabled.`,
        res.status,
      );
    }

    const json = (await res.json()) as TokenResponse;
    return {
      accessToken: json.access_token,
      expiresAtEpochMs: Date.now() + json.expires_in * 1000,
    };
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getToken();
    return { Authorization: `Bearer ${token}` };
  }

  private normalizeOptions(options: Partial<QueryOptions>): QueryOptions {
    return {
      first: clamp(Math.trunc(options.first ?? 20), 1, this.config.maxPageSize),
      skip: Math.max(Math.trunc(options.skip ?? 0), 0),
      status: options.status ?? "PUBLISHED",
    };
  }

  private async executeContentTypeQuery(
    contentType: string,
    displayTextContains: string | undefined,
    options: Partial<QueryOptions>,
  ): Promise<ContentItemSummary[]> {
    const { first, skip, status } = this.normalizeOptions(options);
    const fieldName = toCamelCase(contentType);

    const hasFilter = displayTextContains !== undefined;
    const whereClause = hasFilter ? "where: { displayText_contains: $q }" : "";
    // $q must only be declared in the operation signature when the `where`
    // clause actually uses it — GraphQL's NO_UNUSED_VARIABLES validation
    // rejects a declared-but-unused variable with an HTTP 400, which is
    // exactly what list_content (no search filter) used to hit.
    const qDeclaration = hasFilter ? ", $q: String" : "";
    // The GraphQL enum type is literally named "Status" in OrchardCore's
    // schema (see PublicationStatusGraphType.cs: Name = "Status") — not
    // "PublicationStatusEnum", which doesn't exist and fails schema
    // validation with an HTTP 400 if used here.
    const query = `query($first: Int, $skip: Int, $status: Status${qDeclaration}) {
      ${fieldName}(first: $first, skip: $skip, status: $status ${whereClause ? `, ${whereClause}` : ""}) {
        contentItemId
        contentType
        displayText
        published
        latest
        createdUtc
        modifiedUtc
        owner
      }
    }`;

    const variables: Record<string, unknown> = { first, skip, status };
    if (displayTextContains !== undefined) {
      variables.q = displayTextContains;
    }

    const headers = await this.authHeaders();
    const res = await this.request(`${this.config.baseUrl}${this.config.graphQLPath}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 401) {
      throw new OrchardCoreAuthError(
        "OrchardCore rejected the translator's credentials for GraphQL access.",
        401,
      );
    }
    if (res.status === 403) {
      throw new OrchardCoreForbiddenError(
        `OrchardCore denied GraphQL access to content type "${contentType}". Check the McpTranslator role's ExecuteGraphQL and ViewOwn_${contentType} permissions.`,
        403,
      );
    }
    if (!res.ok) {
      throw new OrchardCoreHttpError(
        `OrchardCore GraphQL endpoint returned HTTP ${res.status}.`,
        res.status,
      );
    }

    const body = (await res.json()) as GraphQLResponseBody;

    // OrchardCore's GraphQL middleware can return HTTP 200 with a top-level
    // "errors" array for resolver/permission-level failures — always check
    // this even when res.ok is true.
    if (body.errors && body.errors.length > 0) {
      throw new OrchardCoreGraphQLError(
        `OrchardCore GraphQL query for content type "${contentType}" failed: ${body.errors.map((e) => e.message).join("; ")}`,
        body.errors.map((e) => e.message),
      );
    }

    const items = (body.data?.[fieldName] as ContentItemSummary[] | undefined) ?? [];
    return items;
  }

  async listContentByType(
    contentType: string,
    options: Partial<QueryOptions> = {},
  ): Promise<ContentItemSummary[]> {
    return this.executeContentTypeQuery(contentType, undefined, options);
  }

  async searchContentByType(
    contentType: string,
    query: string,
    options: Partial<QueryOptions> = {},
  ): Promise<ContentItemSummary[]> {
    // Defense in depth: the search_content_by_type tool's zod schema already
    // requires a non-empty query, but the client enforces it too so this
    // invariant doesn't depend solely on the tool layer.
    if (query.trim().length === 0) {
      throw new InvalidInputError("searchContentByType requires a non-empty query");
    }
    return this.executeContentTypeQuery(contentType, query, options);
  }

  /**
   * Always creates the item as a draft. The `?draft=true` literal below is
   * hardcoded with no parameter that could flip it — this is the mechanism
   * that guarantees the translator can never publish content, independent of
   * whatever the calling role technically has permission to do. See
   * SETUP-ORCHARDCORE.md for why the McpTranslator role still needs
   * PublishOwn_<Type> despite this.
   */
  async createDraftContent(
    contentType: string,
    displayText: string | undefined,
    properties: Record<string, unknown> | undefined,
  ): Promise<CreatedContentItem> {
    const headers = await this.authHeaders();

    // properties is caller-controlled free-form data. Reserved top-level
    // fields are stripped from it and re-applied afterward, so a caller can
    // never use `properties` to overwrite contentType (the allow-list check
    // already ran against the top-level contentType argument, not anything
    // inside properties), contentItemId (which would turn this "create-only"
    // call into an edit of existing content, per CreateEndpoint.cs's
    // update-if-existing-draft behavior), or draft/publish-related fields.
    const sanitizedProperties = { ...properties };
    for (const reservedKey of RESERVED_CONTENT_FIELDS) {
      delete sanitizedProperties[reservedKey];
    }

    // OrchardCore's ContentItemConverter does a case-sensitive switch on
    // exact PascalCase property names (ContentType, DisplayText, ...) — a
    // camelCase "contentType" is silently dropped by that converter, which
    // then rejects the request with an empty-body 400 (no ContentType means
    // CreateEndpoint.cs can't resolve a content type definition). ContentType
    // and DisplayText must use OrchardCore's exact casing here.
    const payload = {
      ...sanitizedProperties,
      ContentType: contentType,
      ...(displayText !== undefined ? { DisplayText: displayText } : {}),
    };

    const res = await this.request(`${this.config.baseUrl}/api/content?draft=true`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.status === 401) {
      throw new OrchardCoreAuthError(
        "OrchardCore rejected the translator's credentials for content creation.",
        401,
      );
    }
    if (res.status === 403) {
      throw new OrchardCoreForbiddenError(
        `OrchardCore denied draft creation for content type "${contentType}". Check the McpTranslator role's AccessContentApi and PublishOwn_${contentType} permissions.`,
        403,
      );
    }
    if (res.status === 400) {
      const problem = (await res.json()) as { errors?: Record<string, string[]> };
      throw new OrchardCoreValidationError(
        `OrchardCore rejected the content for content type "${contentType}".`,
        problem.errors ?? {},
      );
    }
    if (!res.ok) {
      throw new OrchardCoreHttpError(
        `OrchardCore content creation endpoint returned HTTP ${res.status}.`,
        res.status,
      );
    }

    const created = (await res.json()) as CreatedContentItem;
    return created;
  }
}
