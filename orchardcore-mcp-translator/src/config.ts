import { z } from "zod";
import { ConfigurationError } from "./errors.js";

const envSchema = z.object({
  ORCHARDCORE_BASE_URL: z
    .string()
    .url()
    .transform((s) => s.replace(/\/+$/, "")),
  ORCHARDCORE_TOKEN_URL: z.string().url().optional(),
  ORCHARDCORE_CLIENT_ID: z.string().min(1),
  ORCHARDCORE_CLIENT_SECRET: z.string().min(1),
  ORCHARDCORE_GRAPHQL_PATH: z.string().min(1).default("/api/graphql"),
  ORCHARDCORE_ALLOWED_CONTENT_TYPES: z
    .string()
    .min(1)
    .transform((s) =>
      s
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    )
    .refine((types) => types.length > 0, {
      message: "ORCHARDCORE_ALLOWED_CONTENT_TYPES must list at least one content type",
    }),
  ORCHARDCORE_MAX_PAGE_SIZE: z.coerce.number().int().positive().max(1000).default(50),
  ORCHARDCORE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

export interface AppConfig {
  readonly baseUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly graphQLPath: string;
  readonly allowedContentTypes: readonly string[];
  readonly maxPageSize: number;
  readonly requestTimeoutMs: number;
}

/**
 * Parses and validates process.env, failing fast (throwing) at startup rather
 * than surfacing a confusing error on the first tool call.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new ConfigurationError(`Invalid or missing environment configuration:\n${issues}`);
  }

  const data = parsed.data;
  return {
    baseUrl: data.ORCHARDCORE_BASE_URL,
    tokenUrl: data.ORCHARDCORE_TOKEN_URL ?? `${data.ORCHARDCORE_BASE_URL}/connect/token`,
    clientId: data.ORCHARDCORE_CLIENT_ID,
    clientSecret: data.ORCHARDCORE_CLIENT_SECRET,
    graphQLPath: data.ORCHARDCORE_GRAPHQL_PATH,
    allowedContentTypes: data.ORCHARDCORE_ALLOWED_CONTENT_TYPES,
    maxPageSize: data.ORCHARDCORE_MAX_PAGE_SIZE,
    requestTimeoutMs: data.ORCHARDCORE_REQUEST_TIMEOUT_MS,
  };
}
