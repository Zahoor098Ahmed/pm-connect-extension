let vscode;
try {
  vscode = require("vscode");
} catch {
  // Test environment without vscode module
}
const fetch = require("node-fetch");
const { offlineQueue } = require("./offlineQueue");
const { dailySummaryTracker, getLocalDateString } = require("./dailySummaryTracker");
const { activityLogStore } = require("./activityLogStore");

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const HEALTH_CHECK_TIMEOUT_MS = 5000; // 5 seconds

class SyncManager {
  constructor(queue = offlineQueue, tracker = dailySummaryTracker, logStore = activityLogStore) {
    this.queue = queue;
    this.tracker = tracker;
    this.logStore = logStore;
    this.outputChannel = null;
    this.statusBar = null;
    this.getProjectId = null;
    this.getApiKey = null;
    this.refreshAuthToken = null;
    this.syncInterval = null;
    this.isSyncing = false;
  }

  init({ outputChannel, statusBar, getProjectId = null, getApiKey = null, refreshAuthToken = null }) {
    this.outputChannel = outputChannel;
    this.statusBar = statusBar;
    this.getProjectId = typeof getProjectId === "function" ? getProjectId : null;
    this.getApiKey = typeof getApiKey === "function" ? getApiKey : null;
    this.refreshAuthToken = typeof refreshAuthToken === "function" ? refreshAuthToken : null;
    this.updateStatusBar();
  }

  log(message, opts = {}) {
    const timeStr = new Date().toISOString().replace("T", " ").slice(0, 19);
    const formattedLine = `${timeStr} | ${message}`;
    if (this.outputChannel) {
      this.outputChannel.appendLine(formattedLine);
    } else {
      console.log(`[PM Connect] ${formattedLine}`);
    }

    // Determine type & status for sidebar visualization
    const lower = message.toLowerCase();
    const type = opts.type || (lower.includes("commit") ? "commit" : lower.includes("queued") ? "queue" : lower.includes("sync") ? "sync" : lower.includes("daily") ? "summary" : "info");
    const status = opts.status || (lower.includes("fail") || lower.includes("error") ? "error" : lower.includes("synced") || lower.includes("success") ? "success" : lower.includes("queued") ? "warning" : "info");

    this.logStore.add({
      type,
      title: opts.title || message.replace(/^\[.*?\]\s*/, ""),
      detail: opts.detail || message,
      status,
    });
  }

  updateStatusBar(projectId = null) {
    if (this.statusBar && typeof this.statusBar.setPendingCount === "function") {
      const targetProjId = projectId !== null ? projectId : (this.getProjectId ? this.getProjectId() : null);
      const count = targetProjId ? this.queue.getPendingCount(targetProjId) : 0;
      this.statusBar.setPendingCount(count);
    }
  }

  /**
   * Health check to test whether backend is currently reachable.
   */
  async checkBackendReachable(baseUrl) {
    if (!baseUrl) return false;
    const cleanUrl = baseUrl.replace(/\/+$/, "");
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
      // Try hitting the base URL or lightweight endpoint
      const res = await fetch(cleanUrl, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timeout);
      // Any response code below 500 indicates the server is alive and responding
      return res.status < 500;
    } catch {
      return false;
    }
  }

  /**
   * Primary sequential FIFO sync worker.
   */
  async syncPendingLogs(forcedBaseUrl = null) {
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      const pending = this.queue.getPending();
      if (!pending || pending.length === 0) {
        this.updateStatusBar();
        return;
      }

      // Check if backend is reachable before starting sync
      const targetBase = forcedBaseUrl || pending[0].baseUrl;
      const isReachable = await this.checkBackendReachable(targetBase);
      if (!isReachable) {
        this.log(`[SYNC FAILED] Backend still unreachable, will retry in 5 min`);
        return;
      }

      this.log(`[SYNC] Attempting to sync ${pending.length} pending logs...`);
      let syncedCount = 0;

      for (const entry of pending) {
        try {
          // Rebuild the URL from the CURRENT configured base, never the
          // baseUrl/url baked into the entry when it was queued — otherwise
          // an entry queued against an old/retired backend keeps retrying
          // that dead address forever, even after settings point elsewhere.
          const currentBase = (forcedBaseUrl || entry.baseUrl || "").replace(/\/+$/, "");
          let url;
          if (currentBase.endsWith(".php") || currentBase.includes(".php?")) {
            const phpMap = {
              "/tasks": "?action=create",
              "/tasks/mine": "?action=mine",
              "/projects": "?action=projects",
              "/projects/start": "?action=projectstart",
              "/commits": "?action=commitheartbeat",
              "/activity/heartbeat": "?action=activeheartbeat",
              "/activity/daily-summary": "?action=dailysummary",
              "/activity/log-entry": "?action=logentry",
              "/reports/rollup": "?action=rollup",
              "/projects/auto-create": "?action=autocreateproject",
              "/reports/my-rollups": "?action=myrollups",
              "/projects/auto-match": "?action=automatch",
              "/sync-time": "?action=synctime",
            };
            const mapped = phpMap[entry.endpoint] || `?action=${entry.endpoint.replace(/[^a-zA-Z0-9]/g, "")}`;
            url = `${currentBase}${mapped}`;
          } else if (currentBase) {
            url = `${currentBase}${entry.endpoint}`;
          } else {
            url = entry.url || entry.endpoint;
          }

          let requestHeaders = { ...(entry.headers || { "Content-Type": "application/json" }) };
          if (typeof this.getApiKey === "function") {
            try {
              const activeKey = await this.getApiKey();
              if (activeKey) {
                requestHeaders["Authorization"] = `Bearer ${activeKey}`;
              }
            } catch {
              /* ignore */
            }
          }
          if (entry.projectId) {
            requestHeaders["X-Project-Id"] = entry.projectId;
          }

          let res = await fetch(url, {
            method: entry.method || "POST",
            headers: requestHeaders,
            body: JSON.stringify(entry.payload),
          });

          // If 401, attempt silent token refresh and retry once
          if (res.status === 401 && typeof this.refreshAuthToken === "function") {
            this.log(`[SYNC AUTH] 401 on ${entry.endpoint} — refreshing token and retrying...`);
            try {
              const freshKey = await this.refreshAuthToken();
              if (freshKey) {
                requestHeaders["Authorization"] = `Bearer ${freshKey}`;
                res = await fetch(url, {
                  method: entry.method || "POST",
                  headers: requestHeaders,
                  body: JSON.stringify(entry.payload),
                });
              }
            } catch {
              /* ignore */
            }
          }

          if (res.ok) {
            this.queue.remove(entry.id);
            syncedCount++;
            this.log(`[SYNCED] Log synced successfully - endpoint: ${entry.endpoint}`);
          } else if (res.status === 404) {
            // The endpoint doesn't exist on this backend at all (e.g. a
            // route the current ERP hasn't implemented) — retrying forever
            // is pointless and would jam the FIFO for every entry behind
            // it, so drop it instead of queuing another attempt.
            this.queue.remove(entry.id);
            this.log(`[DROPPED] Endpoint ${entry.endpoint} not supported by this backend (HTTP 404) — entry discarded`);
          } else if (res.status >= 500) {
            // Server error — backend down or unstable, break FIFO loop immediately
            this.queue.incrementAttempt(entry.id, `HTTP ${res.status}`);
            this.log(`[SYNC FAILED] Backend still unreachable, will retry in 5 min`);
            break;
          } else {
            // Other client error (e.g. 400 bad payload) — increment attempt
            // but keep going; a single bad entry shouldn't block every
            // other, unrelated entry queued behind it.
            const moved = this.queue.incrementAttempt(entry.id, `HTTP ${res.status}`);
            if (moved?.movedToFailed) {
              this.log(`[FAILED] Entry ${entry.id} moved to failed-logs.json after max attempts`);
            } else {
              this.log(`[SYNC WARNING] Endpoint ${entry.endpoint} returned HTTP ${res.status}`);
            }
          }
        } catch (err) {
          // Network drop during sync — break FIFO loop immediately
          this.queue.incrementAttempt(entry.id, err.message);
          this.log(`[SYNC FAILED] Backend still unreachable, will retry in 5 min`);
          break;
        }
      }

      const remaining = this.queue.getPendingCount();
      this.updateStatusBar();

      if (syncedCount > 0 && remaining === 0) {
        if (vscode?.window?.showInformationMessage) {
          vscode.window.showInformationMessage(`✅ PM Connect: ${syncedCount} logs synced successfully.`);
        }
      }
      return syncedCount;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Starts background 5-minute periodic sync interval.
   */
  startPeriodicSync(getBaseUrlFn) {
    if (this.syncInterval) clearInterval(this.syncInterval);
    this.syncInterval = setInterval(() => {
      const baseUrl = typeof getBaseUrlFn === "function" ? getBaseUrlFn() : null;
      void this.syncPendingLogs(baseUrl);
    }, SYNC_INTERVAL_MS);
  }

  stopPeriodicSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
  }

  dispose() {
    this.stopPeriodicSync();
  }
}

const syncManager = new SyncManager();

module.exports = {
  SyncManager,
  syncManager,
  SYNC_INTERVAL_MS,
};
