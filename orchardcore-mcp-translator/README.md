# orchardcore-mcp-translator

An MCP server that lets Claude Code read and create content inside a running [OrchardCore](https://www.orchardcore.net/)
instance through exactly three tools — `list_content`, `create_content`,
`search_content_by_type` — via a dedicated, least-privilege service identity. It never uses
the admin account, never edits or deletes existing content, and never publishes anything
(`create_content` always creates an unpublished draft).

## Prerequisites

- Node.js >= 18
- The [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) (`claude`)
- A running OrchardCore instance, set up per [SETUP-ORCHARDCORE.md](./SETUP-ORCHARDCORE.md)
  (a dedicated `McpTranslator` role + OpenID client, automated via recipe)

## Install (one command)

```bash
./install.sh /path/to/your/project
```

```powershell
.\install.ps1 -TargetProjectDir C:\path\to\your\project
```

This builds the translator, prompts you to fill in `.env` on first run (or accepts
`--base-url` / `--client-id` / `--client-secret` / `--content-types` flags for a fully
non-interactive install), registers it with `claude mcp add --scope local` inside the
target project, and verifies the registration with `claude mcp list` — no manual JSON
editing required.

Works for any project, not just this one — the translator only ever talks to OrchardCore
over HTTP, never to the filesystem of whatever project Claude Code happens to be running in.

## Verify the install

```bash
claude mcp list
```

You should see `orchardcore-cms` listed. Then, in a Claude Code session inside the target
project, try:

> Use the orchardcore-cms MCP server to list the first 5 content items.

## Tools

| Tool | What it does | What it can't do |
|---|---|---|
| `list_content` | Lists content items, optionally filtered by content type, with pagination and publication status. Fans out across all allow-listed types when no type is given. | Create, edit, publish, or delete anything. |
| `search_content_by_type` | Searches a single allow-listed content type for items whose display text contains a search term. | Search across types in one call; create, edit, publish, or delete anything. |
| `create_content` | Creates a new content item of an allow-listed type as an **unpublished draft**. | Publish, edit existing content, or delete anything — and cannot be made to publish even by a caller trying to pass `draft`/`publish` in the request. |

All three tools only operate on content types listed in `ORCHARDCORE_ALLOWED_CONTENT_TYPES`.

## Configuration

See [.env.example](./.env.example) for every environment variable. Required:
`ORCHARDCORE_BASE_URL`, `ORCHARDCORE_CLIENT_ID`, `ORCHARDCORE_CLIENT_SECRET`,
`ORCHARDCORE_ALLOWED_CONTENT_TYPES`.

## Development

```bash
npm install
npm run verify   # typecheck + lint + test — same check the pre-commit hook runs
npm run build
npm start         # runs dist/server.js over stdio
```

A `.claude/hooks/guard-git-commit-push.mjs` PreToolUse hook blocks `git commit`/`git push`
if `npm run verify` fails, and three read-only subagents
(`.claude/agents/{security,performance,style}-reviewer.md`) are available to review this
codebase; their consolidated findings live in [REVIEW.md](./REVIEW.md).

## Troubleshooting

- **`OrchardCoreAuthError`** — check the `McpTranslator` OpenID application's client
  id/secret and that the Client Credentials flow is enabled (both the per-application and
  server-level toggles).
- **`ContentTypeNotAllowedError` / `OrchardCoreForbiddenError`** — check
  `ORCHARDCORE_ALLOWED_CONTENT_TYPES` matches the `ViewOwn_<Type>`/`PublishOwn_<Type>`
  grants on the `McpTranslator` role (see [SETUP-ORCHARDCORE.md](./SETUP-ORCHARDCORE.md)).
- **`OrchardCoreNetworkError`** — check `ORCHARDCORE_BASE_URL` and that the OrchardCore app
  is actually running.
