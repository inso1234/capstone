import { z } from "zod";
import { ContentTypeNotAllowedError } from "./errors.js";

export const publicationStatusSchema = z
  .enum(["PUBLISHED", "DRAFT", "LATEST", "ALL"])
  .default("PUBLISHED");

/**
 * The `first` ceiling must track ORCHARDCORE_MAX_PAGE_SIZE (config.ts) rather
 * than a hardcoded constant — otherwise raising that env var above a fixed
 * cap here would have no effect, since this MCP-boundary validation runs
 * before the client's own clamp ever sees the value.
 */
function paginationSchema(maxPageSize: number) {
  return {
    first: z
      .number()
      .int()
      .min(1)
      .max(maxPageSize)
      .default(Math.min(20, maxPageSize)),
    skip: z.number().int().min(0).default(0),
  };
}

export function listContentInputSchema(maxPageSize: number) {
  return z
    .object({
      contentType: z.string().min(1).optional(),
      ...paginationSchema(maxPageSize),
      status: publicationStatusSchema,
    })
    .strict();
}
export type ListContentInput = z.infer<ReturnType<typeof listContentInputSchema>>;

export function searchContentByTypeInputSchema(maxPageSize: number) {
  return z
    .object({
      contentType: z.string().min(1),
      query: z.string().min(1),
      ...paginationSchema(maxPageSize),
      status: publicationStatusSchema,
    })
    .strict();
}
export type SearchContentByTypeInput = z.infer<ReturnType<typeof searchContentByTypeInputSchema>>;

export const createContentInputSchema = z
  .object({
    contentType: z.string().min(1),
    displayText: z.string().min(1).optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type CreateContentInput = z.infer<typeof createContentInputSchema>;

/**
 * The single choke point every tool must call, before any network call, to
 * enforce the ORCHARDCORE_ALLOWED_CONTENT_TYPES allow-list.
 */
export function assertContentTypeAllowed(
  contentType: string,
  allowedContentTypes: readonly string[],
): void {
  if (!allowedContentTypes.includes(contentType)) {
    throw new ContentTypeNotAllowedError(contentType, allowedContentTypes);
  }
}
