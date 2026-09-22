const { fetchWithRetry } = require("./httpUtil");

const GITHUB_API = "https://api.github.com";

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "pm-connect-vscode-extension",
  };
}

/**
 * Finds the most recently updated open issue (or PR — GitHub treats PRs as
 * issues for the comments API) in `owner/repo`, so a quick status comment has
 * somewhere to land without the developer having to pick one.
 */
async function getLatestOpenIssue(token, repo) {
  const url = `${GITHUB_API}/repos/${repo}/issues?state=open&sort=updated&direction=desc&per_page=1`;
  const res = await fetchWithRetry(url, { method: "GET", headers: githubHeaders(token) });
  if (!res.ok) {
    throw new Error(`GitHub API error listing issues: HTTP ${res.status}`);
  }
  const issues = await res.json();
  return Array.isArray(issues) && issues.length > 0 ? issues[0] : null;
}

/**
 * Posts a comment on the given issue/PR number.
 */
async function postComment(token, repo, issueNumber, body) {
  const url = `${GITHUB_API}/repos/${repo}/issues/${issueNumber}/comments`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: githubHeaders(token),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    throw new Error(`GitHub API error posting comment: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Fetches the most recent comments on that same issue/PR, used to confirm
 * the just-posted comment actually landed.
 */
async function fetchRecentComments(token, repo, issueNumber, perPage = 5) {
  const url = `${GITHUB_API}/repos/${repo}/issues/${issueNumber}/comments?sort=created&direction=desc&per_page=${perPage}`;
  const res = await fetchWithRetry(url, { method: "GET", headers: githubHeaders(token) });
  if (!res.ok) {
    throw new Error(`GitHub API error fetching comments: HTTP ${res.status}`);
  }
  return res.json();
}

module.exports = { getLatestOpenIssue, postComment, fetchRecentComments };
