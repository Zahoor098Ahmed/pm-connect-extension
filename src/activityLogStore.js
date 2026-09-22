const fs = require("fs");
const path = require("path");
const os = require("os");

const HISTORY_FILE = "activity-history.json";
const MAX_HISTORY = 100;

class ActivityLogStore {
  constructor(storageDir = null) {
    this.storageDir = storageDir;
    this.inMemoryLogs = [];
    this._listeners = new Set();
    if (storageDir) {
      this.init(storageDir);
    }
  }

  init(storageDir) {
    this.storageDir = storageDir;
    this.load();
  }

  ensureStorageDir() {
    if (!this.storageDir) {
      this.init(path.join(os.tmpdir(), "pm-connect-storage"));
    }
  }

  getFilePath() {
    this.ensureStorageDir();
    return path.join(this.storageDir, HISTORY_FILE);
  }

  load() {
    try {
      const filePath = this.getFilePath();
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        this.inMemoryLogs = JSON.parse(raw) || [];
      }
    } catch {
      this.inMemoryLogs = [];
    }
  }

  save() {
    try {
      const filePath = this.getFilePath();
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(this.inMemoryLogs.slice(0, MAX_HISTORY), null, 2), "utf8");
    } catch {
      /* ignore */
    }
  }

  add({ type, title, detail = "", status = "info", timestamp = null }) {
    const entry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      type, // "commit" | "time" | "sync" | "queue" | "system" | "summary"
      title,
      detail,
      status, // "success" | "warning" | "error" | "info"
      timestamp: timestamp || new Date().toISOString(),
    };

    this.inMemoryLogs.unshift(entry);
    if (this.inMemoryLogs.length > MAX_HISTORY) {
      this.inMemoryLogs = this.inMemoryLogs.slice(0, MAX_HISTORY);
    }
    this.save();
    this._notify();
    return entry;
  }

  getRecentLogs(limit = 50) {
    return this.inMemoryLogs.slice(0, limit);
  }

  clear() {
    this.inMemoryLogs = [];
    this.save();
    this._notify();
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

const activityLogStore = new ActivityLogStore();

module.exports = {
  ActivityLogStore,
  activityLogStore,
};
