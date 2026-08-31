# OrchardCore MCP Translator — Implementation Plan

## Context

The capstone requires building an MCP server ("translator") that lets Claude Code read and
write content inside a running OrchardCore instance through exactly three tools —
`list_content`, `create_content`, `search_content_by_type` — without ever handing over admin
access. The supplied `Capstone_Build_Guide.md` sketches a phase-by-phase approach, but it
was written without knowledge of this specific OrchardCore checkout's actual API surface, so
several of its assumptions don't hold here. This plan replaces the guide's assumptions with
verified facts from the real codebase (`...\Capstone\OrchardCore`) and fills in the concrete
architecture the guide left abstract.

Two corrections to the guide that shape everything below:

1. **`OrchardCore.Contents` has no REST list/query endpoint** — only
   `GET api/content/{id}`, `POST api/content`, `DELETE api/content/{id}` exist
   (`src/OrchardCore.Modules/OrchardCore.Contents/Endpoints/Api/`). The guide assumed
   `list_content` would use REST and only `search_content_by_type` would use GraphQL. In
   reality **both `list_content` and `search_content_by_type` must use GraphQL** — REST is
   only used for `create_content`.
2. **OrchardCore's permission model has no "create draft only, cannot publish" tier.**
   `CreateEndpoint.cs` requires `PublishContent`/`PublishOwn_<Type>` for *any* brand-new
   content item, even when the request passes `draft=true`. The "always creates a draft,
   never publishes" guarantee the assignment wants therefore cannot be enforced by
   OrchardCore's permission system alone — it must be enforced in the translator's own code
   (hardcoding `?draft=true` with no caller-controllable override), documented as an
   accepted tradeoff.

The user has confirmed two decisions that this plan builds around:
- The translator repo will be a **sibling folder** of the OrchardCore checkout:
  `...\Documents\Day1\Capstone\orchardcore-mcp-translator\`.
- OrchardCore-side setup (features, role/permissions, OpenID client) will be **automated via
  an OrchardCore recipe**, not clicked through the admin UI by hand.

---

## 1. OrchardCore-side setup — via recipe, not manual admin clicks

Confirmed against the checkout: `Feature`, `Roles`, `OpenIdServerSettings`, and
`OpenIdApplication` are all real recipe step types, and a recipe can be applied to an
**already-running tenant** (not just at first setup) through the Deployment module's
"Import a recipe" screen, which executes immediately with only a shell reload.

**One-time manual prerequisite** (can't be avoided — it's what makes recipe-import possible
at all): in the running OrchardCore admin, enable the **`OrchardCore.Deployment`** feature
(Configuration → Features). This is the only admin-UI click-through step in the whole setup.

**Then run one combined recipe** — save as
`orchardcore-mcp-translator/setup/mcp-translator-setup.recipe.json` (gitignored — it
contains a plaintext client secret; OrchardCore/OpenIddict hashes it on save, so plaintext
only ever exists in this local file and in transit), then paste its contents into
**Admin → Deployment Plans → Import → Import from a recipe file (paste JSON)**:

```json
{
  "name": "EnableMcpTranslatorAccess",
  "displayName": "Enable MCP Translator Access",
  "steps": [
    {
      "name": "feature",
      "enable": [
        "OrchardCore.Apis.GraphQL",
        "OrchardCore.OpenId.Server",
        "OrchardCore.OpenId.Validation"
      ]
    },
    {
      "name": "Roles",
      "Roles": [
        {
          "Name": "McpTranslator",
          "Description": "Least-privilege service role for the MCP translator",
          "Permissions": [
            "AccessContentApi",
            "ExecuteGraphQL",
            "ViewOwn_BlogPost",
            "PublishOwn_BlogPost"
          ]
        }
      ]
    },
    {
      "name": "OpenIdServerSettings",
      "EnableTokenEndpoint": true,
      "AllowClientCredentialsFlow": true
    },
    {
      "name": "OpenIdApplication",
      "ClientId": "mcp-translator",
      "DisplayName": "MCP Translator Service Client",
      "Type": "confidential",
      "ConsentType": "explicit",
      "ClientSecret": "<generate-a-strong-secret-here>",
      "AllowClientCredentialsFlow": true,
      "RoleEntries": [ { "Name": "McpTranslator" } ]
    }
  ]
}
```

Notes:
- `ViewOwn_BlogPost` / `PublishOwn_BlogPost` are placeholders — replace `BlogPost` with each
  content type going into `ORCHARDCORE_ALLOWED_CONTENT_TYPES` (§3), one `ViewOwn_<Type>` +
  `PublishOwn_<Type>` pair per type. `RolesStep` accepts arbitrary permission strings with no
  validation against a provider, so these dynamic names just need to be listed correctly.
- `PublishOwn_<Type>` is granted only because `CreateEndpoint.cs` requires it even for
  drafts (see Context above) — document this explicitly in the translator's README as a
  known OrchardCore permission-model limitation, not a translator bug.
- Deliberately **not** granted: `ExecuteGraphQLMutations`, `EditContent`/`Edit_<Type>`,
  `DeleteContent`/`Delete_<Type>`, global `ViewContent`/`PublishContent`.
- After import, manually verify in the admin UI that content types matching
  `ORCHARDCORE_ALLOWED_CONTENT_TYPES` actually exist (create them under Content Definition
  first if not).
- **Manual sanity check before writing any translator code:**
  - `POST {base}/connect/token` (`grant_type=client_credentials&client_id=mcp-translator&client_secret=...`) → expect `200` + `access_token`.
  - `POST {base}/api/graphql` with `Authorization: Bearer <token>`, body
    `{"query":"query { blogPost(first: 1) { contentItemId displayText } }"}` → expect `200`
    with a `data` object.
  - `POST {base}/api/content?draft=true` with the token,
    `{ "contentType": "BlogPost", "displayText": "test" }` → expect `200` with the created
    draft item.

---

## 2. Translator repo layout

New sibling repo: `...\Documents\Day1\Capstone\orchardcore-mcp-translator\`

```
orchardcore-mcp-translator/
  package.json                 # @modelcontextprotocol/sdk, zod, typescript, vitest, eslint+typescript-eslint
  tsconfig.json                 # ES2022+, NodeNext, strict: true
  .env.example / .env(gitignored)
  .gitignore                    # node_modules, dist, .env, setup/mcp-translator-setup.recipe.json
  README.md                     # quick start, tool docs, troubleshooting
  SETUP-ORCHARDCORE.md          # the recipe + manual-prereq steps from §1
  REVIEW.md                     # consolidated subagent findings, committed at repo root
  install.sh / install.ps1
  setup/
    mcp-translator-setup.recipe.json   # gitignored (real secret); a .example version committed
  src/
    server.ts                   # entry: builds McpServer, registers tools, StdioServerTransport
    config.ts                   # zod-validates process.env into typed AppConfig, fails fast
    errors.ts                   # OrchardCoreAuthError, ForbiddenError, ValidationError, GraphQLError, NetworkError, ContentTypeNotAllowedError
    orchardcore-client.ts        # TokenManager + GraphQL query builder/executor + REST create call
    schemas.ts                   # shared zod fragments + per-tool input schemas + assertContentTypeAllowed
    tools/
      index.ts
      list-content.ts
      search-content-by-type.ts
      create-content.ts
  tests/
    setup.ts
    orchardcore-client.test.ts
    tools/{list-content,search-content-by-type,create-content}.test.ts
    fixtures/*.json
  .claude/
    settings.json                # PreToolUse hook registration
    hooks/guard-git-commit-push.mjs
    agents/{security-reviewer,performance-reviewer,style-reviewer}.md
```

`orchardcore-client.ts` is the only file that calls `fetch` — every tool goes through it,
which makes the allow-list/draft-only guarantees auditable in one place and the client
trivially mockable (inject `fetchImpl`, default `globalThis.fetch`).

---

## 3. `orchardcore-client.ts` design

**Env vars** (validated in `config.ts`, fail-fast at startup):
`ORCHARDCORE_BASE_URL` (required), `ORCHARDCORE_TOKEN_URL` (default
`${BASE_URL}/connect/token`), `ORCHARDCORE_CLIENT_ID` / `ORCHARDCORE_CLIENT_SECRET`
(required), `ORCHARDCORE_GRAPHQL_PATH` (default `/api/graphql`),
`ORCHARDCORE_ALLOWED_CONTENT_TYPES` (required, comma-separated),
`ORCHARDCORE_MAX_PAGE_SIZE` (default `50` — translator's own cap, independent of
OrchardCore's `MaxNumberOfResults`), `ORCHARDCORE_REQUEST_TIMEOUT_MS` (default `10000`).

**TokenManager**: caches `{accessToken, expiresAtEpochMs}`; refreshes when <30s of TTL
remain; single-flight (concurrent callers await the same in-flight acquisition promise
instead of firing parallel `/connect/token` requests); throws `OrchardCoreAuthError` on
non-2xx, **never** including the client secret in the error message.

**GraphQL**: never accepts/forwards raw GraphQL text from a tool. One server-authored
template, parameterized via GraphQL variables for every value except the field name:
```graphql
query($first: Int, $skip: Int, $status: PublicationStatusEnum, $q: String) {
  <camelCase(contentType)>(first: $first, skip: $skip, status: $status, where: { displayText_contains: $q }) {
    contentItemId contentType displayText published latest createdUtc modifiedUtc owner
  }
}
```
— `where` omitted entirely when no search term given. `contentType` → field name is only
computed **after** the allow-list check has already passed. Two methods built on this:
`listContentByType(type, opts)`, `searchContentByType(type, query, opts)`. `first`/`skip`
are clamped to `[1, ORCHARDCORE_MAX_PAGE_SIZE]` / `[0, ∞)` translator-side regardless of
what a tool passes, as defense in depth.

**Important nuance**: GraphQL can return HTTP `200` with a top-level `errors` array
(permission/resolver failures) — the client must check `body.errors` even when `res.ok` and
throw `OrchardCoreGraphQLError` if present.

**REST create**: `createDraftContent(contentType, displayText, properties)` always issues
`POST {BASE_URL}/api/content?draft=true` — the `draft=true` literal is hardcoded with no
parameter that could flip it (this hardcoding *is* the enforcement mechanism for
"never publishes", given §1's permission-model gap). Body merges `properties` shallowly
under `contentType`/`displayText`; OrchardCore's own validation is the source of truth for
part shapes. `400` → `OrchardCoreValidationError` (field→messages intact); `401`/`403` →
`OrchardCoreAuthError`/`OrchardCoreForbiddenError`. All fetches use
`AbortSignal.timeout(ORCHARDCORE_REQUEST_TIMEOUT_MS)`; timeout/network failure →
`OrchardCoreNetworkError`.

---

## 4. Tool designs

Shared helper in `schemas.ts`: `assertContentTypeAllowed(type, allowedSet)` — called by
**every** tool before any network call.

- **`list_content`**: input `{ contentType?, first? (1–50, default 20), skip? (default 0),
  status? (PUBLISHED|DRAFT|LATEST|ALL, default PUBLISHED) }`, `.strict()`. If `contentType`
  omitted, fans out one `listContentByType` call per allow-listed type in parallel
  (`Promise.all` — bounded by the finite, translator-controlled allow-list), merges, sorts
  by `createdUtc` desc, trims to `first`. Returns
  `{contentItemId, contentType, displayText, published, latest, createdUtc, modifiedUtc, owner}[]`.
- **`search_content_by_type`**: input `{ contentType (required), query (required, min
  length 1), first?, skip?, status? }`, `.strict()`. `query` being mandatory is what
  distinguishes it from `list_content(contentType=X)`.
- **`create_content`**: input `{ contentType, displayText?, properties? }`, `.strict()` —
  the strictness is load-bearing: it rejects any extra key (including an attempt to smuggle
  `draft`/`publish`), a second independent layer on top of the client's hardcoded
  `?draft=true`. Response never contains the word "published"; tool description explicitly
  states it always creates a draft. Validation-error responses from OrchardCore surface
  verbatim (field→message); auth/forbidden errors surface as a generic
  "check the McpTranslator role" message, never echoing the secret/token.

---

## 5. Tests (vitest, mocked HTTP)

Dependency-inject `fetchImpl` into `OrchardCoreClient`; tests pass `vi.fn()` returning
canned `Response`s built from `tests/fixtures/*.json`.

- **`orchardcore-client.test.ts`**: token caching (no 2nd fetch within TTL); refresh after
  expiry (`vi.useFakeTimers()`); single-flight under concurrency; auth failure → typed
  error without leaking the secret; GraphQL query shape (field name, variables, `where`
  omitted when no filter); GraphQL `200`-with-`errors` → throws; pagination
  clamping asserted on actual outgoing variables; `createDraftContent` request URL always
  literally contains `?draft=true` (including a case where an internal options object is
  deliberately built with `draft: false`, proving it can't override); `400` →
  `OrchardCoreValidationError` with field map intact; network timeout →
  `OrchardCoreNetworkError`.
- **`tools/list-content.test.ts`**: zod boundary rejections (`first=0`, `first=51`,
  negative `skip`) never reach the client; disallowed `contentType` rejected before any
  client call; no-`contentType` fans out to one call per allow-listed type; single-type
  path calls client once.
- **`tools/search-content-by-type.test.ts`**: empty/missing `query` rejected by zod before
  any client call; disallowed `contentType` rejected before any client call; happy path
  passes args through unchanged.
- **`tools/create-content.test.ts`**: `.strict()` rejects `draft`/`publish` keys, client
  never called; disallowed `contentType` rejected pre-network; happy path response contains
  `status: 'draft'` and never "published"; `OrchardCoreValidationError` surfaces as MCP
  `isError: true` with field messages intact.

`npm run test` (vitest run) as the `test` script — well past the assignment's 5-case
minimum, and every assertion maps back to a specific guarantee made in §3/§4.

---

## 6. Sub-agent review team

`.claude/agents/{security,performance,style}-reviewer.md` — narrow tool access (read-only),
scoped to `src/`/`tests/` of this repo.

- **security-reviewer**: no caller string reaches GraphQL query text except the
  allow-list-checked `contentType` (post-check only); `assertContentTypeAllowed` runs
  *before* any network call in all three tools (check call order, not just presence);
  `create_content`'s `.strict()` + hardcoded `?draft=true` (two independent layers);
  secret/token never logged/thrown/persisted; config fails fast on missing creds; all
  fetches have a timeout; explicitly note as an *accepted-risk* finding (not "fix this")
  that `ExecuteGraphQL` technically permits introspection and `PublishOwn_<Type>`
  technically permits publishing beyond what the tool exercises — both are OrchardCore
  permission-model limits documented in §1, not translator bugs, but must be visible in
  `REVIEW.md`.
- **performance-reviewer**: token caching/single-flight genuinely avoids redundant
  `/connect/token` calls; `list_content`'s fan-out is `Promise.all` (parallel) and doesn't
  over-fetch per type just to discard most after merging; `first`/`skip` always clamped to
  `ORCHARDCORE_MAX_PAGE_SIZE`; no redundant payload cloning.
- **style-reviewer**: every thrown error is a typed class from `errors.ts`, never bare
  `throw new Error`; shared zod fragments live once in `schemas.ts`; naming consistency
  across tool name / file / handler; `create_content`'s MCP description explicitly states
  draft-only behavior; consistent async/await, no dead exports.

Run all three, consolidate into `REVIEW.md` at repo root (`## Security` / `## Performance`
/ `## Style`, each finding with file:line + severity). Run this **after** §5's tests are
green and the tree is otherwise stable — not interleaved with earlier steps.

---

## 7. PreToolUse hook

**Stack**: ESLint (flat config) + `typescript-eslint` + `tsc --noEmit` (not Biome — Biome's
linter isn't type-aware, so it can't catch unawaited-promise bugs in async tool
handlers/fetch calls, and `tsc --noEmit` would still be needed regardless).

`package.json` scripts: `typecheck` (`tsc --noEmit`), `lint` (`eslint src tests
--max-warnings=0`), `test` (`vitest run`), `verify` (all three chained) — the hook calls
only `verify`.

`.claude/settings.json`: `PreToolUse` hook, matcher `Bash`, command
`node .claude/hooks/guard-git-commit-push.mjs`. The script itself (not the matcher) filters
for `git commit`/`git push` (including chained commands, e.g.
`git add -A && git commit -m x`) via regex on `tool_input.command`; exits `0` immediately
for anything else. On a match, runs `npm run verify` (resolving the repo root relative to
the script's own location, not the caller's cwd); exit `0` + silence on success; on
failure, prints the captured failure output to stderr and `process.exit(2)` — code `2` is
what makes Claude Code block the action and see the reason. If `npm run verify` can't even
start (e.g. missing `node_modules`), still exit `2` (fail closed) with a distinguishing
message.

**Prove it**: introduce a deliberate failing assertion, attempt `git commit`, confirm the
block + message; fix it, commit again, confirm it passes. Keep the transcript — it's a
graded deliverable.

---

## 8. Install packaging

`install.sh` / `install.ps1` (mirror each other): resolve script's own dir (cwd-independent);
verify `node`≥18, `npm`, `claude` CLI present; `npm install && npm run build`; if `.env`
missing, copy from `.env.example`, print the 4 required vars, stop (accept them as
non-interactive flags instead of requiring manual JSON/`.env` editing); require a target
project directory argument; run `claude mcp add --help` first to confirm current flag
syntax, then register the server (`node "<repo>/dist/server.js"`) at **`--scope local`**
(per-user — not `--scope project`, which would write a shared, committed `.mcp.json`
leaking the client secret); print a success message + a sample smoke-test prompt naming the
3 tools; fail loudly and stop on any failed step.

`README.md`: prerequisites, one-line install command (used later for the stretch goal —
installing into a second, unrelated project), the 3 tools with example prompts, a pointer
to `SETUP-ORCHARDCORE.md`, troubleshooting mapped to the typed errors from §3.

---

## 9. Order of operations

1. §1 — apply the OrchardCore recipe (one manual click to enable Deployment, then
   paste-import), run the 3 manual `curl` sanity checks.
2. Scaffold repo (§2): `package.json`, `tsconfig.json`, `.gitignore`, install deps.
3. `config.ts` + `errors.ts` (no dependencies).
4. Fill in real `.env` from step 1's credentials.
5. `orchardcore-client.ts` (§3) + its full test file — mocked `fetch`, no live server needed.
6. `schemas.ts` + `tools/*.ts` (§4) + their tests — depend on the (mocked-in-tests) client.
7. `server.ts` — first point where a manual *live* smoke test against the real instance
   makes sense (`node dist/server.js`, or via `claude mcp add` + a live prompt).
8. `npm run verify` fully green.
9. Hook (§7) — add and prove it (deliberate break → block → fix → pass).
10. Install packaging (§8) — test on this repo, then stretch-goal install into a second,
    unrelated project.
11. Sub-agent review (§6) — run last, consolidate `REVIEW.md`, commit.
12. First real commit — already gated by the hook from step 9.

---

## Verification (end-to-end, definition of done)

- `npm test` passes in full from a clean clone.
- The hook demonstrably blocks a broken commit (exit 2 + clear message) and allows a good
  one — keep the transcript.
- `REVIEW.md` exists at repo root with real, specific, file:line findings from all three
  reviewers (not placeholder text) — including the two accepted-risk security notes from
  §6.
- A clean clone can install with one command and show up in `claude mcp list`.
- Live sanity check: ask Claude Code (with the `orchardcore` MCP server registered) to list
  the first 5 content items of an allowed type, create a test draft item, and search for it
  — confirm it appears, confirm it's a draft (not published) in the OrchardCore admin.
- Only `list_content`, `create_content`, `search_content_by_type` are exposed — no other
  tool was added.
- Nothing touches OrchardCore's database layer directly, its auth system's internals, or
  includes a UI — the translator only ever talks over the REST/GraphQL HTTP surface mapped
  in §1/§3.

### Critical files
- `orchardcore-mcp-translator/src/orchardcore-client.ts`
- `orchardcore-mcp-translator/src/schemas.ts`
- `orchardcore-mcp-translator/src/tools/create-content.ts`
- `orchardcore-mcp-translator/.claude/hooks/guard-git-commit-push.mjs`
- `orchardcore-mcp-translator/setup/mcp-translator-setup.recipe.json`
- `OrchardCore/src/OrchardCore.Modules/OrchardCore.Contents/Endpoints/Api/CreateEndpoint.cs`
  (reference for the draft/publish permission behavior the client must match)
