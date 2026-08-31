#!/usr/bin/env bash
# One-command install: builds this translator and registers it as an MCP
# server in a target project. Usage:
#   ./install.sh /path/to/target-project [--base-url URL] [--client-id ID] \
#       [--client-secret SECRET] [--content-types Type1,Type2]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TARGET_DIR="${1:-}"
if [[ -z "$TARGET_DIR" ]]; then
  echo "Usage: $0 /path/to/target-project [--base-url URL] [--client-id ID] [--client-secret SECRET] [--content-types Type1,Type2]" >&2
  exit 1
fi
shift || true

if [[ ! -d "$TARGET_DIR" ]]; then
  echo "Target project directory does not exist: $TARGET_DIR" >&2
  exit 1
fi
TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"

BASE_URL=""
CLIENT_ID=""
CLIENT_SECRET=""
CONTENT_TYPES=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url) BASE_URL="$2"; shift 2 ;;
    --client-id) CLIENT_ID="$2"; shift 2 ;;
    --client-secret) CLIENT_SECRET="$2"; shift 2 ;;
    --content-types) CONTENT_TYPES="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

fail() { echo "install.sh: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "node is required (>=18) but was not found on PATH."
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  fail "node >=18 is required, found $(node -v)."
fi
command -v npm >/dev/null 2>&1 || fail "npm is required but was not found on PATH."
# The claude CLI is optional, not required — register-mcp-server.mjs falls
# back to writing .mcp.json directly when it's absent (e.g. VS Code
# extension-only setups, which don't expose a standalone claude binary).

echo "==> Installing dependencies and building the translator..."
npm install
npm run build

ENV_FILE="$SCRIPT_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
  if [[ -n "$BASE_URL" ]]; then sed -i.bak "s#^ORCHARDCORE_BASE_URL=.*#ORCHARDCORE_BASE_URL=$BASE_URL#" "$ENV_FILE" && rm -f "$ENV_FILE.bak"; fi
  if [[ -n "$CLIENT_ID" ]]; then sed -i.bak "s#^ORCHARDCORE_CLIENT_ID=.*#ORCHARDCORE_CLIENT_ID=$CLIENT_ID#" "$ENV_FILE" && rm -f "$ENV_FILE.bak"; fi
  if [[ -n "$CLIENT_SECRET" ]]; then sed -i.bak "s#^ORCHARDCORE_CLIENT_SECRET=.*#ORCHARDCORE_CLIENT_SECRET=$CLIENT_SECRET#" "$ENV_FILE" && rm -f "$ENV_FILE.bak"; fi
  if [[ -n "$CONTENT_TYPES" ]]; then sed -i.bak "s#^ORCHARDCORE_ALLOWED_CONTENT_TYPES=.*#ORCHARDCORE_ALLOWED_CONTENT_TYPES=$CONTENT_TYPES#" "$ENV_FILE" && rm -f "$ENV_FILE.bak"; fi
fi

if ! grep -q '^ORCHARDCORE_CLIENT_SECRET=.\+' "$ENV_FILE"; then
  echo ""
  echo "A fresh .env was created at: $ENV_FILE"
  echo "Fill in these required values, then re-run this script:"
  echo "  ORCHARDCORE_BASE_URL"
  echo "  ORCHARDCORE_CLIENT_ID"
  echo "  ORCHARDCORE_CLIENT_SECRET"
  echo "  ORCHARDCORE_ALLOWED_CONTENT_TYPES"
  echo "See SETUP-ORCHARDCORE.md for how to obtain these."
  exit 1
fi

echo "==> Registering the orchardcore-cms MCP server in: $TARGET_DIR"
node "$SCRIPT_DIR/scripts/register-mcp-server.mjs" "$TARGET_DIR"

if command -v claude >/dev/null 2>&1; then
  echo "==> Verifying registration..."
  (
    cd "$TARGET_DIR"
    if claude mcp list | grep -q "orchardcore-cms"; then
      echo "orchardcore-cms is registered."
    else
      fail "orchardcore-cms did not appear in 'claude mcp list' after registration."
    fi
  )
fi

cat <<EOF

Install complete. Try this in a Claude Code session inside $TARGET_DIR:

  "Use the orchardcore-cms MCP server to list the first 5 content items."

EOF
