const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createProviderContext } = require("./providerContext");
const { getActiveProviderId, getProvider, PROVIDERS } = require("./providers");
const { TasksTreeDataProvider } = require("./tasksTreeView");
const { ReportsTreeDataProvider } = require("./reportsTreeView");
const { PmConnectStatusBar } = require("./statusBar");
const { ProviderError } = require("./providerError");
const { readProjectConfig, writeProjectConfig, CONFIG_FILENAME } = require("./projectConfig");
const { startCommitTracking } = require("./commitTracker");
const { startActivityTracking, getCurrentSessionFiles } = require("./activityTracker");
const { gitUserEmail, gitRemoteOriginUrl } = require("./gitProgress");
const { offlineQueue } = require("./offlineQueue");
const { dailySummaryTracker } = require("./dailySummaryTracker");
const { activityLog } = require("./activityLog");
const { syncManager } = require("./syncManager");
const { ActivityLogsTreeDataProvider } = require("./activityLogsTreeView");
const { activityLogStore } = require("./activityLogStore");
const { backendResolver } = require("./backendResolver");
const { getLatestOpenIssue, postComment, fetchRecentComments } = require("./githubComments");
const { ensureBacklogFile, getTimeSummaryFromBacklog } = require("./backlogFile");
const { syncedTimeTracker } = require("./syncedTimeTracker");

const EMPLOYEE_ID_PATTERN = /^EMP\d+$/i;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const providerContext = createProviderContext(context);
  const activeWorkspaceFolder = vscode.workspace.workspaceFolders?.[0];

  // Workspace-isolated storage: each workspace gets its own private storage directory!
  const storageDir = context.storageUri?.fsPath || context.globalStorageUri?.fsPath || context.extensionPath;
  if (context.storageUri?.fsPath && !fs.existsSync(storageDir)) {
    try {
      fs.mkdirSync(storageDir, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  offlineQueue.init(storageDir);
  dailySummaryTracker.init(storageDir);
  syncedTimeTracker.init(storageDir);
  activityLog.init(storageDir);
  activityLogStore.init(storageDir);

  function getActiveProjectId() {
    const configured = providerContext.getConfig("pmConnect.custom.projectId", "");
    if (configured && !EMPLOYEE_ID_PATTERN.test(configured)) {
      return String(configured);
    }
    return activeWorkspaceFolder?.name || "";
  }

  // Unconditionally ensure BACKLOG.md is initialized for every open project folder right on activation!
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    ensureBacklogFile(folder);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const folder of e.added) {
        ensureBacklogFile(folder);
      }
      startTracking();
    })
  );

  const outputChannel = vscode.window.createOutputChannel("PM Connect");
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine(`[${new Date().toISOString().replace("T", " ").slice(0, 19)}] [PM Connect] Initialized. Offline queue & auto-sync ready.`);

  const activeProjId = getActiveProjectId();
  const rawTodayFiles = activeProjId ? activityLog.getTodayFiles(activeProjId) : [];
  // Strictly filter: only list files that actually belong to this workspace folder!
  const todayFilesOnStart = rawTodayFiles.filter((f) => {
    if (!f) return false;
    if (activeWorkspaceFolder) {
      const absPath = path.join(activeWorkspaceFolder.uri.fsPath, f);
      return fs.existsSync(absPath);
    }
    return false;
  });

  if (todayFilesOnStart.length > 0) {
    outputChannel.appendLine(
      `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] [TODAY'S WORK] 📋 ${todayFilesOnStart.length} file(s) modified today since morning:`
    );
    for (let i = 0; i < todayFilesOnStart.length; i++) {
      outputChannel.appendLine(`   ${i + 1}. ${todayFilesOnStart[i]}`);
    }
  }
  const treeDataProvider = new TasksTreeDataProvider();
  vscode.window.registerTreeDataProvider("pmConnectTasks", treeDataProvider);
  const reportsTreeDataProvider = new ReportsTreeDataProvider();
  vscode.window.registerTreeDataProvider("pmConnectReports", reportsTreeDataProvider);
  const activityLogsTreeDataProvider = new ActivityLogsTreeDataProvider();
  vscode.window.registerTreeDataProvider("pmConnectActivityLogs", activityLogsTreeDataProvider);
  const statusBar = new PmConnectStatusBar();
  context.subscriptions.push(statusBar);

  // Local-first, live-fallback: checks whether a local dev ERP is up every
  // 30s in the background; everything (commits, heartbeats, "Open Report",
  // sync) automatically targets whichever one is actually reachable, no
  // manual URL switching required.
  const backendResolverDisposable = backendResolver.startBackgroundRefresh(providerContext.getConfig);
  context.subscriptions.push(backendResolverDisposable);

  syncManager.init({
    outputChannel,
    statusBar,
    getProjectId: () => {
      const configured = providerContext.getConfig("pmConnect.custom.projectId", "");
      return configured && !EMPLOYEE_ID_PATTERN.test(configured) ? String(configured) : null;
    },
    getApiKey: () => providerContext.getSecret("pmConnect.custom.apiKey"),
    refreshAuthToken: () => tryAutoMatch(),
  });
  providerContext.refreshAuthToken = () => tryAutoMatch();
  context.subscriptions.push(syncManager);

  // Periodic 5-minute background sync
  syncManager.startPeriodicSync(() => {
    const providerId = getActiveProviderId(providerContext.getConfig);
    if (providerId === "custom") {
      return backendResolver.getCachedBaseUrl(providerContext.getConfig);
    }
    return null;
  });

  // Initial startup: check if this workspace is connected to a project
  const initialProjectId = providerContext.getConfig("pmConnect.custom.projectId", "");
  const initialConnected = !!(initialProjectId && !EMPLOYEE_ID_PATTERN.test(initialProjectId));
  if (initialConnected) {
    statusBar.setProject(initialProjectId);
    statusBar.setState("idle");
    syncManager.updateStatusBar(initialProjectId);
    void backendResolver.refresh(providerContext.getConfig).then((initialBaseUrl) => {
      void tryAutoMatch().then(() => {
        void syncManager.syncPendingLogs(initialBaseUrl);
      });
    });
  } else {
    statusBar.setProject("");
    statusBar.setState("disconnected");
    statusBar.setPendingCount(0);
    // Purge any stale dummy logs from non-connected workspace
    const pending = offlineQueue.getPending();
    const staleLogs = pending.filter((item) => item.projectId === "1" || !item.projectId);
    for (const item of staleLogs) {
      offlineQueue.remove(item.id);
    }
  }

  const activeProvider = () => getProvider(getActiveProviderId(providerContext.getConfig));

  async function withErrorHandling(fn) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof ProviderError ? err.message : `Unexpected error: ${err.message}`;
      const choice = await vscode.window.showErrorMessage(message, "Retry", "Open Settings");
      if (choice === "Retry") {
        return withErrorHandling(fn);
      }
      if (choice === "Open Settings") {
        await vscode.commands.executeCommand("pmConnect.openSettings");
      }
      return undefined;
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("pmConnect.connect", async () => {
      const providerId = getActiveProviderId(providerContext.getConfig);
      const provider = getProvider(providerId);

      if (providerId === "custom") {
        statusBar.setState("syncing");

        // 1. Silent baseUrl check - use existing or default, never prompt!
        let baseUrl = providerContext.getConfig("pmConnect.custom.baseUrl", "");
        if (!baseUrl) {
          baseUrl = "https://crm.tgailab.site/api/pmconnect";
          await vscode.workspace
            .getConfiguration()
            .update("pmConnect.custom.baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
        }

        // 2. Restore saved apiKey if needed
        let existingKey = await providerContext.getSecret("pmConnect.custom.apiKey");
        const lastSavedKey = context.workspaceState.get("pmConnect.lastConnectedApiKey");
        if (!existingKey && lastSavedKey) {
          await providerContext.setSecret("pmConnect.custom.apiKey", lastSavedKey);
          existingKey = lastSavedKey;
        }

        // 3. Try silent autoMatch
        await tryAutoMatch();

        let currentKey = await providerContext.getSecret("pmConnect.custom.apiKey");
        let currentProjId = providerContext.getConfig("pmConnect.custom.projectId", "");

        // 4. If no projectId from autoMatch, restore last connected projectId
        const lastSavedProjId = context.workspaceState.get("pmConnect.lastConnectedProjectId");
        if (!currentProjId && lastSavedProjId) {
          await vscode.workspace
            .getConfiguration()
            .update("pmConnect.custom.projectId", String(lastSavedProjId), vscode.ConfigurationTarget.Workspace);
          currentProjId = String(lastSavedProjId);
        }

        // 5. If still no projectId, auto create project
        if (!currentProjId) {
          await autoCreateProjectIfNeeded();
          currentProjId = providerContext.getConfig("pmConnect.custom.projectId", "");
        }

        // 6. If still no projectId, use workspace folder name as project link
        if (!currentProjId) {
          const folderName = vscode.workspace.workspaceFolders?.[0]?.name || "1";
          await vscode.workspace
            .getConfiguration()
            .update("pmConnect.custom.projectId", folderName, vscode.ConfigurationTarget.Workspace);
          currentProjId = folderName;
        }

        // 7. Ensure apiKey exists silently
        if (!currentKey) {
          const defaultKey = "dev-offline-key";
          await providerContext.setSecret("pmConnect.custom.apiKey", defaultKey);
        }

        startTracking();
        statusBar.setProject(currentProjId);
        statusBar.setState("idle");
        syncManager.updateStatusBar(currentProjId);
        vscode.window.showInformationMessage(`✅ PM Connect: Connected automatically to ERP (Project: ${currentProjId}).`);
        return;
      } else if (providerId === "trello") {
        const existingKey = await providerContext.getSecret("pmConnect.trello.apiKey");
        const apiKey = await vscode.window.showInputBox({
          prompt: existingKey ? "Trello API key (leave blank to keep the existing one)" : "Trello API key",
          ignoreFocusOut: true,
        });
        if (apiKey === undefined) return; // cancelled
        if (apiKey) {
          await providerContext.setSecret("pmConnect.trello.apiKey", apiKey);
        } else if (!existingKey) {
          vscode.window.showErrorMessage("A Trello API key is required to connect.");
          return;
        }

        const existingToken = await providerContext.getSecret("pmConnect.trello.token");
        const token = await vscode.window.showInputBox({
          prompt: existingToken ? "Trello token (leave blank to keep the existing one)" : "Trello token",
          password: true,
          ignoreFocusOut: true,
        });
        if (token === undefined) return; // cancelled
        if (token) {
          await providerContext.setSecret("pmConnect.trello.token", token);
        } else if (!existingToken) {
          vscode.window.showErrorMessage("A Trello token is required to connect.");
          return;
        }
      }
      // TODO: for Jira/Asana, launch an OAuth webview flow here instead of raw input boxes.

      const result = await withErrorHandling(() => provider.authenticate(providerContext));
      if (result?.success) {
        vscode.window.showInformationMessage(`Connected to ${provider.displayName}.`);
        await offerToShareSetup(providerId);
      } else if (result) {
        vscode.window.showErrorMessage(`Connection failed: ${result.message ?? "unknown error"}`);
      }
    })
  );

  /**
   * After a successful first connection, offer to save the non-secret
   * settings (base URL, project ID, board/list IDs) into a committed
   * pmconnect.config.json — so the next teammate who opens this repo only
   * has to paste their own personal API key, instead of re-typing everything.
   */
  async function offerToShareSetup(providerId) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;
    if (readProjectConfig(workspaceFolder)) return; // already shared

    const choice = await vscode.window.showInformationMessage(
      `Save these connection settings to ${CONFIG_FILENAME} so teammates can set up in one step (just their API key)?`,
      "Save for team",
      "No thanks"
    );
    if (choice !== "Save for team") return;

    const values = { "pmConnect.provider": providerId };
    if (providerId === "custom") {
      values["pmConnect.custom.baseUrl"] = providerContext.getConfig("pmConnect.custom.baseUrl", "");
      values["pmConnect.custom.projectId"] = providerContext.getConfig("pmConnect.custom.projectId", "");
    } else if (providerId === "trello") {
      values["pmConnect.trello.boardId"] = providerContext.getConfig("pmConnect.trello.boardId", "");
      values["pmConnect.trello.listId"] = providerContext.getConfig("pmConnect.trello.listId", "");
    }
    writeProjectConfig(workspaceFolder, values);
    vscode.window.showInformationMessage(
      `Saved to ${CONFIG_FILENAME} — commit this file so the rest of the team inherits it automatically.`
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("pmConnect.createTask", async () => {
      const editor = vscode.window.activeTextEditor;
      const selectionText = editor?.document.getText(editor.selection);
      const title = await vscode.window.showInputBox({ prompt: "Task title" });
      if (!title) return;

      await withErrorHandling(async () => {
        const provider = activeProvider();
        const taskPayload = { title, description: selectionText };

        // Employee-ID scoping (e.g. "EMP004") spans every project, so there's
        // no single project to create a task in — ask which one explicitly.
        const configuredProjectId = providerContext.getConfig("pmConnect.custom.projectId", "");
        if (provider.id === "custom" && /^EMP\d+$/i.test(configuredProjectId)) {
          const projects = await provider.listProjects(providerContext);
          const picked = await vscode.window.showQuickPick(
            projects.map((p) => ({ label: p.name, id: p.id })),
            { placeHolder: "Which project should this task be created in?" }
          );
          if (!picked) return;
          taskPayload.projectIdOverride = picked.id;
        }

        const task = await provider.createTask(taskPayload, providerContext);
        vscode.window.showInformationMessage(`Created task: ${task.title}`);
        await vscode.commands.executeCommand("pmConnect.viewMyTasks");
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pmConnect.syncProject", async () => {
      statusBar.setState("syncing");
      const baseUrl = backendResolver.getCachedBaseUrl(providerContext.getConfig);
      const syncedLogsCount = (await syncManager.syncPendingLogs(baseUrl)) || 0;

      // Accurately sync today's work and cumulative total work from BACKLOG.md to ERP
      const activeFolder = vscode.workspace.workspaceFolders?.[0];
      const timeSummary = getTimeSummaryFromBacklog(activeFolder);
      const currentProjId = providerContext.getConfig("pmConnect.custom.projectId", "") || activeFolder?.name || "";

      let syncedNewTimeMinutes = 0;
      let timeAlreadySynced = false;

      if (timeSummary && currentProjId) {
        const pendingItems = syncedTimeTracker.getPendingSyncItems(currentProjId, timeSummary.dateBreakdown || []);
        const unsyncedDeltaMinutes = pendingItems.reduce((acc, it) => acc + (it.unsyncedDelta || 0), 0);

        try {
          const provider = getProvider(getActiveProviderId(providerContext));
          if (provider && typeof provider.syncTimeSummary === "function") {
            const res = await provider.syncTimeSummary(
              {
                projectId: currentProjId,
                todayMinutes: timeSummary.todayMinutes,
                totalMinutes: timeSummary.totalMinutes,
                dateBreakdown: timeSummary.dateBreakdown,
                unsyncedDeltaMinutes,
              },
              providerContext,
              { baseUrl }
            );

            if (res && res.success && !res.skipped) {
              syncedTimeTracker.recordBatchSynced(currentProjId, timeSummary.dateBreakdown);
              syncedNewTimeMinutes = unsyncedDeltaMinutes;
              if (unsyncedDeltaMinutes > 0) {
                outputChannel.appendLine(
                  `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] [TIME SYNC] ✅ BACKLOG.md Time Synced to ERP: Today = ${timeSummary.todayMinutes}m (${timeSummary.todayHours}h) | Total (Start to Today) = ${timeSummary.totalMinutes}m (${timeSummary.totalHours}h) [+${unsyncedDeltaMinutes}m new across ${pendingItems.length} date(s)]`
                );
              } else {
                timeAlreadySynced = true;
                outputChannel.appendLine(
                  `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] [TIME SYNC] ℹ️ All BACKLOG.md time is calibrated in ERP (${timeSummary.todayMinutes}m today | ${timeSummary.totalMinutes}m total). No new delta.`
                );
              }
            }
          }
        } catch (err) {
          outputChannel.appendLine(`[TIME SYNC] ⚠️ Error syncing time to ERP: ${err.message}`);
        }
      }

      await refreshReports();

      const remaining = offlineQueue.getPendingCount();
      const todayHrs = timeSummary?.todayHours || "0.00";
      const totalHrs = timeSummary?.totalHours || "0.00";
      if (remaining === 0) {
        statusBar.setState("idle");
        if (syncedLogsCount === 0 && (timeAlreadySynced || syncedNewTimeMinutes === 0)) {
          vscode.window.showInformationMessage(
            `ℹ️ PM Connect: No new changes detected — all logs and tracked time are already up-to-date in ERP!\n• Today's Work: ${timeSummary?.todayMinutes || 0}m (${todayHrs} hrs)\n• Start to Today: ${timeSummary?.totalMinutes || 0}m (${totalHrs} hrs)`
          );
        } else {
          const newTimeMsg = syncedNewTimeMinutes > 0 ? ` (+${syncedNewTimeMinutes}m new time synced)` : "";
          vscode.window.showInformationMessage(
            `✅ Sync complete — all logs & time synced to ERP!${newTimeMsg}\n• Today's Work: ${timeSummary?.todayMinutes || 0}m (${todayHrs} hrs)\n• Start to Today: ${timeSummary?.totalMinutes || 0}m (${totalHrs} hrs)`
          );
        }
      } else {
        statusBar.setState("error", `${remaining} log(s) still pending — backend may be unreachable.`);
        vscode.window.showWarningMessage(`PM Connect: ${remaining} log(s) still pending, will keep retrying.`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pmConnect.syncTimeFromBacklog", async () => {
      await vscode.commands.executeCommand("pmConnect.syncProject");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pmConnect.showLogs", () => {
      outputChannel.show(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pmConnect.viewPendingQueue", async () => {
      const currentProjId = providerContext.getConfig("pmConnect.custom.projectId", "");
      const pending = currentProjId ? offlineQueue.getPending(currentProjId) : offlineQueue.getPending();
      if (!pending || pending.length === 0) {
        vscode.window.showInformationMessage("PM Connect: Offline queue is empty (all logs are synced).");
        return;
      }
      const items = pending.map((entry, i) => ({
        label: `${i + 1}. [${entry.endpoint}] - Project: ${entry.projectId || "N/A"}`,
        description: `Queued: ${new Date(entry.queuedAt).toLocaleTimeString()} | Attempts: ${entry.attempts}`,
        detail: JSON.stringify(entry.payload),
      }));
      await vscode.window.showQuickPick(items, {
        placeHolder: `Offline Queue (${pending.length} pending logs): Select to inspect payload`,
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pmConnect.statusBarMenu", async () => {
      const currentProjId = providerContext.getConfig("pmConnect.custom.projectId", "");
      const isConnected = !!currentProjId;
      const count = isConnected ? offlineQueue.getPendingCount(currentProjId) : 0;
      const todayMin = isConnected ? dailySummaryTracker.getTodayMinutes(currentProjId) : 0;
      const activeFolder = vscode.workspace.workspaceFolders?.[0];
      const timeSummary = getTimeSummaryFromBacklog(activeFolder);
      const todayBacklogMin = timeSummary?.todayMinutes || 0;
      const totalBacklogMin = timeSummary?.totalMinutes || 0;
      const todayBacklogHrs = timeSummary?.todayHours || "0.00";
      const totalBacklogHrs = timeSummary?.totalHours || "0.00";
      const sessionFiles = typeof getCurrentSessionFiles === "function" ? getCurrentSessionFiles(activeFolder?.uri?.fsPath) : [];
      const rawToday = isConnected ? activityLog.getTodayFiles(currentProjId) : [];
      const todayFiles = Array.from(new Set([...rawToday, ...sessionFiles])).filter((f) => {
        if (!f) return false;
        if (activeFolder) {
          const abs = path.join(activeFolder.uri.fsPath, f);
          return fs.existsSync(abs);
        }
        return true;
      });

      const pendingTimeItems = syncedTimeTracker.getPendingSyncItems(currentProjId, timeSummary?.dateBreakdown || []);
      const unsyncedTimeDelta = pendingTimeItems.reduce((acc, it) => acc + (it.unsyncedDelta || 0), 0);

      const items = [
        isConnected
          ? {
              label: `$(pass-filled) Status: Connected to ERP [Project: ${currentProjId}]`,
              description: "Click to open Project Report in ERP",
              action: "openReport",
            }
          : {
              label: "$(debug-disconnect) Status: Disconnected from ERP",
              description: "Click to Connect to ERP automatically (1-Click)",
              action: "connect",
            },
        {
          label: (unsyncedTimeDelta > 0 || count > 0)
            ? `$(sync) Sync Project & Flush Queue (${unsyncedTimeDelta > 0 ? `+${unsyncedTimeDelta}m new time` : ""}${unsyncedTimeDelta > 0 && count > 0 ? ", " : ""}${count > 0 ? `${count} logs pending` : ""})`
            : `$(pass) Sync Project to ERP (All up-to-date • Today: ${todayBacklogMin}m)`,
          description: `Today: ${todayBacklogMin}m (${todayBacklogHrs}h) • Start to Today: ${totalBacklogMin}m (${totalBacklogHrs}h) [Click to sync all logs & time]`,
          action: "sync",
        },
        {
          label: `$(file-code) View Today's Changed Files (${todayFiles.length})`,
          description: "See all files modified today since morning",
          action: "pages",
        },
        {
          label: "$(comment-discussion) All Comments & Daily Logs",
          description: "All commit comments and day-by-day activity logs in one place",
          action: "allComments",
        },
        {
          label: "$(output) Show Live Output Logs",
          description: "Open PM Connect log channel",
          action: "logs",
        },
        {
          label: "$(globe) Open This Project's Report in ERP",
          description: "One click — opens this project's daily log (files changed, time spent) in Project Management",
          action: "openReport",
        },
        {
          label: "$(list-unordered) View Pending Queue Details",
          description: `${count} pending items in offline queue`,
          action: "queue",
        },
        ...(count > 0
          ? [
              {
                label: "$(trash) Clear Pending Queue",
                description: `Discard ${count} offline pending logs for this window`,
                action: "clearQueue",
              },
            ]
          : []),
        {
          label: "$(graph) Refresh Reports",
          description: `Today: ${todayBacklogMin} min tracked (${todayBacklogHrs} hrs)`,
          action: "reports",
        },
        {
          label: "$(gear) Open Settings",
          description: "Configure baseUrl & options",
          action: "settings",
        },
      ];

      if (isConnected) {
        items.push({
          label: "$(plug) Disconnect PM Connect",
          description: `Stop tracking & disconnect Project ${currentProjId}`,
          action: "disconnect",
        });
      } else {
        items.unshift({
          label: "$(plug) Connect PM Connect",
          description: "Connect to project management",
          action: "connect",
        });
      }

      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `PM Connect (${count} pending • Today: ${todayBacklogMin}m [${todayBacklogHrs}h] • Total: ${totalBacklogMin}m [${totalBacklogHrs}h] • ${todayFiles.length} files)`,
      });

      if (!pick) return;
      if (pick.action === "syncTime") await vscode.commands.executeCommand("pmConnect.syncTimeFromBacklog");
      else if (pick.action === "pages") await vscode.commands.executeCommand("pmConnect.viewChangedPages");
      else if (pick.action === "allComments") await vscode.commands.executeCommand("pmConnect.viewAllComments");
      else if (pick.action === "logs") await vscode.commands.executeCommand("pmConnect.showLogs");
      else if (pick.action === "sync") await vscode.commands.executeCommand("pmConnect.syncProject");
      else if (pick.action === "openReport") await vscode.commands.executeCommand("pmConnect.openReport", currentProjId);
      else if (pick.action === "queue") await vscode.commands.executeCommand("pmConnect.viewPendingQueue");
      else if (pick.action === "clearQueue") {
        offlineQueue.clearPending(currentProjId || null);
        syncManager.updateStatusBar(currentProjId || null);
        vscode.window.showInformationMessage("PM Connect: Pending queue cleared.");
      }
      else if (pick.action === "reports") await vscode.commands.executeCommand("pmConnect.refreshReports");
      else if (pick.action === "settings") await vscode.commands.executeCommand("pmConnect.openSettings");
      else if (pick.action === "disconnect") await vscode.commands.executeCommand("pmConnect.disconnect");
      else if (pick.action === "connect") await vscode.commands.executeCommand("pmConnect.connect");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pmConnect.viewAllComments", async () => {
      const currentProjId = providerContext.getConfig("pmConnect.custom.projectId", "");
      const allCommits = activityLog.getAllCommits(currentProjId);
      const groupedByDate = activityLog.getEntriesGroupedByDate(currentProjId);

      // Print full formatted report to Output Channel
      outputChannel.show(true);
      outputChannel.appendLine("");
      outputChannel.appendLine("================================================================================");
      outputChannel.appendLine(`📋 [PM CONNECT] ALL COMMENTS & DAILY ACTIVITY LOGS (Project: ${currentProjId || "All"})`);
      outputChannel.appendLine("================================================================================");
      outputChannel.appendLine("");
      outputChannel.appendLine(`💬 ALL COMMIT COMMENTS (Total: ${allCommits.length})`);
      outputChannel.appendLine("--------------------------------------------------------------------------------");
      if (allCommits.length === 0) {
        outputChannel.appendLine("   (No commit comments recorded yet)");
      } else {
        allCommits.forEach((c, idx) => {
          const files = c.filesChanged || [];
          const sha = c.commitSha ? ` [${c.commitSha.slice(0, 7)}]` : "";
          outputChannel.appendLine(`   ${idx + 1}. [${c.date} ${c.startTime || ""}]${sha} "${c.summary}"`);
          if (files.length > 0) {
            outputChannel.appendLine(`      Files (${files.length}): ${files.join(", ")}`);
          }
        });
      }

      outputChannel.appendLine("");
      outputChannel.appendLine("📅 DAILY LOGS (DAY-BY-DAY TIMELINE)");
      outputChannel.appendLine("--------------------------------------------------------------------------------");
      if (groupedByDate.length === 0) {
        outputChannel.appendLine("   (No activity entries recorded yet)");
      } else {
        for (const day of groupedByDate) {
          const commits = day.entries.filter((e) => e.type === "commit");
          const sessions = day.entries.filter((e) => e.type === "coding-session");
          const dayMinutes = sessions.reduce((acc, s) => acc + (s.durationMinutes || 0), 0);
          outputChannel.appendLine(`📅 Date: ${day.date} — ${commits.length} commits, ${dayMinutes}m active coding`);
          for (const entry of day.entries) {
            if (entry.type === "commit") {
              const files = entry.filesChanged || [];
              outputChannel.appendLine(`   • [COMMIT] [${entry.commitSha ? entry.commitSha.slice(0, 7) : "sha"}] "${entry.summary}"`);
              if (files.length > 0) {
                outputChannel.appendLine(`     Files: ${files.join(", ")}`);
              }
            } else {
              const files = entry.filesChanged || [];
              outputChannel.appendLine(`   • [SESSION] ${entry.startTime} – ${entry.endTime} (${entry.durationMinutes}m)`);
              if (files.length > 0) {
                outputChannel.appendLine(`     Pages: ${files.join(", ")}`);
              }
            }
          }
          outputChannel.appendLine("");
        }
      }
      outputChannel.appendLine("================================================================================");

      // Also show QuickPick for interactive navigation
      const qpItems = [];
      if (allCommits.length > 0) {
        qpItems.push({ label: "── ALL COMMIT COMMENTS ──", kind: vscode.QuickPickItemKind.Separator });
        for (const c of allCommits) {
          const files = c.filesChanged || [];
          qpItems.push({
            label: `$(comment) "${c.summary}"`,
            description: `${c.date} • ${c.commitSha ? c.commitSha.slice(0, 7) : ""} • ${files.length} files`,
            entry: c,
          });
        }
      }

      if (groupedByDate.length > 0) {
        qpItems.push({ label: "── DAILY LOGS BY DATE ──", kind: vscode.QuickPickItemKind.Separator });
        for (const day of groupedByDate) {
          const commits = day.entries.filter((e) => e.type === "commit");
          qpItems.push({
            label: `$(calendar) ${day.date}`,
            description: `${commits.length} commits • ${day.entries.length} log items`,
            day,
          });
        }
      }

      if (qpItems.length === 0) {
        vscode.window.showInformationMessage("No comments or daily logs recorded yet for this project.");
        return;
      }

      const picked = await vscode.window.showQuickPick(qpItems, {
        placeHolder: `PM Connect: All comments & day logs for Project ${currentProjId || "active"} (Printed to Output)`,
      });

      if (!picked) return;
      if (picked.entry?.filesChanged?.length) {
        const filePick = await vscode.window.showQuickPick(
          picked.entry.filesChanged.map((f) => ({ label: `$(file) ${f}`, filePath: f })),
          { placeHolder: `Files modified in "${picked.entry.summary}" — select to open` }
        );
        if (filePick?.filePath) {
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (workspaceFolder) {
            const uri = vscode.Uri.joinPath(workspaceFolder.uri, filePick.filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
          }
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pmConnect.viewChangedPages", async () => {
      const currentProjId = providerContext.getConfig("pmConnect.custom.projectId", "");
      if (!currentProjId) {
        vscode.window.showInformationMessage("PM Connect: Project is not connected in this workspace yet.");
        return;
      }

      const activeFolder = vscode.workspace.workspaceFolders?.[0];
      const entries = activityLog.getEntries(currentProjId, 50);

      const fileMap = new Map();
      for (const entry of entries) {
        const files = entry.filesChanged || [];
        const isCommit = entry.type === "commit";
        const tag = isCommit
          ? `Commit [${entry.commitSha ? entry.commitSha.slice(0, 7) : ""}] "${entry.summary}"`
          : `Session (${entry.startTime} – ${entry.endTime}, ${entry.durationMinutes}m)`;

        for (const file of files) {
          const cleanFile = String(file).replace(/\\/g, "/");
          // Strictly verify file belongs to and exists in this workspace folder
          if (activeFolder) {
            const absPath = path.join(activeFolder.uri.fsPath, cleanFile);
            if (!fs.existsSync(absPath)) continue;
          }
          if (!fileMap.has(cleanFile)) {
            fileMap.set(cleanFile, {
              date: entry.date,
              context: tag,
            });
          }
        }
      }

      const sessionFiles = typeof getCurrentSessionFiles === "function" ? getCurrentSessionFiles(activeFolder?.uri?.fsPath) : [];
      for (const f of sessionFiles) {
        const clean = String(f).replace(/\\/g, "/");
        if (activeFolder) {
          const absPath = path.join(activeFolder.uri.fsPath, clean);
          if (!fs.existsSync(absPath)) continue;
        }
        if (!fileMap.has(clean)) {
          fileMap.set(clean, {
            date: "Today",
            context: "Active coding right now",
          });
        }
      }

      if (fileMap.size === 0) {
        vscode.window.showInformationMessage(
          "PM Connect: No pages or files recorded today yet. Start editing files or making commits to see them here."
        );
        return;
      }

      const items = Array.from(fileMap.entries()).map(([filePath, meta]) => ({
        label: `$(file) ${filePath}`,
        description: `${meta.date} • ${meta.context}`,
        filePath,
      }));

      // Print full list to Output Channel so user has the log printed right away!
      outputChannel.appendLine(
        `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] [TODAY'S FILES] 📋 All files modified today since morning (${items.length} files):`
      );
      for (let i = 0; i < items.length; i++) {
        outputChannel.appendLine(`   ${i + 1}. ${items[i].filePath} — ${items[i].description}`);
      }

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `PM Connect: ${items.length} files modified today since morning — Select to open in editor`,
      });

      if (!picked) return;
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, picked.filePath);
        try {
          const doc = await vscode.workspace.openTextDocument(fileUri);
          await vscode.window.showTextDocument(doc);
        } catch (err) {
          vscode.window.showErrorMessage(`Could not open ${picked.filePath}: ${err.message}`);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pmConnect.showLogEntryDetail", (entry) => {
      if (!entry) return;
      vscode.window
        .showInformationMessage(
          `${entry.title}`,
          {
            modal: true,
            detail: `Time: ${new Date(entry.timestamp).toLocaleString()}\nStatus: ${entry.status.toUpperCase()}\nType: ${entry.type}\n\nDetails:\n${entry.detail || "(no extra details)"}`,
          },
          "Open Output Logs"
        )
        .then((choice) => {
          if (choice === "Open Output Logs") {
            outputChannel.show(true);
          }
        });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pmConnect.viewMyTasks", async () => {
      await withErrorHandling(async () => {
        const tasks = await activeProvider().listMyTasks(providerContext);
        treeDataProvider.setTasks(tasks);
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pmConnect.showTaskDetail", async (task) => {
      if (!task) return;
      const progress = typeof task.progress === "number" ? ` — ${task.progress}%` : "";
      const detail = `Status: ${task.status}${progress}\n\n${task.description || "(no description)"}`;

      const choice = await vscode.window.showInformationMessage(
        `${task.title}`,
        { modal: true, detail },
        "Update Status",
        "Open in Browser"
      );

      if (choice === "Update Status") {
        await vscode.commands.executeCommand("pmConnect.updateStatus");
      } else if (choice === "Open in Browser" && task.url) {
        await vscode.env.openExternal(vscode.Uri.parse(task.url));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pmConnect.updateStatus", async () => {
      await withErrorHandling(async () => {
        const tasks = await activeProvider().listMyTasks(providerContext);
        const picked = await vscode.window.showQuickPick(
          tasks.map((t) => ({ label: t.title, description: t.status, task: t })),
          { placeHolder: "Select a task" }
        );
        if (!picked) return;

        const newStatus = await vscode.window.showInputBox({ prompt: "New status", value: picked.task.status });
        if (!newStatus) return;

        await activeProvider().updateTaskStatus(picked.task.id, newStatus, providerContext);
        vscode.window.showInformationMessage(`Updated "${picked.task.title}" to ${newStatus}.`);
        await vscode.commands.executeCommand("pmConnect.viewMyTasks");
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pmConnect.switchProvider", async () => {
      const picked = await vscode.window.showQuickPick(
        Object.values(PROVIDERS).map((p) => ({ label: p.displayName, id: p.id })),
        { placeHolder: "Which tool do you use?" }
      );
      if (!picked) return;

      await vscode.workspace
        .getConfiguration()
        .update("pmConnect.provider", picked.id, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Switched to ${picked.label}.`);
      stopTracking();
      await vscode.commands.executeCommand("pmConnect.connect");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pmConnect.disconnect", async () => {
      const choice = await vscode.window.showWarningMessage(
        `Are you sure you want to disconnect PM Connect? Background tracking will stop. ` +
          `(Reconnecting is automatic — just click "Connect" again, no details needed.)`,
        "Disconnect",
        "Cancel"
      );
      if (choice !== "Disconnect") return;

      stopTracking();
      const prevProjId = providerContext.getConfig("pmConnect.custom.projectId", "") || "active project";
      const existingKey = await providerContext.getSecret("pmConnect.custom.apiKey");
      if (prevProjId && !EMPLOYEE_ID_PATTERN.test(prevProjId)) {
        await context.workspaceState.update("pmConnect.lastConnectedProjectId", prevProjId);
      }
      if (existingKey) {
        await context.workspaceState.update("pmConnect.lastConnectedApiKey", existingKey);
      }
      await vscode.workspace
        .getConfiguration()
        .update("pmConnect.custom.projectId", undefined, vscode.ConfigurationTarget.Workspace);
      statusBar.setState("disconnected");
      statusBar.setPendingCount(0, 0);
      outputChannel.appendLine(
        `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] [DISCONNECTED] 🔌 PM Connect disconnected from Project ${prevProjId}. Tracking stopped.`
      );
      vscode.window.showInformationMessage("🔌 PM Connect disconnected.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pmConnect.openSettings", async () => {
      await vscode.commands.executeCommand("workbench.action.openSettings", "pmConnect");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pmConnect.refreshReports", async () => {
      await refreshReports();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pmConnect.openReport", async (projectId) => {
      if (!projectId) return;
      // The ERP is the Global Tech CRM (a React SPA) — the project's own
      // "VS Dev Activity" tab is its report, at /project/{id}, not a
      // separate report.php page (that was the old projex/PHP backend).
      // Whichever backend (local dev ERP or live) is currently active is
      // also whichever website should open — same local-first, live-fallback
      // logic as everything else.
      const siteUrl = backendResolver.isCachedLocal()
        ? providerContext.getConfig("pmConnect.custom.localSiteUrl", "")
        : providerContext.getConfig("pmConnect.custom.siteUrl", "");
      let finalUrl = "";
      if (siteUrl) {
        finalUrl = `${siteUrl.replace(/\/+$/, "")}/project/${projectId}`;
      } else {
        const baseUrl = backendResolver.getCachedBaseUrl(providerContext.getConfig);
        if (baseUrl) {
          let derived = baseUrl.replace(/\/+$/, "");
          if (derived.endsWith("/api/pmconnect")) {
            derived = derived.slice(0, -"/api/pmconnect".length);
          } else if (derived.endsWith("/api/pmconnect.php")) {
            derived = derived.slice(0, -"/api/pmconnect.php".length);
          } else if (derived.endsWith("/api")) {
            derived = derived.slice(0, -"/api".length);
          }
          if (derived) {
            finalUrl = `${derived}/project/${projectId}`;
          }
        }
      }
      if (finalUrl) {
        await vscode.env.openExternal(vscode.Uri.parse(finalUrl));
      } else {
        vscode.window.showErrorMessage("Could not open report: siteUrl is not configured.");
      }
    })
  );

  // New command: Add GitHub Comment
  context.subscriptions.push(
    vscode.commands.registerCommand("pmConnect.addGitHubComment", async () => {
      const commentBody = await vscode.window.showInputBox({
        prompt: "Enter comment for GitHub (Project Management)",
        ignoreFocusOut: true,
      });
      if (!commentBody) return;

      let token = await providerContext.getSecret("pmConnect.githubToken");
      if (!token) {
        token = await vscode.window.showInputBox({
          prompt: "Enter your GitHub Personal Access Token (repo scope)",
          password: true,
          ignoreFocusOut: true,
        });
        if (!token) return;
        await providerContext.setSecret("pmConnect.githubToken", token);
      }

      let repo = providerContext.getConfig("pmConnect.githubRepo", "");
      if (!repo) {
        repo = await vscode.window.showInputBox({
          prompt: "Enter GitHub repository (owner/name)",
          ignoreFocusOut: true,
        });
        if (!repo) return;
        await vscode.workspace
          .getConfiguration()
          .update("pmConnect.githubRepo", repo, vscode.ConfigurationTarget.Global);
      }

      try {
        const issue = await getLatestOpenIssue(token, repo);
        if (!issue) {
          vscode.window.showErrorMessage("No open issue found to attach the comment.");
          return;
        }
        await postComment(token, repo, issue.number, commentBody);
        const recent = await fetchRecentComments(token, repo, issue.number);
        const found = recent.some((c) => c.body === commentBody);
        if (found) {
          vscode.window.showInformationMessage("Comment posted and verified on GitHub!");
        } else {
          vscode.window.showErrorMessage("Could not verify posted comment on GitHub.");
        }
      } catch (err) {
        console.error("[PM Connect] GitHub comment error:", err);
        vscode.window.showErrorMessage(`Error posting GitHub comment: ${err.message}`);
      }
    })
  );

  /**
   * First-run setup for this workspace. If a teammate already committed
   * pmconnect.config.json, this is a single "paste your API key" prompt —
   * everything else (provider, base URL, project ID) is already known.
   * Otherwise falls back to the full "Which tool do you use?" flow.
   */
  async function runFirstTimeSetup() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const projectConfig = readProjectConfig(workspaceFolder);

    let baseUrl = providerContext.getConfig("pmConnect.custom.baseUrl", "");
    if (!baseUrl) {
      baseUrl = "https://crm.tgailab.site/api/pmconnect";
      await vscode.workspace
        .getConfiguration()
        .update("pmConnect.custom.baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
    }

    const hasKey = await providerContext.getSecret("pmConnect.custom.apiKey");
    if (!hasKey) {
      await providerContext.setSecret("pmConnect.custom.apiKey", "dev-offline-key");
    }
  }

  /**
   * Attempts silent auto-matching of the current developer and workspace to a project on the backend.
   */
  async function tryAutoMatch() {
    const providerId = getActiveProviderId(providerContext.getConfig);
    if (providerId !== "custom") return null;

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return null;

    const cwd = workspaceFolder.uri.fsPath;
    const gitEmail = gitUserEmail(cwd);
    const gitRemoteUrl = gitRemoteOriginUrl(cwd);
    const machineUsername = os.userInfo().username || process.env.USERNAME || process.env.USER || "";
    const workspaceFolderName = workspaceFolder.name;

    await backendResolver.refresh(providerContext.getConfig);

    try {
      const provider = getProvider("custom");
      const result = await provider.autoMatch({
        gitEmail,
        machineUsername,
        workspaceFolderName,
        gitRemoteUrl
      }, providerContext);

      if (result?.success && result?.apiKey && result?.projectId) {
        const hasApiKey = await providerContext.getSecret("pmConnect.custom.apiKey");
        const configuredProjectId = providerContext.getConfig("pmConnect.custom.projectId", "");

        if (hasApiKey !== result.apiKey) {
          await providerContext.setSecret("pmConnect.custom.apiKey", result.apiKey);
          outputChannel.appendLine(`[PM Connect] Updated API Key for matched developer.`);
        }
        if (String(configuredProjectId) !== String(result.projectId)) {
          await vscode.workspace
            .getConfiguration()
            .update("pmConnect.custom.projectId", String(result.projectId), vscode.ConfigurationTarget.Workspace);
          outputChannel.appendLine(`[PM Connect] Updated Project ID to: ${result.projectId}`);
        }

        await context.workspaceState.update("pmConnect.setupDone", true);
        outputChannel.appendLine(`[PM Connect] Auto-match successful. Project ID: ${result.projectId}`);
        return result.apiKey;
      }
      return null;
    } catch (err) {
      console.error("[PM Connect] Auto-match failed silently:", err);
      return null;
    }
  }

  /**
   * Idempotent, silent "this project has started" ping — the whole point of
   * zero-interaction tracking. Only fires for the Custom provider with a
   * concrete numeric project ID (Employee-ID scoping has no single project
   * to attribute a start date to, and Trello has no equivalent concept).
   * Safe to call on every activation: the server only actually changes
   * anything the very first time (started_at IS NULL).
   */
  async function pingProjectStartOnce() {
    const providerId = getActiveProviderId(providerContext.getConfig);
    if (providerId !== "custom") return;
    const projectId = providerContext.getConfig("pmConnect.custom.projectId", "");
    if (!projectId || EMPLOYEE_ID_PATTERN.test(projectId)) return;

    const flagKey = `pmConnect.startPinged.${projectId}`;
    if (context.workspaceState.get(flagKey, false)) return;

    try {
      await getProvider("custom").markProjectStarted(providerContext);
      await context.workspaceState.update(flagKey, true);
    } catch (err) {
      // Silent — no dialogs for automatic tracking. Flag stays false, so
      // this retries on the next activation instead of failing forever.
      console.error("[PM Connect] pingProjectStartOnce failed:", err);
    }
  }

  async function refreshReports() {
    const providerId = getActiveProviderId(providerContext.getConfig);
    if (providerId !== "custom") return;
    const apiKey = await providerContext.getSecret("pmConnect.custom.apiKey");
    if (!apiKey) {
      reportsTreeDataProvider.setRollups(null);
      return;
    }
    try {
      // Every project THIS employee has touched — never another developer's
      // data, whether they're connected by numeric project ID or Employee ID.
      const rollups = await getProvider("custom").getMyRollups(providerContext);
      reportsTreeDataProvider.setRollups(rollups);
    } catch (err) {
      // Silent — Reports panel just stays on its last known state.
      console.error("[PM Connect] refreshReports failed:", err);
    }
  }

  /**
   * If this workspace has no Project ID configured yet, create a brand-new
   * project on the backend straight from VS Code — no website step, no
   * picking from an existing list, no falling back to "whichever project
   * happens to be first". The folder name becomes the project name, and the
   * new numeric ID is written into this workspace's own settings so every
   * other tracker (commit heartbeat, active-time, Reports) picks it up
   * automatically from then on.
   */
  async function autoCreateProjectIfNeeded() {
    const providerId = getActiveProviderId(providerContext.getConfig);
    if (providerId !== "custom") return;

    const configuredId = providerContext.getConfig("pmConnect.custom.projectId", "");
    if (configuredId) return; // already linked to a project (or an Employee ID) — nothing to do

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    try {
      const provider = getProvider("custom");
      const result = await provider.autoCreateProject({ name: workspaceFolder.name }, providerContext);
      if (result?.id) {
        await vscode.workspace
          .getConfiguration()
          .update("pmConnect.custom.projectId", String(result.id), vscode.ConfigurationTarget.Workspace);
      }
    } catch (err) {
      // Silent — no dialogs for automatic tracking. projectId setting stays
      // empty, so this retries on the next activation instead of failing forever.
      console.error("[PM Connect] autoCreateProjectIfNeeded failed:", err);
    }
  }

  let trackingDisposables = [];

  function stopTracking() {
    for (const d of trackingDisposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    trackingDisposables = [];
  }

  function startTracking() {
    stopTracking();

    // 1. Unconditionally track commits, coding sessions, and maintain BACKLOG.md for every folder!
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      ensureBacklogFile(folder);
      const commitTracking = startCommitTracking(folder, context, providerContext, () => getProvider("custom"));
      if (commitTracking) {
        trackingDisposables.push(commitTracking);
      }

      const activityTracking = startActivityTracking(folder, context, providerContext, () => getProvider("custom"));
      if (activityTracking) {
        trackingDisposables.push(activityTracking);
      }
    }

    // 2. Only if connected to backend with a concrete project ID, ping project start & refresh remote reports
    const configuredProjectId = providerContext.getConfig("pmConnect.custom.projectId", "");
    const isTrackableWorkspace =
      getActiveProviderId(providerContext.getConfig) === "custom" &&
      !EMPLOYEE_ID_PATTERN.test(configuredProjectId) &&
      !!configuredProjectId;

    if (isTrackableWorkspace) {
      statusBar.setProject(configuredProjectId);
      statusBar.setState("idle");
      syncManager.updateStatusBar(configuredProjectId);
      void pingProjectStartOnce();
      void refreshReports();

      const reportsRefreshInterval = setInterval(refreshReports, 2 * 60 * 1000);
      const refreshDisp = { dispose: () => clearInterval(reportsRefreshInterval) };
      trackingDisposables.push(refreshDisp);
    } else {
      statusBar.setProject("");
      statusBar.setState("disconnected");
      statusBar.setPendingCount(0);
    }
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("pmConnect.provider") ||
        e.affectsConfiguration("pmConnect.custom.projectId") ||
        e.affectsConfiguration("pmConnect.custom.baseUrl")
      ) {
        startTracking();
      }
    })
  );

  async function init() {
    // Start local tracking and BACKLOG.md creation immediately without blocking on network/prompts!
    startTracking();
    await tryAutoMatch();
    const hasRunSetup = context.workspaceState.get("pmConnect.setupDone", false);
    if (!hasRunSetup) {
      const hasApiKey = await providerContext.getSecret("pmConnect.custom.apiKey");
      const projectId = providerContext.getConfig("pmConnect.custom.projectId", "");
      if (!hasApiKey || !projectId) {
        await runFirstTimeSetup();
      }
      await context.workspaceState.update("pmConnect.setupDone", true);
    }
    await autoCreateProjectIfNeeded();
    startTracking();
  }

  void init();
}

function deactivate() {
  // no-op
}

module.exports = { activate, deactivate };
