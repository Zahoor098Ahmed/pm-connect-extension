const { execSync } = require("child_process");

function run(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: "utf8" }).trim();
}

function push(cwd) {
  run("git push", cwd);
}

function currentCommitSha(cwd) {
  return run("git rev-parse HEAD", cwd);
}

function latestCommitMessage(cwd) {
  return run("git log -1 --pretty=%s", cwd);
}

/**
 * Number of commits landed since `sinceSha` (exclusive) up to HEAD.
 * If `sinceSha` is unknown (first push tracked for this task), counts as 1
 * so the very first push still moves the needle.
 */
function newCommitsSince(cwd, sinceSha) {
  if (!sinceSha) return 1;
  const count = run(`git rev-list --count ${sinceSha}..HEAD`, cwd);
  const n = parseInt(count, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Detail (sha + message) of every commit landed since `sinceSha` (exclusive)
 * up to HEAD, newest first, capped so a big `git pull` can't flood the
 * automatic commit-heartbeat tracker. Requires a known `sinceSha` — first-run
 * seeding (no prior sha) is the caller's job via `currentCommitSha`, so a
 * fresh install on an existing repo never reports its entire past history.
 */
function newCommitsDetail(cwd, sinceSha, limit = 20) {
  if (!sinceSha) return [];
  const output = run(`git log --format=%H%x1f%s -n ${limit} ${sinceSha}..HEAD`, cwd);
  if (!output) return [];
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, message] = line.split("\x1f");
      return { sha, message: message ?? "" };
    });
}

/**
 * File paths touched by a single commit — this is what lets the daily work
 * summary say "worked on Home Page" automatically, just from which files
 * changed (e.g. home.php, home.css), without the developer describing
 * anything beyond their normal commit message. Capped so a huge merge
 * commit can't balloon the payload.
 */
function changedFiles(cwd, sha, limit = 30) {
  try {
    const output = run(`git show --name-only --format= ${sha}`, cwd);
    if (!output) return [];
    return output.split("\n").filter(Boolean).slice(0, limit);
  } catch {
    return [];
  }
}

function gitUserEmail(cwd) {
  try {
    return run("git config user.email", cwd);
  } catch {
    return "";
  }
}

function gitRemoteOriginUrl(cwd) {
  try {
    return run("git config --get remote.origin.url", cwd);
  } catch {
    return "";
  }
}

/**
 * Returns list of modified, added, or untracked file paths in the working tree.
 */
function getUncommittedFiles(cwd, limit = 50) {
  try {
    const output = run("git status --porcelain", cwd);
    if (!output) return [];
    const files = [];
    const lines = output.split("\n");
    for (const line of lines) {
      if (!line || !line.trim()) continue;
      let filePath = line.replace(/^[A-Za-z?!\s]{1,2}\s+/, "").trim();
      if (filePath.includes(" -> ")) {
        filePath = filePath.split(" -> ")[1].trim();
      }
      if (filePath.startsWith('"') && filePath.endsWith('"')) {
        filePath = filePath.slice(1, -1);
      }
      filePath = filePath.replace(/\\/g, "/");
      if (filePath) {
        files.push(filePath);
        if (files.length >= limit) break;
      }
    }
    return files;
  } catch {
    return [];
  }
}

module.exports = {
  push,
  currentCommitSha,
  latestCommitMessage,
  newCommitsSince,
  newCommitsDetail,
  changedFiles,
  gitUserEmail,
  gitRemoteOriginUrl,
  getUncommittedFiles,
};
