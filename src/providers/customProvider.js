const { ProviderError } = require("../providerError");
const { fetchWithRetry } = require("../httpUtil");
const { offlineQueue } = require("../offlineQueue");
const { syncManager } = require("../syncManager");
const { backendResolver } = require("../backendResolver");

const SECRET_KEY = "pmConnect.custom.apiKey";

// Matches the live ERP's real routes — Global Tech CRM's Express server,
// mounted at /api/pmconnect (server/pmconnect.mjs). This replaced the earlier
// projex (PHP/MySQL) backend as the actual production Project Management
// system; a handful of legacy actions (createTask, autoCreateProject, the
// single-project getRollup, logDailySummary, logActivityEntry) have no
// equivalent route on the CRM yet — those calls fail closed (silently
// queued/skipped) rather than break tracking, since nothing here calls them
// as a hard requirement.
const DEFAULT_PATHS = {
  createTask: "/tasks",
  updateStatus: "/tasks/{id}/status",
  listMyTasks: "/tasks/mine",
  reportProgress: "/tasks/{id}/progress",
  logTime: "/tasks/{id}/timelog",
  listProjects: "/projects",
  markProjectStarted: "/projects/start",
  logCommitHeartbeat: "/commits",
  logActiveHeartbeat: "/activity/heartbeat",
  logDailySummary: "/activity/daily-summary",
  logActivityEntry: "/activity/log-entry",
  getRollup: "/reports/rollup",
  autoCreateProject: "/projects/auto-create",
  getMyRollups: "/my-rollups",
  autoMatch: "/projects/auto-match",
  syncTime: "/sync-time",
};

/**
 * Generic REST adapter. Works against any backend — including our own
 * company's website — as long as it exposes create/update/list endpoints.
 * There is no separate "internal" adapter; our website is just a Custom endpoint.
 */
class CustomProvider {
  id = "custom";
  displayName = "Custom / Our Website";

  /**
   * Local-first, live-fallback: if a local dev ERP is reachable right now,
   * everything goes there; otherwise everything goes to the live ERP —
   * automatically, no manual URL switching. See backendResolver.js.
   */
  getBaseUrl(context) {
    const baseUrl = backendResolver.getCachedBaseUrl(context.getConfig);
    if (!baseUrl) {
      throw new ProviderError("Custom provider base URL is not configured.", this.id);
    }
    return baseUrl.replace(/\/+$/, "");
  }

  getPaths(context) {
    // Merge over the defaults instead of replacing them outright — so a
    // settings.json written before a new action existed (e.g. listProjects)
    // doesn't silently break with an undefined path for that one key.
    return { ...DEFAULT_PATHS, ...context.getConfig("pmConnect.custom.paths", DEFAULT_PATHS) };
  }

  getProjectId(context) {
    const projectId = context.getConfig("pmConnect.custom.projectId", "");
    if (!projectId) {
      throw new ProviderError(
        "Custom provider project ID is not configured. Set 'pmConnect.custom.projectId' so tasks stay scoped to this project.",
        this.id
      );
    }
    return projectId;
  }

  async getApiKey(context) {
    const key = await context.getSecret(SECRET_KEY);
    if (!key) {
      throw new ProviderError(
        "Custom provider API key is not set. Run 'PM Connect: Connect Provider' first.",
        this.id
      );
    }
    return key;
  }

  authHeaders(apiKey, projectId) {
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Project-Id": projectId,
    };
  }

  getUrl(context, pathKey, idPlaceholderValue = null) {
    const baseUrl = this.getBaseUrl(context);
    const paths = this.getPaths(context);
    let path = paths[pathKey] || "";

    // Auto-detect if baseUrl is a PHP script or contains .php
    if (baseUrl.endsWith(".php") || baseUrl.includes(".php?")) {
      // Map standard subpaths to single PHP file query parameters
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

      let cleanPath = paths[pathKey] || "";
      if (cleanPath.startsWith("/tasks/") && cleanPath.endsWith("/status")) {
        return `${baseUrl}?action=status&id=${encodeURIComponent(idPlaceholderValue)}`;
      }
      if (cleanPath.startsWith("/tasks/") && cleanPath.endsWith("/progress")) {
        return `${baseUrl}?action=progress&id=${encodeURIComponent(idPlaceholderValue)}`;
      }
      if (cleanPath.startsWith("/tasks/") && cleanPath.endsWith("/timelog")) {
        return `${baseUrl}?action=timelog&id=${encodeURIComponent(idPlaceholderValue)}`;
      }

      const mapped = phpMap[cleanPath];
      if (mapped) {
        return `${baseUrl}${mapped}`;
      }
    }

    if (idPlaceholderValue !== null) {
      path = path.replace("{id}", encodeURIComponent(idPlaceholderValue));
    }
    return `${baseUrl}${path}`;
  }

  async authenticate(context) {
    // TODO: replace with a real "whoami"/health-check endpoint once your backend defines one.
    try {
      const url = this.getUrl(context, "listProjects");
      const apiKey = await this.getApiKey(context);
      const res = await fetchWithRetry(url, {
        method: "GET",
        headers: this.authHeaders(apiKey, "0"),
      });
      if (!res.ok) {
        return { success: false, message: `Auth check failed: HTTP ${res.status}` };
      }
      return { success: true };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  async createTask(task, context) {
    const url = this.getUrl(context, "createTask");
    const apiKey = await this.getApiKey(context);
    // Employee-ID scoping (see getProjectId) can't create tasks — there's no
    // single project to put them in — so callers may pass an explicit
    // numeric project to target instead of the configured value.
    const { projectIdOverride, ...body } = task;
    const projectId = projectIdOverride ?? this.getProjectId(context);

    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: this.authHeaders(apiKey, projectId),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new ProviderError(`Failed to create task: HTTP ${res.status}`, this.id);
    }
    return res.json();
  }

  /**
   * Lists all projects on the backend — used to let the user pick a specific
   * project when they're connected via Employee ID (which spans every
   * project) but need to create a task in exactly one of them.
   */
  async listProjects(context) {
    const url = this.getUrl(context, "listProjects");
    const apiKey = await this.getApiKey(context);

    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: this.authHeaders(apiKey, "0"),
    });

    if (!res.ok) {
      throw new ProviderError(`Failed to list projects: HTTP ${res.status}`, this.id);
    }
    const data = await res.json();
    return data.projects ?? data;
  }

  async updateTaskStatus(taskId, status, context) {
    const url = this.getUrl(context, "updateStatus", taskId);
    const apiKey = await this.getApiKey(context);
    const projectId = this.getProjectId(context);

    const res = await fetchWithRetry(url, {
      method: "PATCH",
      headers: this.authHeaders(apiKey, projectId),
      body: JSON.stringify({ status }),
    });

    if (!res.ok) {
      throw new ProviderError(`Failed to update task status: HTTP ${res.status}`, this.id);
    }
  }

  async listMyTasks(context) {
    const url = this.getUrl(context, "listMyTasks");
    const apiKey = await this.getApiKey(context);
    const projectId = this.getProjectId(context);

    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: this.authHeaders(apiKey, projectId),
    });

    if (!res.ok) {
      throw new ProviderError(`Failed to list tasks: HTTP ${res.status}`, this.id);
    }
    return res.json();
  }

  /**
   * Reports git-push-driven progress on a task: how many commits have landed
   * against it, out of the developer's estimated total, as a percentage.
   * Mirrors how GitHub activity rolls up into a PR/issue's status.
   */
  async reportProgress(taskId, progress, context) {
    const url = this.getUrl(context, "reportProgress", taskId);
    const apiKey = await this.getApiKey(context);
    const projectId = this.getProjectId(context);

    const res = await fetchWithRetry(url, {
      method: "PATCH",
      headers: this.authHeaders(apiKey, projectId),
      body: JSON.stringify(progress),
    });

    if (!res.ok) {
      throw new ProviderError(`Failed to report progress: HTTP ${res.status}`, this.id);
    }
    return res.json();
  }

  /**
   * Logs actual time spent on a task (from a start/stop timer), separate from
   * commit-based progress — this is what a timesheet/performance view would
   * be built on top of.
   */
  async logTime(taskId, timeLog, context) {
    const url = this.getUrl(context, "logTime", taskId);
    const apiKey = await this.getApiKey(context);
    const projectId = this.getProjectId(context);

    const res = await fetchWithRetry(url, {
      method: "PATCH",
      headers: this.authHeaders(apiKey, projectId),
      body: JSON.stringify(timeLog),
    });

    if (!res.ok) {
      throw new ProviderError(`Failed to log time: HTTP ${res.status}`, this.id);
    }
    return res.json();
  }

  /**
   * Helper to send automatic background logs (project start, commits, active time, daily summary)
   * with automatic offline queueing when the backend is unreachable or returns a non-2xx error.
   */
  async sendLogWithQueueFallback(pathKey, payload, context, actionName = "log", opts = {}) {
    let apiKey = "";
    let projectId = "";
    let baseUrl = "";
    let url = "";
    let headers = {};

    try {
      const rawProjectId = opts.projectIdOverride ?? context.getConfig("pmConnect.custom.projectId", "");
      if (!rawProjectId || /^EMP\d+$/i.test(rawProjectId)) {
        return { success: false, skipped: true, reason: "Project ID not configured" };
      }
      projectId = String(rawProjectId);
      apiKey = (await context.getSecret(SECRET_KEY)) || "";
      baseUrl = backendResolver.getCachedBaseUrl(context.getConfig);

      try {
        url = this.getUrl(context, pathKey);
      } catch {
        const cleanBase = baseUrl.replace(/\/+$/, "");
        if (cleanBase.endsWith(".php") || cleanBase.includes(".php?")) {
          url = `${cleanBase}?action=${pathKey}`;
        } else {
          url = `${cleanBase}/${pathKey}`;
        }
      }
      headers = this.authHeaders(apiKey, projectId);
    } catch (err) {
      if (opts.throwOnFailure) throw err;
      return { success: false, skipped: true, reason: err.message };
    }

    try {
      const res = await fetchWithRetry(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (res.status === 404) {
        if (!opts._retriedAlias) {
          const ALIAS_FALLBACKS = {
            logActiveHeartbeat: "/heartbeat",
            markProjectStarted: "/project-start",
            autoMatch: "/auto-match",
          };
          const fallbackPath = ALIAS_FALLBACKS[pathKey];
          if (fallbackPath) {
            const cleanBase = baseUrl.replace(/\/+$/, "");
            const altUrl = `${cleanBase}${fallbackPath}`;
            try {
              const altRes = await fetchWithRetry(altUrl, {
                method: "POST",
                headers,
                body: JSON.stringify(payload),
              });
              if (altRes.ok) {
                return await altRes.json();
              }
            } catch {
              /* ignore fallback error */
            }
          }
        }
        // Endpoint doesn't exist on this backend at all — queueing it would
        // just retry a request that can never succeed, jamming the FIFO for
        // every unrelated entry behind it. Drop silently instead.
        syncManager.log(`[SKIPPED] ${actionName} not supported by this backend (HTTP 404)`);
        return { success: false, skipped: true, reason: "Endpoint not supported (404)" };
      }
      if (res.status === 401 && !opts._retriedAuth) {
        syncManager.log(`[AUTH] 401 received for ${actionName} — attempting auto-refresh of token...`);
        if (typeof context.refreshAuthToken === "function") {
          try {
            const freshKey = await context.refreshAuthToken();
            if (freshKey) {
              return await this.sendLogWithQueueFallback(pathKey, payload, context, actionName, {
                ...opts,
                _retriedAuth: true,
              });
            }
          } catch {
            /* ignore */
          }
        }
      }
      if (!res.ok) {
        throw new ProviderError(`HTTP ${res.status}`, this.id);
      }
      return await res.json();
    } catch (err) {
      if (opts.throwOnFailure) {
        throw err;
      }

      // Backend unreachable or returned an error — enqueue payload
      const paths = this.getPaths(context);
      const endpoint = paths[pathKey] || `/${pathKey}`;
      offlineQueue.enqueue({
        endpoint,
        method: "POST",
        payload,
        headers,
        projectId,
        apiKey,
        baseUrl,
        url,
      });

      syncManager.log(`[QUEUED] ${actionName} log queued (backend unreachable) - projectId: ${projectId}`);
      syncManager.updateStatusBar(projectId);
      return { success: true, queued: true };
    }
  }

  /**
   * Idempotent "this project has started" ping — fired silently once per
   * workspace activation. The backend only actually changes anything the
   * very first time (started_at IS NULL), so calling this repeatedly is safe.
   */
  async markProjectStarted(context, opts = {}) {
    return this.sendLogWithQueueFallback("markProjectStarted", {}, context, "project start", opts);
  }

  /**
   * Silently reports one detected git commit — the automatic replacement for
   * the old manual "Push & Report Progress" command. Dedup'd server-side by
   * commit SHA, so the same commit can be reported more than once without inflating counts.
   */
  async logCommitHeartbeat({ commitSha, commitMessage, filesChanged }, context, opts = {}) {
    return this.sendLogWithQueueFallback(
      "logCommitHeartbeat",
      { commitSha, commitMessage, filesChanged },
      context,
      "commit",
      opts
    );
  }

  async logActiveHeartbeat({ seconds, activeFiles, date }, context, opts = {}) {
    return this.sendLogWithQueueFallback(
      "logActiveHeartbeat",
      { seconds, activeFiles, date },
      context,
      "active heartbeat",
      opts
    );
  }

  async logDailySummary({ projectId, date, totalMinutes }, context, opts = {}) {
    return this.sendLogWithQueueFallback(
      "logDailySummary",
      { projectId, date, totalMinutes },
      context,
      "daily summary",
      opts
    );
  }

  async logActivityEntry(entry, context, opts = {}) {
    return this.sendLogWithQueueFallback(
      "logActivityEntry",
      entry,
      context,
      "activity log entry",
      opts
    );
  }

  /**
   * Syncs accurate time summary (today's active minutes & cumulative minutes from start)
   * directly to the ERP. Supports both the new /sync-time endpoint and falls back
   * to daily-summary + heartbeat for standard ERP backends.
   */
  async syncTimeSummary({ projectId, todayMinutes, totalMinutes, dateBreakdown, unsyncedDeltaMinutes = 0, activeFiles = [] }, context, opts = {}) {
    try {
      const res = await this.sendLogWithQueueFallback(
        "syncTime",
        { projectId, todayMinutes, totalMinutes, dateBreakdown, activeFiles },
        context,
        "sync time",
        { ...opts, projectIdOverride: projectId }
      );
      if (res && res.success && !res.skipped) {
        return res;
      }
    } catch {
      /* fallback below */
    }

    // Never fallback to incrementing heartbeat seconds from a push/sync event!
    // Real-time heartbeats are already handled by activityTracker.
    // Calling heartbeat here would cause double-counting / duplicate minutes on the ERP.
    return { success: false, skipped: true, reason: "Backend does not support idempotent syncTime" };
  }

  /**
   * This week / this month / days-taken / 30-day breakdown — purely derived
   * from automatically-collected data, feeds the Reports sidebar panel.
   */
  async getRollup(context) {
    const url = this.getUrl(context, "getRollup");
    const apiKey = await this.getApiKey(context);
    const projectId = this.getProjectId(context);

    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: this.authHeaders(apiKey, projectId),
    });

    if (!res.ok) {
      throw new ProviderError(`Failed to load rollup: HTTP ${res.status}`, this.id);
    }
    return res.json();
  }

  /**
   * Auto-creates a project straight from VS Code — no website step needed.
   * Called silently, once, the first time a workspace with no configured
   * project ID is opened; the caller passes the folder name. Does NOT
   * require a project ID itself (there isn't one yet), only the API key.
   */
  async autoCreateProject({ name }, context) {
    const url = this.getUrl(context, "autoCreateProject");
    const apiKey = await this.getApiKey(context);

    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    if (!res.ok) {
      throw new ProviderError(`Failed to auto-create project: HTTP ${res.status}`, this.id);
    }
    return res.json();
  }

  /**
   * Performs a background handshake to match the developer identity and project.
   */
  async autoMatch({ gitEmail, machineUsername, workspaceFolderName, gitRemoteUrl }, context) {
    const url = this.getUrl(context, "autoMatch");
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gitEmail, machineUsername, workspaceFolderName, gitRemoteUrl }),
    });

    if (!res.ok) {
      throw new ProviderError(`Failed to auto-match: HTTP ${res.status}`, this.id);
    }
    return res.json();
  }

  /**
   * Every project the connected employee has real tracked activity on —
   * feeds the Reports panel's project list. Only their own projects, never
   * another developer's, and never a project they haven't actually opened.
   */
  async getMyRollups(context) {
    const url = this.getUrl(context, "getMyRollups");
    const apiKey = await this.getApiKey(context);

    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });

    if (!res.ok) {
      throw new ProviderError(`Failed to load projects: HTTP ${res.status}`, this.id);
    }
    const data = await res.json();
    return data.projects ?? [];
  }

  async syncFileOrProject(payload, context) {
    try {
      await this.createTask(
        {
          title: `Sync: ${payload.fileName ?? payload.workspaceName ?? "workspace"}`,
          description: payload.contentSnippet,
          projectIdOverride: payload.projectIdOverride,
        },
        context
      );
      return { success: true };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }
}

module.exports = { CustomProvider };
