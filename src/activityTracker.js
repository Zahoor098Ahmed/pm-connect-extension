const vscode = require("vscode");
const { computeIdleGate, accumulateSeconds } = require("./trackerUtils");
const { dailySummaryTracker, getLocalDateString } = require("./dailySummaryTracker");
const { syncManager } = require("./syncManager");
const { activityLog, getLocalTimeString } = require("./activityLog");
const { appendSession, recordOrUpdateSession } = require("./backlogFile");

const TICK_MS = 30 * 1000;
const FLUSH_MS = 60 * 1000;
const MAX_BUFFERED_SECONDS = 600;
const DEFAULT_IDLE_THRESHOLD_MINUTES = 5;

/**
 * Passively tracks "active coding time" per workspace folder — no manual
 * timer. A tick every 30s adds to a buffer if the VS Code window is focused
 * and the developer isn't idle (judged by recent editor activity); the
 * buffer flushes to the backend every 60s. This is the automatic replacement
 * for the old per-task Start/Stop Timer commands.
 *
 * Returns a disposable (or undefined if nothing could be started), meant for
 * `context.subscriptions`.
 */
function startActivityTracking(folder, context, providerContext, getActiveProvider) {
  if (!folder?.uri?.fsPath) return undefined;

  const idleThresholdMs =
    providerContext.getConfig("pmConnect.activity.idleThresholdMinutes", DEFAULT_IDLE_THRESHOLD_MINUTES) * 60 * 1000;

  let lastActivitySignalAt = Date.now();
  let windowFocused = vscode.window.state.focused;
  let pendingSeconds = 0;
  const activeFiles = new Set();
  let sessionStartTime = null;
  let sessionStartTimestamp = null;
  let sessionActiveSeconds = 0;
  const sessionFiles = new Set();
  let lastLoggedFile = null;
  let lastLoggedTime = 0;

  function updateBacklogSession() {
    if (!sessionStartTime || sessionFiles.size === 0) return;
    const endTime = getLocalTimeString();
    const elapsedMinutes = Math.max(
      1,
      Math.round(sessionActiveSeconds > 0 ? sessionActiveSeconds / 60 : (Date.now() - (sessionStartTimestamp || Date.now())) / 60000)
    );
    const filesChanged = Array.from(sessionFiles).slice(0, 30);
    recordOrUpdateSession(folder, {
      startTime: sessionStartTime,
      endTime,
      durationMinutes: elapsedMinutes,
      filesChanged,
    });
  }

  function getProjectId() {
    const configured = providerContext.getConfig("pmConnect.custom.projectId", "");
    if (configured && !/^EMP\d+$/i.test(configured)) {
      return String(configured);
    }
    return folder?.name || "Local";
  }

  function isConnected() {
    const configured = providerContext.getConfig("pmConnect.custom.projectId", "");
    return !!(configured && !/^EMP\d+$/i.test(configured));
  }

  const folderUri = folder.uri.fsPath;
  const normFolder = folderUri.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  const folderPathKey = normFolder;
  if (!currentSessionFilesByFolder.has(folderPathKey)) {
    currentSessionFilesByFolder.set(folderPathKey, new Set());
  }
  const folderSessionFiles = currentSessionFilesByFolder.get(folderPathKey);

  const markActive = (e) => {
    lastActivitySignalAt = Date.now();
    let doc = e?.document || e?.textEditor?.document || vscode.window.activeTextEditor?.document;
    if (doc && doc.uri?.scheme === "file") {
      const normDoc = doc.uri.fsPath.replace(/\\/g, "/").toLowerCase();
      if (normDoc === normFolder || normDoc.startsWith(normFolder + "/")) {
        const relPath = vscode.workspace.asRelativePath(doc.uri, false);
        if (relPath && !relPath.startsWith("/")) {
          const cleanRel = relPath.replace(/\\/g, "/");
          if (!cleanRel.toLowerCase().endsWith("backlog.md")) {
            activeFiles.add(cleanRel);
            sessionFiles.add(cleanRel);
            folderSessionFiles.add(cleanRel);

            if (!sessionStartTime) {
              sessionStartTime = getLocalTimeString();
              sessionStartTimestamp = Date.now();
            }

            if (cleanRel !== lastLoggedFile) {
              lastLoggedFile = cleanRel;
              const projId = getProjectId();
              syncManager.log(`[ACTIVITY] ✏️ Working on: ${cleanRel} (Project: ${projId})`);
            }
          }
        }
      }
    }
  };

  const disposables = [
    vscode.window.onDidChangeWindowState((state) => {
      windowFocused = state.focused;
      if (state.focused) markActive();
    }),
    vscode.window.onDidChangeTextEditorSelection(markActive),
    vscode.window.onDidChangeActiveTextEditor(markActive),
    vscode.workspace.onDidChangeTextDocument(markActive),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri?.scheme === "file") {
        const normDoc = doc.uri.fsPath.replace(/\\/g, "/").toLowerCase();
        if (normDoc === normFolder || normDoc.startsWith(normFolder + "/")) {
          const relPath = vscode.workspace.asRelativePath(doc.uri, false);
          if (relPath && !relPath.startsWith("/") && !relPath.toLowerCase().endsWith("backlog.md")) {
            const cleanRel = relPath.replace(/\\/g, "/");
            activeFiles.add(cleanRel);
            sessionFiles.add(cleanRel);
            folderSessionFiles.add(cleanRel);
            lastActivitySignalAt = Date.now();
            if (!sessionStartTime) {
              sessionStartTime = getLocalTimeString();
              sessionStartTimestamp = Date.now();
            }
            const projId = getProjectId();
            syncManager.log(`[ACTIVITY] 💾 Saved: ${cleanRel} (Project: ${projId})`);
            updateBacklogSession();
          }
        }
      }
    }),
  ];

  try {
    if (vscode.workspace && typeof vscode.workspace.createFileSystemWatcher === "function") {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, "**/*")
      );
      const handleFs = (uri) => {
        if (!uri || uri.scheme !== "file") return;
        const norm = uri.fsPath.replace(/\\/g, "/").toLowerCase();
        if (
          norm.endsWith("/backlog.md") ||
          norm.endsWith("/pm-connect-backlog.md") ||
          norm.includes("/.git/") ||
          norm.includes("/node_modules/") ||
          norm.includes("/dist/") ||
          norm.endsWith(".vsix") ||
          norm.endsWith(".tmp")
        ) {
          return;
        }
        const relPath = vscode.workspace.asRelativePath(uri, false);
        if (relPath && !relPath.startsWith("/")) {
          const cleanRel = relPath.replace(/\\/g, "/");
          activeFiles.add(cleanRel);
          sessionFiles.add(cleanRel);
          folderSessionFiles.add(cleanRel);
          lastActivitySignalAt = Date.now();
          if (!sessionStartTime) {
            sessionStartTime = getLocalTimeString();
            sessionStartTimestamp = Date.now();
          }
          updateBacklogSession();
        }
      };
      watcher.onDidChange(handleFs);
      watcher.onDidCreate(handleFs);
      disposables.push(watcher);
    }
  } catch {
    /* ignore */
  }

  async function finalizeSession() {
    if (sessionActiveSeconds < 10 && sessionFiles.size === 0) {
      sessionStartTime = null;
      sessionStartTimestamp = null;
      sessionActiveSeconds = 0;
      sessionFiles.clear();
      return;
    }
    const projectId = getProjectId();
    const endTime = getLocalTimeString();
    const durationMinutes = Math.max(
      1,
      Math.round(sessionActiveSeconds > 0 ? sessionActiveSeconds / 60 : (Date.now() - (sessionStartTimestamp || Date.now())) / 60000)
    );
    const filesChanged = Array.from(sessionFiles).slice(0, 30);
    const summary = `Active coding session (${durationMinutes} min)`;

    updateBacklogSession();

    const entry = activityLog.recordSession({
      projectId,
      startTime: sessionStartTime || endTime,
      endTime,
      durationMinutes,
      filesChanged,
      summary,
    });

    const dateStr = getLocalDateString();
    const filesStr = filesChanged.length > 0 ? ` - Pages changed (${filesChanged.length}): [${filesChanged.join(", ")}]` : "";
    syncManager.log(
      `[LOG ENTRY] ${dateStr} ${endTime} - Session ended - ${durationMinutes} min - Project ${projectId}${filesStr}`,
      {
        type: "time",
        title: `Coding Session: ${durationMinutes}m (${sessionStartTime} – ${endTime})`,
        detail: `Project: ${projectId}\nDuration: ${durationMinutes} min\nPages/Files changed (${filesChanged.length}):\n${filesChanged.map((f) => ` • ${f}`).join("\n") || " (no files modified)"}`,
        status: "success",
      }
    );

    if (isConnected()) {
      try {
        const provider = getActiveProvider();
        if (typeof provider.logActivityEntry === "function") {
          await provider.logActivityEntry(entry, providerContext);
        }
      } catch {
        /* silent */
      }
    }

    sessionStartTime = null;
    sessionStartTimestamp = null;
    sessionActiveSeconds = 0;
    sessionFiles.clear();
    folderSessionFiles.clear();
  }

  const tickInterval = setInterval(() => {
    const isIdle = computeIdleGate(lastActivitySignalAt, Date.now(), idleThresholdMs);
    const delta = accumulateSeconds(windowFocused, isIdle, TICK_MS / 1000);
    pendingSeconds = Math.min(MAX_BUFFERED_SECONDS, pendingSeconds + delta);

    if (delta > 0) {
      if (!sessionStartTime) {
        sessionStartTime = getLocalTimeString();
        sessionStartTimestamp = Date.now();
      }
      sessionActiveSeconds += delta;
      for (const f of activeFiles) sessionFiles.add(f);
    } else if (isIdle && sessionActiveSeconds > 0) {
      // Idle timeout triggered: finalize session
      void finalizeSession();
    }
  }, TICK_MS);

  async function flush() {
    if (pendingSeconds <= 0) return;
    const projectId = getProjectId();

    const seconds = pendingSeconds;
    const files = Array.from(activeFiles).slice(0, 30);

    // 1. Record in local daily summary (persists even if backend is offline)
    const totalMinutesToday = dailySummaryTracker.recordActivity(projectId, seconds);
    const dateStr = getLocalDateString();
    syncManager.log(`[ACTIVITY] ⏱️ 60s active coding logged on [Project ${projectId}] - Pages: ${files.join(", ") || "various"} (Today: ${totalMinutesToday}m)`);

    updateBacklogSession();

    if (isConnected()) {
      try {
        const provider = getActiveProvider();
        await provider.logActiveHeartbeat({ seconds, activeFiles: files }, providerContext);

        if (projectId && typeof provider.logDailySummary === "function") {
          const date = getLocalDateString();
          await provider.logDailySummary({ projectId, date, totalMinutes: totalMinutesToday }, providerContext);
        }

        pendingSeconds = 0;
        activeFiles.clear();
      } catch {
        // Silent — keep the buffer (capped) and retry on the next flush.
      }
    } else {
      pendingSeconds = 0;
      activeFiles.clear();
    }
  }

  const flushInterval = setInterval(() => void flush(), FLUSH_MS);

  return {
    dispose() {
      clearInterval(tickInterval);
      clearInterval(flushInterval);
      for (const d of disposables) d.dispose();
      void finalizeSession();
      void flush();
    },
  };
}

let currentSessionFilesByFolder = new Map();

function getCurrentSessionFiles(folderPath = null) {
  if (!folderPath) {
    const all = new Set();
    for (const set of currentSessionFilesByFolder.values()) {
      for (const f of set) all.add(f);
    }
    return Array.from(all);
  }
  const norm = String(folderPath).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  for (const [key, set] of currentSessionFilesByFolder.entries()) {
    if (key === norm) {
      return Array.from(set);
    }
  }
  return [];
}

module.exports = {
  startActivityTracking,
  computeIdleGate,
  accumulateSeconds,
  getCurrentSessionFiles,
};
