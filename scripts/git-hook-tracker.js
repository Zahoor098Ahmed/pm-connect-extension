#!/usr/bin/env node
/**
 * PM Connect Standalone Git Hook Tracker
 *
 * Runs automatically on 'git commit' (via .git/hooks/post-commit).
 * Ensures that commits made from ANY editor or terminal immediately update
 * BACKLOG.md even if VS Code or an IDE is NOT currently running!
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT_DIR = path.resolve(__dirname, "..");
const { appendCommit } = require(path.join(ROOT_DIR, "src", "backlogFile"));

function trackCurrentCommit(projectDir) {
  try {
    const rawCommit = execSync("git log -1 --format=%H%x1f%s%x1f%aI", {
      cwd: projectDir,
      encoding: "utf8",
      timeout: 5000,
    }).trim();

    if (!rawCommit) return;

    const [sha, message, isoTime] = rawCommit.split("\x1f");
    if (!sha) return;

    // Get list of changed files
    let files = [];
    try {
      const filesRaw = execSync(`git diff-tree --no-commit-id --name-only -r ${sha}`, {
        cwd: projectDir,
        encoding: "utf8",
        timeout: 5000,
      }).trim();
      if (filesRaw) {
        files = filesRaw.split("\n").map((f) => f.trim().replace(/\\/g, "/")).filter(Boolean);
      }
    } catch {
      files = [];
    }

    const folder = {
      name: path.basename(projectDir),
      uri: { fsPath: projectDir },
    };

    if (process.env.PM_CONNECT_INCLUDE_COMMITS_IN_BACKLOG === "true") {
      appendCommit(folder, {
        commitSha: sha,
        commitMessage: message || "Commit",
        filesChanged: files,
        timestamp: isoTime || new Date().toISOString(),
      });
      console.log(`[PM Connect] 🌿 Recorded commit [${sha.slice(0, 7)}] in BACKLOG.md`);
    }
  } catch (err) {
    // Silent — git commit must never fail due to tracking
  }
}

const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
trackCurrentCommit(targetDir);
