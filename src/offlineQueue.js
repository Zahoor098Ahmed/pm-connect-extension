const fs = require("fs");
const path = require("path");
const os = require("os");

const PENDING_FILE = "pending-logs.json";
const FAILED_FILE = "failed-logs.json";
const OVERFLOW_FILE = "overflow-logs.json";

const MAX_PENDING_ENTRIES = 2000;
const MAX_RETRIES = 10;

/**
 * Atomic file writer: writes to a unique temporary file first, then renames.
 * Prevents file corruption if VS Code or the OS crashes during write.
 */
function atomicWriteJsonSync(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const content = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpPath, content, "utf8");

  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Windows fallback if destination is locked
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    fs.renameSync(tmpPath, filePath);
  }
}

/**
 * Safely reads a JSON file. If missing or corrupted, returns defaultFallback.
 */
function safeReadJsonSync(filePath, defaultFallback = []) {
  try {
    if (!fs.existsSync(filePath)) {
      return defaultFallback;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) {
      return defaultFallback;
    }
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[OfflineQueue] Warning: failed to parse ${filePath}, initializing fresh state:`, err.message);
    return defaultFallback;
  }
}

/**
 * Appends entries to a target log file atomically.
 */
function appendEntriesSync(filePath, entriesToAppend) {
  if (!entriesToAppend || entriesToAppend.length === 0) return;
  const existing = safeReadJsonSync(filePath, []);
  const updated = existing.concat(entriesToAppend);
  atomicWriteJsonSync(filePath, updated);
}

class OfflineQueue {
  constructor(storageDir = null) {
    this.storageDir = storageDir;
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

  getPendingFilePath() {
    this.ensureStorageDir();
    return path.join(this.storageDir, PENDING_FILE);
  }

  getFailedFilePath() {
    this.ensureStorageDir();
    return path.join(this.storageDir, FAILED_FILE);
  }

  getOverflowFilePath() {
    this.ensureStorageDir();
    return path.join(this.storageDir, OVERFLOW_FILE);
  }

  /**
   * Enqueues a new request log entry.
   * Maintains max capacity of 2000 entries; overflow is moved to overflow-logs.json.
   */
  enqueue({ endpoint, method = "POST", payload = {}, headers = {}, projectId, apiKey, baseUrl, url = "" }) {
    const filePath = this.getPendingFilePath();
    let pending = safeReadJsonSync(filePath, []);

    // Overflow protection: if reaching limit, move oldest entries to overflow-logs.json
    if (pending.length >= MAX_PENDING_ENTRIES) {
      const overflowCount = pending.length - MAX_PENDING_ENTRIES + 1;
      const overflowItems = pending.slice(0, overflowCount);
      appendEntriesSync(this.getOverflowFilePath(), overflowItems);
      pending = pending.slice(overflowCount);
    }

    const entry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
      endpoint,
      method,
      payload,
      headers,
      projectId: projectId || "",
      apiKey: apiKey || "",
      baseUrl: baseUrl || "",
      url: url || "",
      queuedAt: new Date().toISOString(),
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
    };

    pending.push(entry);
    atomicWriteJsonSync(filePath, pending);
    return entry;
  }

  /**
   * Returns a shallow copy of all pending entries in strict FIFO order, optionally filtered by projectId.
   */
  getPending(projectId = null) {
    if (!this.storageDir) return [];
    const list = safeReadJsonSync(this.getPendingFilePath(), []);
    if (!projectId) return list;
    return list.filter((item) => String(item.projectId) === String(projectId));
  }

  /**
   * Returns the count of pending entries, optionally filtered by projectId.
   */
  getPendingCount(projectId = null) {
    if (!this.storageDir) return 0;
    return this.getPending(projectId).length;
  }

  /**
   * Removes an entry by ID upon successful synchronization.
   */
  remove(id) {
    const filePath = this.getPendingFilePath();
    const pending = safeReadJsonSync(filePath, []);
    const updated = pending.filter((item) => item.id !== id);
    if (updated.length !== pending.length) {
      atomicWriteJsonSync(filePath, updated);
      return true;
    }
    return false;
  }

  /**
   * Records a failed attempt for an entry.
   * If attempts >= MAX_RETRIES (10), moves the entry to failed-logs.json so it doesn't block the queue.
   */
  incrementAttempt(id, errorMessage = "") {
    const filePath = this.getPendingFilePath();
    const pending = safeReadJsonSync(filePath, []);
    const idx = pending.findIndex((item) => item.id === id);
    if (idx === -1) return null;

    const entry = pending[idx];
    entry.attempts = (entry.attempts || 0) + 1;
    entry.lastAttemptAt = new Date().toISOString();
    entry.lastError = errorMessage ? String(errorMessage).slice(0, 300) : "Unknown error";

    if (entry.attempts >= MAX_RETRIES) {
      // Remove from pending and append to failed-logs.json
      pending.splice(idx, 1);
      appendEntriesSync(this.getFailedFilePath(), [entry]);
      atomicWriteJsonSync(filePath, pending);
      return { ...entry, movedToFailed: true };
    }

    pending[idx] = entry;
    atomicWriteJsonSync(filePath, pending);
    return entry;
  }

  /**
   * Clears pending entries (all, or filtered by projectId).
   */
  clearPending(projectId = null) {
    if (!this.storageDir) return;
    const filePath = this.getPendingFilePath();
    if (!projectId) {
      atomicWriteJsonSync(filePath, []);
    } else {
      const pending = safeReadJsonSync(filePath, []);
      const remaining = pending.filter((item) => String(item.projectId) !== String(projectId));
      atomicWriteJsonSync(filePath, remaining);
    }
  }
}

const offlineQueue = new OfflineQueue();

module.exports = {
  OfflineQueue,
  offlineQueue,
  PENDING_FILE,
  FAILED_FILE,
  OVERFLOW_FILE,
  MAX_PENDING_ENTRIES,
  MAX_RETRIES,
};
