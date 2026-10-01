const fs = require("fs");
const path = require("path");
const os = require("os");

const SYNCED_TIME_FILE = "synced-time.json";

function safeReadJsonSync(filePath, defaultFallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return defaultFallback;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return defaultFallback;
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[SyncedTimeTracker] Warning: failed to parse ${filePath}:`, err.message);
    return defaultFallback;
  }
}

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

class SyncedTimeTracker {
  constructor(storageDir = null) {
    this.storageDir = storageDir;
    if (storageDir) {
      this.init(storageDir);
    }
  }

  init(storageDir) {
    this.storageDir = storageDir;
    if (this.storageDir && !fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  ensureStorageDir() {
    if (!this.storageDir) {
      this.init(path.join(os.tmpdir(), "pm-connect-storage"));
    }
  }

  getFilePath() {
    this.ensureStorageDir();
    return path.join(this.storageDir, SYNCED_TIME_FILE);
  }

  /**
   * Retrieves recorded synced minutes for a given project and date.
   */
  getSyncedMinutes(projectId, dateStr) {
    if (!projectId || !dateStr) return 0;
    const data = safeReadJsonSync(this.getFilePath(), {});
    const pId = String(projectId);
    return data[pId]?.dates?.[dateStr] || 0;
  }

  /**
   * Returns an object mapping date -> syncedMinutes for the project.
   */
  getAllSyncedDates(projectId) {
    if (!projectId) return {};
    const data = safeReadJsonSync(this.getFilePath(), {});
    return data[String(projectId)]?.dates || {};
  }

  /**
   * Evaluates dateBreakdown from BACKLOG.md against already-synced minutes.
   * Returns only items that have new/unsynced time:
   * [{ date, minutes, unsyncedDelta }]
   */
  getPendingSyncItems(projectId, dateBreakdown) {
    if (!projectId || !Array.isArray(dateBreakdown) || dateBreakdown.length === 0) {
      return [];
    }

    const syncedDates = this.getAllSyncedDates(projectId);
    const pending = [];

    for (const item of dateBreakdown) {
      if (!item || !item.date) continue;
      const currentMin = typeof item.minutes === "number" ? item.minutes : parseInt(item.minutes, 10) || 0;
      const alreadySynced = syncedDates[item.date] || 0;
      const delta = currentMin - alreadySynced;

      if (delta > 0) {
        pending.push({
          date: item.date,
          minutes: currentMin,
          unsyncedDelta: delta,
        });
      }
    }

    return pending;
  }

  /**
   * Checks whether there is ANY unsynced time for the project.
   */
  hasUnsyncedTime(projectId, dateBreakdown) {
    const items = this.getPendingSyncItems(projectId, dateBreakdown);
    return items.length > 0;
  }

  /**
   * Records that one date has been successfully synced to ERP with a given minute total.
   */
  recordSynced(projectId, dateStr, minutes) {
    if (!projectId || !dateStr) return;
    const pId = String(projectId);
    const filePath = this.getFilePath();
    const data = safeReadJsonSync(filePath, {});

    if (!data[pId]) {
      data[pId] = { dates: {}, lastSyncedAt: null };
    }
    if (!data[pId].dates) {
      data[pId].dates = {};
    }

    data[pId].dates[dateStr] = Math.max(data[pId].dates[dateStr] || 0, minutes);
    data[pId].lastSyncedAt = new Date().toISOString();

    atomicWriteJsonSync(filePath, data);
  }

  /**
   * Records batch of items [{ date, minutes }] as synced.
   */
  recordBatchSynced(projectId, items) {
    if (!projectId || !Array.isArray(items) || items.length === 0) return;
    const pId = String(projectId);
    const filePath = this.getFilePath();
    const data = safeReadJsonSync(filePath, {});

    if (!data[pId]) {
      data[pId] = { dates: {}, lastSyncedAt: null };
    }
    if (!data[pId].dates) {
      data[pId].dates = {};
    }

    for (const item of items) {
      if (item && item.date) {
        const min = typeof item.minutes === "number" ? item.minutes : parseInt(item.minutes, 10) || 0;
        data[pId].dates[item.date] = Math.max(data[pId].dates[item.date] || 0, min);
      }
    }
    data[pId].lastSyncedAt = new Date().toISOString();

    atomicWriteJsonSync(filePath, data);
  }

  /**
   * Clears record for a project (useful for testing or hard reset).
   */
  clearProject(projectId) {
    if (!projectId) return;
    const pId = String(projectId);
    const filePath = this.getFilePath();
    const data = safeReadJsonSync(filePath, {});
    delete data[pId];
    atomicWriteJsonSync(filePath, data);
  }
}

const syncedTimeTracker = new SyncedTimeTracker();

module.exports = {
  SyncedTimeTracker,
  syncedTimeTracker,
  SYNCED_TIME_FILE,
};
