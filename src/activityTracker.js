const fs = require("fs");
const path = require("path");
let vscode;
try {
  vscode = require("vscode");
} catch {
  // Fallback for unit testing outside VS Code runtime
  vscode = {
    window: { state: { focused: true } },
    workspace: {},
  };
}
const { computeIdleGate, accumulateSeconds } = require("./trackerUtils");
const { dailySummaryTracker, getLocalDateString } = require("./dailySummaryTracker");
const { syncManager } = require("./syncManager");
const { activityLog, getLocalTimeString } = require("./activityLog");
const { appendSession, recordOrUpdateSession, getTimeSummaryFromBacklog } = require("./backlogFile");
const { getUncommittedFiles } = require("./gitProgress");

const TICK_MS = 30 * 1000;
const FLUSH_MS = 60 * 1000;
const MAX_BUFFERED_SECONDS = 600;
const DEFAULT_IDLE_THRESHOLD_MINUTES = 5;

function getRecentlyModifiedGitFiles(cwd, maxAgeMs = 4 * 60 * 60 * 1000) {
  try {
    if (!cwd || typeof getUncommittedFiles !== "function") return [];
    const files = getUncommittedFiles(cwd);
    const now = Date.now();
    const result = [];
    for (const f of files) {
      const absPath = path.join(cwd, f);
      if (!isValidWorkFile(f, absPath)) continue;
      try {
        if (fs.existsSync(absPath)) {
          const stat = fs.statSync(absPath);
          if (now - stat.mtimeMs <= maxAgeMs) {
            result.push(f);
          }
        }
      } catch {
        result.push(f);
      }
    }
    return result;
  } catch {
    return [];
  }
}

function isValidWorkFile(relPath, absPath = null) {
  if (!relPath) return false;
  const clean = String(relPath).replace(/\\/g, "/").toLowerCase();
  const baseName = path.basename(clean);
  const ext = path.extname(clean);

  // Common ignored directories (build artifacts, dependencies, caches, metadata)
  const ignoredDirs = [
    ".git",
    "node_modules",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".nuxt",
    ".expo",
    ".expo-shared",
    ".cache",
    ".parcel-cache",
    ".turbo",
    ".vscode",
    ".idea",
    ".gemini",
    ".system_generated",
    "tmp",
    "temp",
    "logs",
  ];

  const parts = clean.split("/");
  for (const part of parts) {
    if (ignoredDirs.includes(part)) {
      return false;
    }
  }

  // Common ignored files / extensions
  const ignoredExts = [
    ".tmp",
    ".vsix",
    ".log",
    ".lock",
    ".lockb",
    ".tsbuildinfo",
    ".map",
  ];
  if (ignoredExts.includes(ext)) {
    return false;
  }

  if (
    baseName === "backlog.md" ||
    baseName === "pm-connect-backlog.md" ||
    baseName === "package-lock.json" ||
    baseName === "yarn.lock" ||
    baseName === "pnpm-lock.yaml" ||
    baseName === ".ds_store" ||
    baseName === "thumbs.db"
  ) {
    return false;
  }

  if (absPath) {
    try {
      if (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory()) {
        return false;
      }
    } catch {
      /* ignore */
    }
  }
  return true;
}

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

  const folderUri = folder.uri.fsPath;
  const normFolder = folderUri.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  const folderPathKey = normFolder;

  if (!currentSessionFilesByFolder.has(folderPathKey)) {
    currentSessionFilesByFolder.set(folderPathKey, new Set());
  }
  const folderSessionFiles = currentSessionFilesByFolder.get(folderPathKey);

  const getIdleThresholdMs = () => {
    const minutes = providerContext.getConfig(
      "pmConnect.activity.idleThresholdMinutes",
      DEFAULT_IDLE_THRESHOLD_MINUTES
    );
    return Math.max(1, Number(minutes) || DEFAULT_IDLE_THRESHOLD_MINUTES) * 60 * 1000;
  };

  let lastActivitySignalAt = 0;
  let windowFocused = vscode.window.state.focused;
  let pendingSeconds = 0;
  const activeFiles = new Set();
  let sessionStartTime = null;
  let sessionStartTimestamp = null;
  let sessionLastActiveTimestamp = null;
  let sessionActiveSeconds = 0;
  const sessionFiles = new Set();
  let lastLoggedFile = null;
  let lastAiFileTouchAt = 0;

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

  function resetSessionState() {
    sessionStartTime = null;
    sessionStartTimestamp = null;
    sessionLastActiveTimestamp = null;
    sessionActiveSeconds = 0;
    sessionFiles.clear();
    folderSessionFiles.clear();
    activeFiles.clear();
    pendingSeconds = 0;
    lastAiFileTouchAt = 0;
  }

  function syncRecentGitFiles() {
    if (!folderUri || !sessionStartTimestamp) return;
    try {
      // Only include git uncommitted files that were modified SINCE this session started
      const maxAgeMs = Math.max(60 * 1000, Date.now() - sessionStartTimestamp + 5000);
      const recentGitFiles = getRecentlyModifiedGitFiles(folderUri, maxAgeMs);
      for (const f of recentGitFiles) {
        sessionFiles.add(f);
        folderSessionFiles.add(f);
        activeFiles.add(f);
      }
    } catch {
      /* ignore */
    }
  }

  function updateBacklogSession(customEndTime = null, customDurationMinutes = null) {
    syncRecentGitFiles();
    if (!sessionStartTime || sessionFiles.size === 0) return;

    // End time is when the user last touched code, NEVER current wall clock if idle
    const endTimestamp = sessionLastActiveTimestamp || sessionStartTimestamp || Date.now();
    const endTime = customEndTime || getLocalTimeString(new Date(endTimestamp));
    let durationMinutes = customDurationMinutes;
    if (durationMinutes === null || durationMinutes === undefined) {
      durationMinutes = Math.max(1, Math.round(sessionActiveSeconds / 60));
    }
    const filesChanged = Array.from(sessionFiles).slice(0, 30);
    recordOrUpdateSession(folder, {
      startTime: sessionStartTime,
      endTime,
      durationMinutes,
      filesChanged,
    });
  }

  // `countAsFileTouch`: only real edits (typed/AI-written content, or a
  // save) should land a file in the "files worked on" list. Just moving the
  // cursor around a file you're reading — no typing — still counts as
  // "activity" for the idle timer, but must NOT mark that file as touched;
  // otherwise every file merely glanced at during a long session gets
  // counted the same as files actually changed, wildly inflating the count.
  function onActivity(doc, countAsFileTouch = false) {
    if (!doc) return;
    const now = Date.now();

    let cleanRel = null;
    if (doc.uri?.scheme === "file") {
      const normDoc = doc.uri.fsPath.replace(/\\/g, "/").toLowerCase();
      // Strictly enforce: must be inside THIS project's workspace folder
      if (normDoc === normFolder || normDoc.startsWith(normFolder + "/")) {
        const rel = vscode.workspace.asRelativePath(doc.uri, false);
        if (rel && !rel.startsWith("/") && !rel.includes(":")) {
          const c = rel.replace(/\\/g, "/");
          if (isValidWorkFile(c, doc.uri.fsPath)) {
            cleanRel = c;
          }
        }
      }
    }

    // Only valid project source files of THIS project trigger activity!
    if (!cleanRel) return;

    // If an idle gap (5+ min) occurred since last activity, finalize previous session first!
    const idleThresholdMs = getIdleThresholdMs();
    if (sessionStartTime && sessionLastActiveTimestamp && (now - sessionLastActiveTimestamp >= idleThresholdMs)) {
      void finalizeSession();
    }

    lastActivitySignalAt = now;
    sessionLastActiveTimestamp = now;

    if (countAsFileTouch) {
      activeFiles.add(cleanRel);
      sessionFiles.add(cleanRel);
      folderSessionFiles.add(cleanRel);

      if (cleanRel !== lastLoggedFile) {
        lastLoggedFile = cleanRel;
        const projId = getProjectId();
        syncManager.log(`[ACTIVITY] ✏️ Working on: ${cleanRel} (Project: ${projId})`);
      }
    }

    // Start a fresh session if no session is currently active
    if (!sessionStartTime) {
      sessionStartTime = getLocalTimeString(new Date(now));
      sessionStartTimestamp = now;
      sessionLastActiveTimestamp = now;
      sessionActiveSeconds = 0;
      sessionFiles.clear();
      folderSessionFiles.clear();
      if (countAsFileTouch) {
        sessionFiles.add(cleanRel);
        folderSessionFiles.add(cleanRel);
      }
    }
  }

  async function finalizeSession() {
    if (!sessionStartTime) return;
    try {
      const endTimestamp = sessionLastActiveTimestamp || sessionStartTimestamp || Date.now();
      const wallClockSpanSec = sessionStartTimestamp ? Math.round((endTimestamp - sessionStartTimestamp) / 1000) : 0;
      if (sessionFiles.size === 0 || (sessionActiveSeconds < 10 && wallClockSpanSec < 10)) {
        return;
      }

      const projectId = getProjectId();
      const endTime = getLocalTimeString(new Date(endTimestamp));
      const durationMinutes = Math.max(1, Math.round(sessionActiveSeconds / 60));
      const filesChanged = Array.from(sessionFiles).slice(0, 30);
      const summary = `Active coding session (${durationMinutes} min)`;

      updateBacklogSession(endTime, durationMinutes);

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
          if (typeof provider.syncTimeSummary === "function") {
            const timeSummary = getTimeSummaryFromBacklog(folder);
            if (timeSummary && timeSummary.todayMinutes !== undefined) {
              await provider.syncTimeSummary(
                {
                  projectId,
                  todayMinutes: timeSummary.todayMinutes,
                  totalMinutes: timeSummary.totalMinutes,
                  dateBreakdown: timeSummary.dateBreakdown,
                  activeFiles: filesChanged,
                },
                providerContext
              );
            }
          }
          if (typeof provider.logActivityEntry === "function") {
            await provider.logActivityEntry(entry, providerContext);
          }
        } catch {
          /* silent */
        }
      }
    } catch {
      /* silent */
    } finally {
      resetSessionState();
    }
  }

  function onProjectInteraction() {
    // Only register interaction if window is currently focused on this project
    if (!vscode.window.state.focused) return;
    const now = Date.now();
    lastActivitySignalAt = now;
    sessionLastActiveTimestamp = now;

    if (!sessionStartTime) {
      sessionStartTime = getLocalTimeString(new Date(now));
      sessionStartTimestamp = now;
      sessionActiveSeconds = 30;
      sessionFiles.clear();
      folderSessionFiles.clear();
    }
  }

  const tickInterval = setInterval(() => {
    const now = Date.now();
    const idleThresholdMs = getIdleThresholdMs();
    const isIdle = computeIdleGate(lastActivitySignalAt, now, idleThresholdMs);

    // AI is actively writing/testing in THIS project right now
    const isAiActivelyWriting = lastAiFileTouchAt > 0 && (now - lastAiFileTouchAt) <= 45 * 1000;
    // Real user activity in this editor within this tick window (plus margin)
    const hasRecentUserActivity = lastActivitySignalAt > 0 && (now - lastActivitySignalAt) <= (TICK_MS + 15 * 1000);

    // Accumulate seconds ONLY when:
    // 1. Not idle, AND
    // 2. Window is focused, AND (user actually touched code recently OR AI is writing)
    // Simply having VS Code open without touching code will NOT leak active seconds!
    const canAccumulate = !isIdle && (vscode.window.state.focused ? hasRecentUserActivity : false) || isAiActivelyWriting;
    const delta = canAccumulate ? (TICK_MS / 1000) : 0;

    if (delta > 0 && sessionStartTime) {
      sessionActiveSeconds += delta;
      pendingSeconds = Math.min(MAX_BUFFERED_SECONDS, pendingSeconds + delta);
      for (const f of activeFiles) {
        sessionFiles.add(f);
      }
    }

    // When idle threshold is reached and a session was active, finalize it!
    if (isIdle && sessionStartTime) {
      void finalizeSession();
    }
  }, TICK_MS);

  async function flush() {
    // Only flush if there are accumulated pending seconds
    if (pendingSeconds <= 0) return;
    if (!sessionStartTime) return;

    const projectId = getProjectId();
    const seconds = pendingSeconds;
    const files = Array.from(activeFiles).slice(0, 30);

    if (seconds > 0) {
      const totalMinutesToday = dailySummaryTracker.recordActivity(projectId, seconds);
      const dateStr = getLocalDateString();
      syncManager.log(`[ACTIVITY] ⏱️ ${seconds}s active coding logged on [Project ${projectId}] - Pages: ${files.join(", ") || "various"} (Today: ${totalMinutesToday}m)`);
    }

    updateBacklogSession();

    if (isConnected() && seconds > 0) {
      try {
        const provider = getActiveProvider();
        // Sync exact time directly from BACKLOG.md — single source of truth!
        // This uses idempotent $set on the ERP backend so minutes are NEVER double-counted,
        // never blindly incremented, and always match BACKLOG.md accurately.
        if (typeof provider.syncTimeSummary === "function") {
          const timeSummary = getTimeSummaryFromBacklog(folder);
          if (timeSummary && timeSummary.todayMinutes !== undefined) {
            await provider.syncTimeSummary(
              {
                projectId,
                todayMinutes: timeSummary.todayMinutes,
                totalMinutes: timeSummary.totalMinutes,
                dateBreakdown: timeSummary.dateBreakdown,
                activeFiles: files,
              },
              providerContext
            );
          }
        }

        if (projectId && typeof provider.logDailySummary === "function") {
          const date = getLocalDateString();
          await provider.logDailySummary({ projectId, date, totalMinutes: totalMinutesToday }, providerContext);
        }
      } catch {
        // Silent
      } finally {
        pendingSeconds = 0;
        activeFiles.clear();
      }
    } else if (seconds > 0) {
      pendingSeconds = 0;
      activeFiles.clear();
    }
  }

  const flushInterval = setInterval(() => void flush(), FLUSH_MS);

  const disposables = [
    vscode.window.onDidChangeWindowState((state) => {
      windowFocused = state.focused;
      if (state.focused && sessionStartTime) {
        lastActivitySignalAt = Date.now();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor
      ? vscode.window.onDidChangeActiveTextEditor((editor) => {
          // Analyzing, inspecting, or reviewing project files
          if (editor?.document) {
            onActivity(editor.document, false);
          }
        })
      : { dispose: () => {} },
    vscode.window.onDidChangeTextEditorSelection((e) => {
      // Keeps timer active while navigating, reading, or scrolling through code
      if (vscode.window.state.focused && e?.textEditor?.document) {
        onActivity(e.textEditor.document, false);
      }
    }),
    // Terminal testing & execution (e.g. npx expo start, npm test, run dev)
    vscode.window.onDidChangeActiveTerminal
      ? vscode.window.onDidChangeActiveTerminal(() => onProjectInteraction())
      : { dispose: () => {} },
    vscode.window.onDidOpenTerminal
      ? vscode.window.onDidOpenTerminal(() => onProjectInteraction())
      : { dispose: () => {} },
    vscode.tasks && typeof vscode.tasks.onDidStartTask === "function"
      ? vscode.tasks.onDidStartTask(() => onProjectInteraction())
      : { dispose: () => {} },
    vscode.debug && typeof vscode.debug.onDidStartDebugSession === "function"
      ? vscode.debug.onDidStartDebugSession(() => onProjectInteraction())
      : { dispose: () => {} },
    vscode.workspace.onDidChangeTextDocument((e) => {
      // Real code change (developer typing or AI writing/modifying code)
      if (e?.document && e.contentChanges && e.contentChanges.length > 0) {
        onActivity(e.document, true);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc) {
        onActivity(doc, true);
        const relPath = vscode.workspace.asRelativePath(doc.uri, false);
        const cleanRel = relPath ? relPath.replace(/\\/g, "/") : "";
        if (cleanRel && isValidWorkFile(cleanRel, doc.uri.fsPath)) {
          const projId = getProjectId();
          syncManager.log(`[ACTIVITY] 💾 Saved: ${cleanRel} (Project: ${projId})`);
        }
        updateBacklogSession();
      }
    }),
  ];

  let updateBacklogDebounceTimer = null;
  function scheduleBacklogUpdate() {
    if (updateBacklogDebounceTimer) clearTimeout(updateBacklogDebounceTimer);
    updateBacklogDebounceTimer = setTimeout(() => {
      updateBacklogSession();
    }, 800);
  }

  try {
    if (vscode.workspace && typeof vscode.workspace.createFileSystemWatcher === "function") {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, "**/*")
      );
      const handleFs = (uri) => {
        if (!uri || uri.scheme !== "file") return;
        const normUri = uri.fsPath.replace(/\\/g, "/").toLowerCase();
        // Strictly enforce project boundaries — ignore files from other projects completely!
        if (normUri !== normFolder && !normUri.startsWith(normFolder + "/")) {
          return;
        }

        const relPath = vscode.workspace.asRelativePath(uri, false);
        if (!relPath || relPath.startsWith("/") || relPath.includes(":")) return;
        const cleanRel = relPath.replace(/\\/g, "/");
        if (!isValidWorkFile(cleanRel, uri.fsPath)) return;

        const now = Date.now();
        lastActivitySignalAt = now;
        sessionLastActiveTimestamp = now;
        lastAiFileTouchAt = now;

        // If no session started yet, start one for this file modification (e.g. AI edits)
        if (!sessionStartTime) {
          sessionStartTime = getLocalTimeString(new Date(now));
          sessionStartTimestamp = now;
          sessionActiveSeconds = 30;
          sessionFiles.clear();
          folderSessionFiles.clear();
        }

        sessionFiles.add(cleanRel);
        folderSessionFiles.add(cleanRel);
        activeFiles.add(cleanRel);

        scheduleBacklogUpdate();
      };
      watcher.onDidChange(handleFs);
      watcher.onDidCreate(handleFs);
      disposables.push(watcher);
    }
  } catch {
    /* ignore */
  }

  return {
    dispose() {
      if (updateBacklogDebounceTimer) clearTimeout(updateBacklogDebounceTimer);
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
  isValidWorkFile,
};
