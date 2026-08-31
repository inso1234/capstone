#!/usr/bin/env node
// Registers this translator as an MCP server in a target project.
//
// Prefers `claude mcp add` when the Claude Code CLI is on PATH (the
// documented, officially supported path). When it isn't — which is the
// normal case for a VS Code-extension-only install, since the extension
// doesn't expose a standalone `claude` binary — this falls back to writing
// (or merging into) a project-level .mcp.json directly, using the same
// schema the CLI itself would produce.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const targetDir = process.argv[2];
if (!targetDir) {
  console.error("Usage: register-mcp-server.mjs <target-project-dir>");
  process.exit(1);
}
if (!existsSync(targetDir)) {
  console.error(`Target project directory does not exist: ${targetDir}`);
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "..", "dist", "server.js");
if (!existsSync(serverPath)) {
  console.error(`Built server not found at ${serverPath} — run "npm run build" first.`);
  process.exit(1);
}

function hasClaudeCli() {
  // Invoke `claude` directly rather than shelling out to where/which — the
  // latter can hang indefinitely in some shells (observed in Git Bash on
  // Windows) instead of failing fast when the target isn't found. A missing
  // binary throws synchronously with code ENOENT; a timeout guards against
  // any other unexpected hang.
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function registerViaCli() {
  console.log("Found the claude CLI — registering via `claude mcp add`.");
  execFileSync(
    "claude",
    ["mcp", "add", "--transport", "stdio", "--scope", "local", "orchardcore-cms", "--", "node", serverPath],
    { cwd: targetDir, stdio: "inherit" },
  );
  console.log("Registered. Run \"claude mcp list\" to confirm.");
}

function registerViaMcpJson() {
  console.log(
    "claude CLI not found on PATH (expected for VS Code-extension-only setups) — writing .mcp.json directly.",
  );
  const mcpJsonPath = path.join(targetDir, ".mcp.json");
  let config = { mcpServers: {} };

  if (existsSync(mcpJsonPath)) {
    try {
      config = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
    } catch {
      console.error(
        `Existing .mcp.json at ${mcpJsonPath} is not valid JSON — refusing to overwrite it. Fix or remove it and retry.`,
      );
      process.exit(1);
    }
    config.mcpServers ??= {};
  }

  config.mcpServers["orchardcore-cms"] = {
    type: "stdio",
    command: "node",
    args: [serverPath.split(path.sep).join("/")],
  };

  writeFileSync(mcpJsonPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Wrote ${mcpJsonPath}.`);
  console.log(
    `Next: (re)start your Claude Code session with ${targetDir} open as the project, and approve the trust prompt for this .mcp.json when it appears.`,
  );
}

if (hasClaudeCli()) {
  registerViaCli();
} else {
  registerViaMcpJson();
}
