# Group 2 — Track A

## What we built

An MCP server (`orchardcore-mcp-translator/`) that lets Claude Code read and create content
in a running OrchardCore instance through exactly three tools — `list_content`,
`search_content_by_type`, and `create_content` — over a dedicated, least-privilege
`McpTranslator` OpenID service identity (client-credentials flow), never the admin account.
`list_content` and `search_content_by_type` go through OrchardCore's GraphQL API (REST has no
list/query endpoint for content); `create_content` goes through REST and always issues
`POST /api/content?draft=true`, hardcoded with no caller-controllable override, so the server
can never publish, edit existing content, or delete anything — even a caller that tries to
smuggle `draft`/`publish`/`contentItemId` into the request is rejected by a `.strict()` zod
schema and a reserved-field strip in the client. OrchardCore-side setup (features, the
`McpTranslator` role, the OpenID client) is automated via a JSON recipe imported through the
admin's Deployment module rather than clicked through by hand. A one-command installer
(`install.sh` / `install.ps1`) builds the server and registers it with `claude mcp add
--scope local`, falling back to writing `.mcp.json` directly when the `claude` CLI isn't on
PATH. We exercised the live tools directly in this Claude Code session against the running
instance — listing, keyword-searching, and creating draft `BlogPost` items — and confirmed
new items came back as unpublished drafts, not published posts.

What works: all three tools, live, end to end; the allow-list (`ORCHARDCORE_ALLOWED_CONTENT_TYPES`)
and draft-only guarantees, both defended by tests and a manual security-review pass; the
PreToolUse hook that blocks `git commit`/`git push` when `npm run verify` fails; the
install/registration flow with the CLI-missing fallback. What we cut: `list_content`'s
no-type fan-out issues one full-size GraphQL request per allow-listed content type and merges
client-side rather than collapsing them into a single aliased-fields query — correct and
parallelized, but not maximally efficient, and we ran out of time to rework the query
builder before the deadline. We also left two OrchardCore permission-model gaps as
documented, accepted risk rather than "fixed": `ExecuteGraphQL` technically permits
introspection, and `PublishOwn_<Type>` (required by OrchardCore's create endpoint even for
`draft=true`) technically permits the service principal to publish — OrchardCore has no
"create-draft-only" permission tier, so neither can be tightened further without patching
OrchardCore itself, which was out of scope.

## Claude Code features used

- **Custom sub-agents** (`.claude/agents/{security,performance,style}-reviewer.md`) — three
  narrow, read-only agents scoped to `src/`/`tests/`, run as a dedicated review pass after
  the test suite went green. Findings consolidated into `orchardcore-mcp-translator/REVIEW.md`.
  Bought us an independent second read on the code that caught a real critical bug before
  commit (see next section).
- **PreToolUse hook** (`.claude/settings.json` + `.claude/hooks/guard-git-commit-push.mjs`) —
  intercepts any Bash `git commit`/`git push`, runs `npm run verify` (typecheck + lint +
  vitest), and blocks the action with exit code 2 and the failure output on any failure.
  Bought us a hard backstop against committing broken code, proven by deliberately breaking
  a test, attempting a commit, watching it block, then fixing and committing successfully.
- **MCP server registration** — this session used the translator's own three tools
  (`orchardcore-cms` MCP server, registered via `.mcp.json`) live against the running
  OrchardCore instance to smoke-test `list_content`, `search_content_by_type`, and
  `create_content` — the actual deliverable, dogfooded inside Claude Code itself.
- **Project instructions / config-driven skills in the OrchardCore checkout** — we relied on
  the OrchardCore repo's existing `.agents/skills/*` (e.g. `orchardcore-recipe-creator`) for
  ground truth on recipe step shapes when writing `setup/mcp-translator-setup.recipe.json`,
  rather than guessing the JSON structure.

## What Claude got wrong, and how we caught it

1. **Mass-assignment allow-list bypass in `createDraftContent`** (`src/orchardcore-client.ts`) —
   the REST create request body was originally built as
   `{ contentType, ...displayText, ...properties }` with the caller-supplied `properties`
   object spread *last*. Since `properties` is only validated as
   `z.record(z.string(), z.unknown())` — a shape the outer `.strict()` schema doesn't reach
   into — any key inside it could silently overwrite `contentType` or `contentItemId` in the
   actual JSON sent to OrchardCore. A call like
   `{ contentType: "BlogPost", properties: { contentType: "SecretAdminType" } }` would pass
   the tool's allow-list check on `"BlogPost"` while the real request created a
   `SecretAdminType` item instead — a complete allow-list bypass, and via `contentItemId` a
   way to turn a "create-only" tool into an editor of existing content. This was not caught
   by the initial test suite (which only tested the happy path for `properties`); it was
   caught by the **security-reviewer sub-agent**, which specifically traced how every value
   reaching the outbound HTTP body was constrained. Fixed by stripping a
   `RESERVED_CONTENT_FIELDS` block-list from `properties` before merging and re-applying
   `contentType`/`displayText` last, with a new regression test
   (`tests/orchardcore-client.test.ts` — "never lets properties override contentType,
   contentItemId, or other reserved body fields").
2. **Bare `throw new Error(...)` bypassing the typed-error contract** (`src/orchardcore-client.ts`,
   `searchContentByType`) — a whitespace-only search query passes zod's `.min(1)` (a single
   space has length 1) but failed the client's own trim check via a raw `Error`, which the
   app's `isOrchardCoreError`-based MCP error-result mapping doesn't recognize, so it would
   have surfaced as an unhandled exception instead of a clean tool error. Caught by the
   **style-reviewer sub-agent**, which was specifically checking that every thrown error in
   `src/` is a typed class from `errors.ts`. Fixed by introducing `InvalidInputError` and,
   to stop the same class of bug recurring, adding an ESLint `no-restricted-syntax` rule
   banning `throw new Error(...)` in `src/**/*.ts` — so this category is now a lint failure,
   not just a review finding.
3. **Pagination ceiling silently disconnected from its own config value** (`src/schemas.ts`) —
   the zod-level cap on `first` was hardcoded to `50`, independent of the separately
   configurable `ORCHARDCORE_MAX_PAGE_SIZE` (default 50, but operator-settable up to 1000).
   Because MCP-boundary validation runs before the client's own clamp ever sees the value,
   any config value above 50 was silently dead code — a config knob that looked functional
   but did nothing. Caught by the **style-reviewer sub-agent** during a naming/consistency
   pass, not by any test (nothing was asserting the two stayed in sync). Fixed by turning the
   input schemas into factory functions parameterized by `maxPageSize`, with a regression
   test pinning that the ceiling is derived from config, not a constant.

## What we'd do with another day

- Collapse `list_content`'s no-content-type fan-out from N separate full-size GraphQL
  requests (one per allow-listed type) into a single query using aliased root fields, so
  total bytes fetched scale with the requested `first`, not `N × first`.
- Add the allow-list check as defense-in-depth *inside* `OrchardCoreClient` itself (currently
  only enforced in the three tool files) so a future direct caller of the client can't
  silently skip it — deferred because it would thread `AppConfig`'s allow-list through a
  lower layer that otherwise has no config dependency, and we wanted a design discussion
  before doing that, not a rushed one.
- Push on OrchardCore's permission model directly (or file an upstream issue) to see whether
  a real "create-draft-only" permission tier is feasible, so the `McpTranslator` role no
  longer needs the over-broad `PublishOwn_<Type>` and `ExecuteGraphQL`-implies-introspection
  grants we currently have to accept and document rather than fix.
- Add format/character validation on `ORCHARDCORE_ALLOWED_CONTENT_TYPES` entries in
  `config.ts` so a misconfigured type name containing GraphQL metacharacters can't reach the
  interpolated field-name position in the query builder — low severity today since it's
  operator-, not attacker-, controlled, but cheap to close off.
