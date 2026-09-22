const fs = require("fs");
const path = require("path");
const os = require("os");
const { activityLog } = require("./activityLog");

const DAILY_SUMMARY_FILE = "daily-summary.json";
const DAILY_SECONDS_FILE = "daily-summary-raw.json";

function getLocalDateString(d = new Date()) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Atomic write helper for daily summary files.
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

function safeReadJsonSync(filePath, defaultFallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return defaultFallback;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return defaultFallback;
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[DailySummary] Warning: failed to parse ${filePath}:`, err.message);
    return defaultFallback;
  }
}

class DailySummaryTracker {
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

  getSummaryFilePath() {
    this.ensureStorageDir();
    return path.join(this.storageDir, DAILY_SUMMARY_FILE);
  }

  getRawSecondsFilePath() {
    this.ensureStorageDir();
    return path.join(this.storageDir, DAILY_SECONDS_FILE);
  }

  /**
   * Accumulates active coding seconds for a specific project on the given date (defaults to today).
   * Updates both the raw seconds count and converts to integer minutes in daily-summary.json.
   */
  recordActivity(projectId, seconds, dateStr = null) {
    if (!projectId || !seconds || seconds <= 0) return 0;
    if (!this.storageDir) return 0;

    const date = dateStr || getLocalDateString();
    const rawPath = this.getRawSecondsFilePath();
    const summaryPath = this.getSummaryFilePath();

    const rawData = safeReadJsonSync(rawPath, {});
    if (!rawData[date]) rawData[date] = {};
    rawData[date][projectId] = (rawData[date][projectId] || 0) + seconds;
    atomicWriteJsonSync(rawPath, rawData);

    const summaryData = safeReadJsonSync(summaryPath, {});
    if (!summaryData[date]) summaryData[date] = {};
    const totalMinutes = Math.round(rawData[date][projectId] / 60);
    summaryData[date][projectId] = totalMinutes;
    atomicWriteJsonSync(summaryPath, summaryData);

    return totalMinutes;
  }

  /**
   * Returns today's active minutes for the specified project.
   */
  getTodayMinutes(projectId, dateStr = null) {
    if (!this.storageDir || !projectId) return 0;
    const date = dateStr || getLocalDateString();
    const summaryData = safeReadJsonSync(this.getSummaryFilePath(), {});
    const recordedMin = summaryData[date]?.[projectId] || 0;
    const logMin = activityLog.getTodayMinutesFromLog(projectId, date);
    return Math.max(recordedMin, logMin);
  }

  /**
   * Returns project-wise breakdown for a specific date.
   */
  getDailySummary(dateStr = null) {
    if (!this.storageDir) return {};
    const date = dateStr || getLocalDateString();
    const summaryData = safeReadJsonSync(this.getSummaryFilePath(), {});
    return summaryData[date] || {};
  }

  /**
   * Returns all stored date-wise project summaries.
   */
  getAllSummaries() {
    if (!this.storageDir) return {};
    return safeReadJsonSync(this.getSummaryFilePath(), {});
  }

  /**
   * Generates summary payloads ({ projectId, date, totalMinutes }) for all projects on a date.
   */
  preparePayloadsForDate(dateStr = null) {
    const date = dateStr || getLocalDateString();
    const summary = this.getDailySummary(date);
    return Object.entries(summary).map(([projectId, totalMinutes]) => ({
      projectId,
      date,
      totalMinutes,
    }));
  }

  /**
   * Generates summary payloads for all historical dates stored locally.
   * Enables syncing each day separately if the system was offline for multiple days.
   */
  prepareAllPayloads() {
    const all = this.getAllSummaries();
    const payloads = [];
    for (const [date, projectMap] of Object.entries(all)) {
      for (const [projectId, totalMinutes] of Object.entries(projectMap)) {
        payloads.push({ projectId, date, totalMinutes });
      }
    }
    return payloads;
  }
}

const dailySummaryTracker = new DailySummaryTracker();

module.exports = {
  DailySummaryTracker,
  dailySummaryTracker,
  getLocalDateString,
  DAILY_SUMMARY_FILE,
};
