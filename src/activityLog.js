const fs = require("fs");
const path = require("path");
const os = require("os");

const LOG_FILE = "activity-log.json";
const MAX_LOG_ENTRIES = 5000;

function getLocalDateString(d = new Date()) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getLocalTimeString(d = new Date()) {
  const hr = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const sec = String(d.getSeconds()).padStart(2, "0");
  return `${hr}:${min}:${sec}`;
}

/**
 * Atomic write helper for activity log file.
 */
function atomicWriteJsonSync(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");

  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    fs.renameSync(tmpPath, filePath);
  }
}

function safeReadJsonSync(filePath, defaultFallback = []) {
  try {
    if (!fs.existsSync(filePath)) return defaultFallback;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return defaultFallback;
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[ActivityLog] Warning: failed to parse ${filePath}:`, err.message);
    return defaultFallback;
  }
}

class ActivityLog {
  constructor(storageDir = null) {
    this.storageDir = storageDir;
    this._listeners = new Set();
    if (storageDir) {
      this.init(storageDir);
    }
  }

  init(storageDir) {
    this.storageDir = storageDir;
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  ensureStorageDir() {
    if (!this.storageDir) {
      this.init(path.join(os.tmpdir(), "pm-connect-storage"));
    }
  }

  getLogFilePath() {
    this.ensureStorageDir();
    return path.join(this.storageDir, LOG_FILE);
  }

  /**
   * Appends a log entry to activity-log.json.
   * Append-only: older entries are never mutated.
   */
  appendEntry(entry) {
    const filePath = this.getLogFilePath();
    const list = safeReadJsonSync(filePath, []);

    // Capping safety to prevent disk explosion over years
    if (list.length >= MAX_LOG_ENTRIES) {
      list.splice(0, list.length - MAX_LOG_ENTRIES + 1);
    }

    list.push(entry);
    atomicWriteJsonSync(filePath, list);
    this._notify();
    return entry;
  }

  /**
   * Records a completed active coding session.
   */
  recordSession({
    projectId,
    startTime,
    endTime,
    durationMinutes,
    filesChanged = [],
    summary = "Active coding session detected",
  }) {
    const now = new Date();
    const date = getLocalDateString(now);
    const entry = {
      id: `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      projectId: String(projectId || ""),
      date,
      startTime: startTime || getLocalTimeString(now),
      endTime: endTime || getLocalTimeString(now),
      durationMinutes: Math.max(0, parseInt(durationMinutes, 10) || 0),
      type: "coding-session",
      filesChanged: Array.isArray(filesChanged) ? filesChanged.slice(0, 30) : [],
      summary,
      recordedAt: now.toISOString(),
    };

    return this.appendEntry(entry);
  }

  /**
   * Records a detected Git commit as an entry in the unified activity timeline.
   */
  recordCommit({
    projectId,
    commitSha,
    commitMessage,
    filesChanged = [],
    timestamp = null,
  }) {
    const d = timestamp ? new Date(timestamp) : new Date();
    const date = getLocalDateString(d);
    const timeStr = getLocalTimeString(d);

    const entry = {
      id: `commit-${(commitSha || Date.now().toString(36)).slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`,
      projectId: String(projectId || ""),
      date,
      startTime: timeStr,
      endTime: timeStr,
      durationMinutes: 0,
      type: "commit",
      commitSha: commitSha || "",
      filesChanged: Array.isArray(filesChanged) ? filesChanged.slice(0, 30) : [],
      summary: commitMessage || "Git commit",
      recordedAt: d.toISOString(),
    };

    return this.appendEntry(entry);
  }

  /**
   * Returns all entries (or filtered by projectId), sorted newest first.
   */
  getEntries(projectId = null, limit = 100) {
    const filePath = this.getLogFilePath();
    const list = safeReadJsonSync(filePath, []);
    let filtered = projectId
      ? list.filter((item) => String(item.projectId) === String(projectId))
      : list;

    // Return in reverse chronological order (newest first, like Git log)
    return filtered.slice().reverse().slice(0, limit);
  }

  /**
   * Computes total active minutes directly from coding session entries for a date and project.
   * Single source of truth — avoids duplicate tracking between daily summary and sessions.
   */
  getTodayMinutesFromLog(projectId, dateStr = null) {
    const date = dateStr || getLocalDateString();
    const filePath = this.getLogFilePath();
    const list = safeReadJsonSync(filePath, []);

    let total = 0;
    for (const item of list) {
      if (
        item.date === date &&
        (!projectId || String(item.projectId) === String(projectId)) &&
        item.type === "coding-session"
      ) {
        total += item.durationMinutes || 0;
      }
    }
    return total;
  }

  /**
   * Returns all unique files/pages touched today (or on dateStr), across sessions and commits.
   */
  getTodayFiles(projectId = null, dateStr = null) {
    const date = dateStr || getLocalDateString();
    const filePath = this.getLogFilePath();
    const list = safeReadJsonSync(filePath, []);
    const filesSet = new Set();

    for (const item of list) {
      if (item.date === date && (!projectId || String(item.projectId) === String(projectId))) {
        for (const f of item.filesChanged || []) {
          if (f) filesSet.add(String(f).replace(/\\/g, "/"));
        }
      }
    }
    return Array.from(filesSet);
  }

  /**
   * Returns all log entries for a specific project on a specific date, newest first.
   */
  getEntriesForDate(projectId, dateStr) {
    const filePath = this.getLogFilePath();
    const list = safeReadJsonSync(filePath, []);
    return list
      .filter(
        (item) =>
          item.date === dateStr &&
          (!projectId || String(item.projectId) === String(projectId))
      )
      .slice()
      .reverse();
  }

  /**
   * Returns all commit entries for a project (or all projects), newest first.
   */
  getAllCommits(projectId = null) {
    const filePath = this.getLogFilePath();
    const list = safeReadJsonSync(filePath, []);
    return list
      .filter(
        (item) =>
          item.type === "commit" &&
          (!projectId || String(item.projectId) === String(projectId))
      )
      .slice()
      .reverse();
  }

  /**
   * Returns all entries grouped by date (newest date first).
   */
  getEntriesGroupedByDate(projectId = null) {
    const filePath = this.getLogFilePath();
    const list = safeReadJsonSync(filePath, []);
    const filtered = projectId
      ? list.filter((item) => String(item.projectId) === String(projectId))
      : list;

    const dateMap = new Map();
    for (const item of filtered) {
      const date = item.date || "Unknown Date";
      if (!dateMap.has(date)) {
        dateMap.set(date, []);
      }
      dateMap.get(date).push(item);
    }

    const sortedDates = Array.from(dateMap.keys()).sort((a, b) => (b > a ? 1 : -1));
    return sortedDates.map((date) => ({
      date,
      entries: dateMap.get(date).slice().reverse(),
    }));
  }

  onUpdate(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  _notify() {
    for (const listener of this._listeners) {
      try {
        listener();
      } catch {
        /* ignore */
      }
    }
  }
}

const activityLog = new ActivityLog();

module.exports = {
  ActivityLog,
  activityLog,
  getLocalDateString,
  getLocalTimeString,
  LOG_FILE,
};
