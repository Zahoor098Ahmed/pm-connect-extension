#!/usr/bin/env node
/**
 * Installs PM Connect's post-commit hook into a target Git repository.
 * Usage: node scripts/setup-git-hook.js [path/to/project]
 */

const fs = require("fs");
const path = require("path");

const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const gitDir = path.join(targetDir, ".git");

if (!fs.existsSync(gitDir)) {
  console.error(`[ERROR] No .git directory found at: ${targetDir}`);
  process.exit(1);
}

const hooksDir = path.join(gitDir, "hooks");
if (!fs.existsSync(hooksDir)) {
  fs.mkdirSync(hooksDir, { recursive: true });
}

const hookScriptPath = path.resolve(__dirname, "git-hook-tracker.js").replace(/\\/g, "/");
const postCommitPath = path.join(hooksDir, "post-commit");

const hookContent = `#!/bin/sh
# PM Connect automatic commit hook
node "${hookScriptPath}" "\$(pwd)" >/dev/null 2>&1 || true
`;

fs.writeFileSync(postCommitPath, hookContent, { mode: 0o755 });
console.log(`✅ PM Connect git hook successfully installed in: ${postCommitPath}`);
console.log("Any git commits in this project will now automatically update BACKLOG.md even without VS Code!");
