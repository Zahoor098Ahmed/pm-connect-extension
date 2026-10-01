const vscode = require("vscode");
const gitProgress = require("./gitProgress");
const { shouldFallbackPoll } = require("./trackerUtils");
const { syncManager } = require("./syncManager");
const { activityLog } = require("./activityLog");
const { appendCommit } = require("./backlogFile");

const FALLBACK_POLL_INTERVAL_MS = 30 * 1000;

/**
 * Silently, automatically detects new git commits for a workspace folder and
 * reports each one to the backend as a "commit heartbeat" — no developer
 * interaction. Uses VS Code's built-in Git extension when available (fires
 * immediately on commit), plus a 5-minute interval poll as a fallback for
 * commits made outside VS Code (e.g. from an external terminal) or when the
 * Git extension API isn't available at all (restricted/remote environments).
 *
 * Returns a disposable (or undefined if nothing could be started), meant for
 * `context.subscriptions`.
 */
function startCommitTracking(folder, context, providerContext, getActiveProvider) {
  const rootCwd = folder?.uri?.fsPath;
  if (!rootCwd) return undefined;

  const output = getOutputChannel();
  const lastSeenKey = (cwd) => {
    const projectId = providerContext.getConfig("pmConnect.custom.projectId", "");
    return `pmConnect.lastSeenSha.${projectId}.${cwd}`;
  };

  let disposed = false;
  // Tracked per git-repo root, not just the workspace-folder root — the
  // actual .git can live in a subfolder (e.g. a "frontend" sub-project),
  // where VS Code's own Git extension discovers it but a naive cwd-at-root
  // shell-out never would.
  const knownCwds = new Set();
  const lastPolledAtByCwd = new Map();

  function getLastSeenSha(cwd) {
    return context.workspaceState.get(lastSeenKey(cwd));
  }
  async function setLastSeenSha(cwd, sha) {
    await context.workspaceState.update(lastSeenKey(cwd), sha);
  }

  async function seedIfNeeded(cwd) {
    if (getLastSeenSha(cwd) !== undefined) return;
    try {
      const head = gitProgress.currentCommitSha(cwd);
      await setLastSeenSha(cwd, head);
    } catch (err) {
      output.appendLine(`[commitTracker] seed failed for ${cwd}: ${err.message}`);
    }
  }

  async function checkForNewCommits(cwd) {
    if (disposed) return;
    lastPolledAtByCwd.set(cwd, Date.now());
    try {
      await seedIfNeeded(cwd);
      const sinceSha = getLastSeenSha(cwd);
      const commits = gitProgress.newCommitsDetail(cwd, sinceSha);
      // Oldest first, so lastSeenSha only advances past commits we've
      // actually confirmed with the backend — a mid-batch failure doesn't
      // lose already-reported commits.
      for (const commit of commits.reverse()) {
        try {
          const files = gitProgress.changedFiles(cwd, commit.sha);
          const configuredId = providerContext.getConfig("pmConnect.custom.projectId", "");
          const isConnected = !!(configuredId && !/^EMP\d+$/i.test(configuredId));
          const projectId = isConnected ? String(configuredId) : (folder?.name || "Local");

          // Record unified activity log entry
          const logEntry = activityLog.recordCommit({
            projectId,
            commitSha: commit.sha,
            commitMessage: commit.message,
            filesChanged: files,
            timestamp: new Date().toISOString(),
          });

          syncManager.log(
            `[LOG ENTRY] 🌿 Commit detected: [${commit.sha.slice(0, 7)}] "${commit.message.split("\n")[0]}" - Project ${projectId} - Pages changed (${files.length}): [${files.join(", ") || "None"}]`,
            {
              type: "commit",
              title: `Commit [${commit.sha.slice(0, 7)}]: ${commit.message.split("\n")[0]}`,
              detail: `Project: ${projectId}\nSHA: ${commit.sha}\nPages/Files changed (${files.length}):\n${files.map((f) => ` • ${f}`).join("\n") || " (no files)"}`,
              status: "success",
            }
          );

          // Append to this project's BACKLOG.md
          try {
            appendCommit(folder, {
              commitSha: commit.sha,
              commitMessage: commit.message,
              filesChanged: files,
              timestamp: new Date().toISOString(),
            });
          } catch {
            /* silent */
          }

          if (isConnected) {
            const provider = getActiveProvider();
            const heartbeatResult = await provider.logCommitHeartbeat(
              { commitSha: commit.sha, commitMessage: commit.message, filesChanged: files },
              providerContext
            );

            if (typeof provider.logActivityEntry === "function") {
              try {
                await provider.logActivityEntry(logEntry, providerContext);
              } catch {
                /* silent */
              }
            }

            await setLastSeenSha(cwd, commit.sha);

            // sendLogWithQueueFallback never throws on backend failure — it
            // resolves { success: true, queued: true } instead — so the only
            // way to tell "actually delivered" from "parked offline" is this flag.
            if (heartbeatResult?.queued) {
              vscode.window.showInformationMessage(
                "⏳ Backend unreachable — your commit was saved locally and will sync to Project Management automatically."
              );
            } else {
              vscode.window.showInformationMessage("✅ Your code update was added to Project Management.");
            }
          } else {
            await setLastSeenSha(cwd, commit.sha);
          }
        } catch (err) {
          output.appendLine(`[commitTracker] heartbeat failed for ${commit.sha}: ${err.message}`);
          await setLastSeenSha(cwd, commit.sha);
          vscode.window.showWarningMessage(
            `⚠️ Could not report commit ${commit.sha.slice(0, 7)} to Project Management: ${err.message}`
          );
        }
      }
    } catch (err) {
      // Not a git repo, git not on PATH, etc. — silent, no dialogs.
      output.appendLine(`[commitTracker] check failed for ${cwd}: ${err.message}`);
    }
  }

  async function checkAllKnownCwds() {
    for (const cwd of knownCwds) await checkForNewCommits(cwd);
  }

  const disposables = [];

  try {
    const gitExt = vscode.extensions.getExtension("vscode.git");
    if (gitExt) {
      void (async () => {
        try {
          const activated = gitExt.isActive ? gitExt.exports : (await gitExt.activate());
          const api = activated.getAPI(1);

          const normRoot = rootCwd.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
          const subscribeToRepo = (repo) => {
            const repoCwd = repo.rootUri?.fsPath;
            if (!repoCwd) return;
            const normRepo = repoCwd.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
            // Strictly track only if repository is inside or equal to this folder's root
            if (normRepo !== normRoot && !normRepo.startsWith(normRoot + "/")) {
              return;
            }
            knownCwds.add(repoCwd);
            disposables.push(repo.state.onDidChange(() => void checkForNewCommits(repoCwd)));
            void checkForNewCommits(repoCwd);
          };
          for (const repo of api.repositories) subscribeToRepo(repo);
          disposables.push(api.onDidOpenRepository(subscribeToRepo));
        } catch (err) {
          output.appendLine(`[commitTracker] vscode.git API unavailable: ${err.message}`);
        }
      })();
    }
  } catch (err) {
    output.appendLine(`[commitTracker] vscode.git extension lookup failed: ${err.message}`);
  }

  // Always also track the workspace-folder root itself, in case the Git
  // extension is unavailable/restricted or hasn't discovered the repo yet.
  knownCwds.add(rootCwd);

  // Fallback poll — always runs regardless of whether the Git API hooked up,
  // so terminal-made commits and restricted environments are still covered.
  const intervalId = setInterval(() => {
    for (const cwd of knownCwds) {
      if (shouldFallbackPoll(lastPolledAtByCwd.get(cwd), Date.now(), FALLBACK_POLL_INTERVAL_MS)) {
        void checkForNewCommits(cwd);
      }
    }
  }, FALLBACK_POLL_INTERVAL_MS);

  void checkAllKnownCwds();

  return {
    dispose() {
      disposed = true;
      clearInterval(intervalId);
      for (const d of disposables) d.dispose?.();
    },
  };
}

let sharedOutputChannel;
function getOutputChannel() {
  if (!sharedOutputChannel) {
    sharedOutputChannel = vscode.window.createOutputChannel("PM Connect");
  }
  return sharedOutputChannel;
}

module.exports = { startCommitTracking, shouldFallbackPoll };
