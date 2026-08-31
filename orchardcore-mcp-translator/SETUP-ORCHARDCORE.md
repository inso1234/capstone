# OrchardCore-side setup

This translator needs a **dedicated, least-privilege** identity in OrchardCore — never the
admin account. Setup is automated via an OrchardCore recipe.

## 1. One-time manual prerequisite

In the running OrchardCore admin UI, enable the **`OrchardCore.Deployment`** feature
(Configuration → Features). This is what makes recipe-import possible on an
already-running tenant; everything else below is automated.

## 2. Prepare the recipe

Copy `setup/mcp-translator-setup.recipe.json.example` to
`setup/mcp-translator-setup.recipe.json` (gitignored — it holds a plaintext client secret
that OrchardCore/OpenIddict hashes on save, so plaintext only ever lives in this local
file and in transit). Edit it:

- Replace `ClientSecret` with a strong generated value.
- Replace every `ViewOwn_BlogPost` / `PublishOwn_BlogPost` pair with one pair per content
  type you're putting in `ORCHARDCORE_ALLOWED_CONTENT_TYPES` (e.g. `ViewOwn_Article`,
  `PublishOwn_Article`).

## 3. Import the recipe

Admin → Deployment Plans → Import → **Import from a recipe file** → paste the JSON → Run.
This executes immediately against the running tenant (only a shell reload, no restart).

The recipe:
- Enables `OrchardCore.Apis.GraphQL`, `OrchardCore.OpenId.Server`,
  `OrchardCore.OpenId.Validation`.
- Creates the `McpTranslator` role, granted only: `AccessContentApi`, `ExecuteGraphQL`, and
  `ViewOwn_<Type>` / `PublishOwn_<Type>` per allow-listed content type. **Not** granted:
  `ExecuteGraphQLMutations`, `EditContent`, `DeleteContent`, or the global
  `ViewContent`/`PublishContent`.
- Enables the OpenID token endpoint and the Client Credentials flow.
- Registers a confidential OpenID application (`mcp-translator`) assigned to the
  `McpTranslator` role.

### Why `PublishOwn_<Type>` is granted even though this translator never publishes

OrchardCore's content-creation endpoint (`POST /api/content`) requires the `PublishContent`
permission for **any** brand-new item, even when the request asks for a draft
(`?draft=true`) — there's no separate "create draft only" permission tier. So the
`McpTranslator` role technically *can* publish these content types. The translator's own
code never exercises that: `create_content` always sends `?draft=true`, hardcoded, with no
parameter that could flip it. This is a known OrchardCore permission-model limitation, not
a translator bug — see `REVIEW.md`'s security section for the same note.

## 4. Verify content types exist

Confirm each type in `ORCHARDCORE_ALLOWED_CONTENT_TYPES` actually exists under
Content Definition. Create them first if not.

## 5. Manual sanity checks before running the translator

```bash
# 1. Get a token
curl -X POST "$BASE_URL/connect/token" \
  -d "grant_type=client_credentials&client_id=mcp-translator&client_secret=$SECRET"
# expect: 200, { "access_token": "...", ... }

# 2. Query GraphQL (substitute your allow-listed type, camelCased)
curl -X POST "$BASE_URL/api/graphql" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"query { blogPost(first: 1) { contentItemId displayText } }"}'
# expect: 200, { "data": { "blogPost": [...] } }

# 3. Create a draft
curl -X POST "$BASE_URL/api/content?draft=true" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"contentType":"BlogPost","displayText":"test"}'
# expect: 200, the created (unpublished) item
```

If any of these fail, recheck the role's permission grants and the OpenID application's
Client Credentials flow toggle (both the per-application and server-level toggles must be
on) before moving on to the translator itself.
