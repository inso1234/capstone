# Sub-agent review

Consolidated findings from the security, performance, and style reviewer subagents
(`.claude/agents/{security,performance,style}-reviewer.md`), run against the translator's
`src/` and `tests/`. The critical security finding below was fixed before this file was
committed — see the "Fixed" notes.

## Security

- **[CRITICAL — FIXED]** Mass-assignment / allow-list bypass via `properties` spread in
  `createDraftContent` — `src/orchardcore-client.ts` (was lines 253-257). The request body
  was built as `{ contentType, ...(displayText…), ...properties }` with `properties` spread
  last, so any key in the caller-supplied `properties` object (validated only as
  `z.record(z.string(), z.unknown())`, which `.strict()` on the outer object does not reach
  into) could silently overwrite `contentType`, `displayText`, `contentItemId`, or other
  top-level body fields. A caller could send
  `{ contentType: "BlogPost", properties: { contentType: "SecretAdminType" } }` and have
  `assertContentTypeAllowed` validate `"BlogPost"` while the actual JSON body posted to
  OrchardCore carried `contentType: "SecretAdminType"` — bypassing the content-type
  allow-list entirely, independent of the correctly-hardcoded `?draft=true` query string. A
  `contentItemId` could similarly have turned this "create-only" tool into an editor of
  existing content (OrchardCore's create endpoint updates an existing draft when the id
  matches one). **Fix applied**: `createDraftContent` now strips a `RESERVED_CONTENT_FIELDS`
  block-list (`contentType`, `contentItemId`, `contentItemVersionId`, `displayText`,
  `draft`, `publish`, `published`, `latest`, `owner`, `author`, `createdUtc`, `modifiedUtc`,
  `publishedUtc`) from `properties` before merging, and re-applies `contentType`/
  `displayText` last so they always win. Regression test:
  `tests/orchardcore-client.test.ts` — "never lets properties override contentType,
  contentItemId, or other reserved body fields".

- **[MODERATE]** No allow-list defense-in-depth inside `OrchardCoreClient` —
  `src/orchardcore-client.ts` (`listContentByType`, `searchContentByType`,
  `createDraftContent`). All three trust the caller's `contentType` completely; the only
  enforcement is in the three tool files, all of which are currently correct. A future
  direct caller of the client that skips `assertContentTypeAllowed` would silently bypass
  the allow-list with no backstop. Not fixed — accepted as a known structural risk to watch
  in future changes, since adding the check inside the client would duplicate the allow-list
  parameter through a lower layer that doesn't otherwise need `AppConfig`.

- **[MINOR]** `ORCHARDCORE_ALLOWED_CONTENT_TYPES` parsing has no format/character validation
  on entries — `src/config.ts`. A misconfigured entry containing GraphQL metacharacters
  would flow into the interpolated field-name position in the GraphQL query builder.
  Operator-controlled, not attacker-controlled, so low severity. Not fixed.

- **[CLEAN]** GraphQL injection / query-shape escape — only the allow-list-checked
  `contentType` (via `toCamelCase`) influences query text; every other value travels as a
  GraphQL variable.

- **[CLEAN]** Allow-list enforcement order — verified correct call order
  (assert-before-network) in all three tools.

- **[CLEAN]** Hardcoded `?draft=true` in `createDraftContent` — no code path reads a
  variable for it.

- **[CLEAN]** Credential handling — `ORCHARDCORE_CLIENT_SECRET` and the bearer token are
  never logged or included in any thrown error; the token is cached in memory only, never
  persisted.

- **[CLEAN]** Fail-fast config validation — `config.ts` throws synchronously at startup,
  before the client or MCP transport are constructed.

- **[CLEAN]** Outbound request hygiene — every fetch routes through a single `request()`
  helper that always attaches `AbortSignal.timeout(...)`.

- **[ACCEPTED RISK, not a code defect]** The `McpTranslator` role's `ExecuteGraphQL` grant
  technically permits GraphQL introspection queries — OrchardCore doesn't gate introspection
  separately from `ExecuteGraphQL`. See `SETUP-ORCHARDCORE.md`.

- **[ACCEPTED RISK, not a code defect]** The role's `PublishOwn_<Type>` grant — required
  because OrchardCore's create endpoint demands it even for `draft=true` creates — technically
  permits the service principal to publish those content types, beyond what
  `create_content`'s own code ever exercises. See `SETUP-ORCHARDCORE.md` for why this can't
  be tightened further within OrchardCore's current permission model.

## Performance

- **[MODERATE]** `list_content`'s no-`contentType` fan-out — `src/tools/list-content.ts`.
  Requests the full `first` page size from *every* allow-listed content type before merging
  and slicing down to `first`, so total items fetched over the wire scale as `N × first` (N
  = allow-listed type count) for an output that is always ≤ `first`. Also issues N separate
  HTTP requests where OrchardCore GraphQL's support for multiple aliased root fields in one
  query could in principle collapse this to a single round-trip. The fan-out itself is
  correctly parallelized via `Promise.all` (not serial) — only the per-type request sizing
  and request count are the issue. Not fixed in this pass — flagged as a known optimization
  opportunity; the current behavior is bounded and correct, just not maximally efficient
  when many content types are allow-listed.

- **[CLEAN]** Token caching — cache-hit path short-circuits `/connect/token` correctly (30s
  refresh skew), and cold-cache concurrent acquisition is properly single-flighted via a
  shared in-flight promise.

- **[CLEAN]** Pagination bounds — `first`/`skip` are clamped to `ORCHARDCORE_MAX_PAGE_SIZE`
  at the single choke point (`executeContentTypeQuery`) used by every query path, independent
  of tool-layer input. (The zod-level ceiling used to be a hardcoded `50`, disconnected from
  this config value — see Style section — now fixed to derive from the same config.)

- **[CLEAN]** Payload handling — no redundant JSON parse/stringify or deep-cloning of
  content-item payloads between the client and tool layers.

- **[CLEAN]** Blocking operations — no synchronous/blocking calls in any per-tool-call code
  path.

## Style

- **[CRITICAL — FIXED]** `src/orchardcore-client.ts` had a bare `throw new Error(...)` in
  `searchContentByType` for a whitespace-only query (passes zod's `.min(1)` but fails the
  client's own trim check), bypassing the app's typed-error → MCP-error-result contract used
  everywhere else. **Fix applied**: now throws the new `InvalidInputError` typed class
  (`src/errors.ts`), which `isOrchardCoreError` recognizes like every other typed error.

- **[MODERATE — FIXED]** `src/config.ts` had a bare `throw new Error(...)` in `loadConfig()`.
  **Fix applied**: now throws a new `ConfigurationError` typed class.

- **[MODERATE — FIXED]** `src/schemas.ts`'s pagination `first` was hard-capped at `50`,
  disconnected from the independently configurable `ORCHARDCORE_MAX_PAGE_SIZE` (default 50,
  max 1000). Any config value above 50 was silently dead, since MCP-boundary zod validation
  ran before the client's own clamp ever saw the value. **Fix applied**: `listContentInputSchema`
  and `searchContentByTypeInputSchema` are now factory functions taking `maxPageSize`,
  called with `config.maxPageSize` in `tools/index.ts`. Regression test:
  `tests/tools/list-content.test.ts` — "derives the first ceiling from
  ORCHARDCORE_MAX_PAGE_SIZE, not a hardcoded constant".

- **[MINOR — FIXED]** `QueryOptions` and `FetchImpl` in `src/orchardcore-client.ts` were
  exported with no consumers outside the file. De-exported.

- **[MINOR — FIXED]** No lint rule forbade `throw new Error(...)` in `src/`, which was the
  root cause behind the two typed-error violations above. **Fix applied**: added a
  `no-restricted-syntax` ESLint rule scoped to `src/**/*.ts`.

- **[MODERATE — FIXED, extensibility]** `src/tools/index.ts` had no structural guardrail
  marking the tool surface as a closed set of exactly 3 — nothing would fail CI if a 4th
  tool were added. **Fix applied**: added a header comment stating the 3-tool boundary, and
  a new test (`tests/tools/index.test.ts`) pinning the exact registered tool names.

- **[CLEAN]** Naming consistency — tool name ↔ file ↔ handler line up for all three tools.

- **[CLEAN]** Tool descriptions in `src/tools/index.ts` accurately reflect behavior,
  including `create_content`'s explicit "always draft, never publishes" statement.

- **[CLEAN]** Async style — no mixed `.then()`/async-await within any file.

- **[CLEAN]** Shared zod fragments (`paginationSchema`, `publicationStatusSchema`) are
  declared once and reused by both tool schemas — no per-tool redeclaration or bound drift.
