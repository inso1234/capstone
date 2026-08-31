#!/usr/bin/env node
// PreToolUse hook: intercepts `git commit` / `git push` invoked via the Bash
// tool and blocks them (exit 2) unless `npm run verify` (typecheck + lint +
// test) passes. Any other Bash command is a fast no-op (exit 0, no output).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const GIT_COMMIT_OR_PUSH = /(^|[;&|]\s*)git\s+(commit|push)\b/;

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // No parseable payload — nothing to gate on, let it through.
    process.exit(0);
  }

  if (payload.tool_name !== "Bash") {
    process.exit(0);
  }

  const command = payload.tool_input?.command ?? "";
  if (!GIT_COMMIT_OR_PUSH.test(command)) {
    process.exit(0);
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..", "..");

  const result = spawnSync("npm", ["run", "verify"], {
    cwd: repoRoot,
    encoding: "utf-8",
    shell: true,
  });

  if (result.error) {
    process.stderr.write(
      `Could not run "npm run verify" in ${repoRoot} before allowing "${command}".\n` +
        `Setup problem (not a test/lint failure): ${result.error.message}\n` +
        `Run "npm install" in the translator repo, then retry.\n`,
    );
    process.exit(2);
  }

  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const tail = output.length > 4000 ? `...\n${output.slice(-4000)}` : output;
    process.stderr.write(
      `Blocked "${command}": "npm run verify" failed in ${repoRoot}.\n` +
        `Fix the failure below, then retry the commit/push.\n\n${tail}\n`,
    );
    process.exit(2);
  }

  process.exit(0);
}

main();
