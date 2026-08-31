import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Mock } from "vitest";
import type { AppConfig } from "../src/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadFixture<T = unknown>(name: string): T {
  const raw = readFileSync(path.join(__dirname, "fixtures", name), "utf-8");
  return JSON.parse(raw) as T;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function buildTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    baseUrl: "https://orchardcore.test",
    tokenUrl: "https://orchardcore.test/connect/token",
    clientId: "mcp-translator",
    clientSecret: "test-secret-value",
    graphQLPath: "/api/graphql",
    allowedContentTypes: ["BlogPost", "Page"],
    maxPageSize: 50,
    requestTimeoutMs: 10_000,
    ...overrides,
  };
}

/** Extracts the JSON body sent in a fetch mock call's RequestInit. */
export function sentJsonBody(fetchMock: Mock, callIndex = 0): unknown {
  const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  return init?.body ? JSON.parse(init.body as string) : undefined;
}

export function sentUrl(fetchMock: Mock, callIndex = 0): string {
  return fetchMock.mock.calls[callIndex]?.[0] as string;
}
