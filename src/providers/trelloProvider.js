const { ProviderError } = require("../providerError");
const { fetchWithRetry } = require("../httpUtil");

const KEY_SECRET = "pmConnect.trello.apiKey";
const TOKEN_SECRET = "pmConnect.trello.token";
const BASE_URL = "https://api.trello.com/1";

class TrelloProvider {
  id = "trello";
  displayName = "Trello";

  async getCreds(context) {
    const key = await context.getSecret(KEY_SECRET);
    const token = await context.getSecret(TOKEN_SECRET);
    if (!key || !token) {
      throw new ProviderError(
        "Trello API key/token not set. Run 'PM Connect: Connect Provider' first.",
        this.id
      );
    }
    return { key, token };
  }

  authQuery(key, token) {
    return `key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`;
  }

  mapCard(card) {
    return {
      id: card.id,
      title: card.name,
      status: card.idList,
      description: card.desc,
      url: card.shortUrl,
    };
  }

  async authenticate(context) {
    try {
      const { key, token } = await this.getCreds(context);
      const res = await fetchWithRetry(`${BASE_URL}/members/me?${this.authQuery(key, token)}`, {
        method: "GET",
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
    const { key, token } = await this.getCreds(context);
    const listId = context.getConfig("pmConnect.trello.listId", "");
    if (!listId) {
      throw new ProviderError("Trello list ID is not configured.", this.id);
    }

    const params = new URLSearchParams({
      key,
      token,
      idList: listId,
      name: task.title ?? "Untitled task",
      desc: task.description ?? "",
    });

    const res = await fetchWithRetry(`${BASE_URL}/cards?${params.toString()}`, {
      method: "POST",
    });

    if (!res.ok) {
      throw new ProviderError(`Failed to create Trello card: HTTP ${res.status}`, this.id);
    }
    const card = await res.json();
    return this.mapCard(card);
  }

  async updateTaskStatus(taskId, status, context) {
    // For Trello, "status" is interpreted as the target list ID (idList).
    const { key, token } = await this.getCreds(context);
    const params = new URLSearchParams({ key, token, idList: status });

    const res = await fetchWithRetry(
      `${BASE_URL}/cards/${encodeURIComponent(taskId)}?${params.toString()}`,
      { method: "PUT" }
    );

    if (!res.ok) {
      throw new ProviderError(`Failed to update Trello card: HTTP ${res.status}`, this.id);
    }
  }

  async listMyTasks(context) {
    const { key, token } = await this.getCreds(context);
    const boardId = context.getConfig("pmConnect.trello.boardId", "");
    if (!boardId) {
      throw new ProviderError("Trello board ID is not configured.", this.id);
    }

    const res = await fetchWithRetry(
      `${BASE_URL}/boards/${encodeURIComponent(boardId)}/cards?${this.authQuery(key, token)}`,
      { method: "GET" }
    );

    if (!res.ok) {
      throw new ProviderError(`Failed to list Trello cards: HTTP ${res.status}`, this.id);
    }
    const cards = await res.json();
    return cards.map((c) => this.mapCard(c));
  }

  /**
   * Trello has no native "% complete" field, so progress is posted as a
   * comment on the card — same idea as GitHub commits rolling up into a
   * PR/issue's activity feed.
   */
  async reportProgress(taskId, progress, context) {
    const { key, token } = await this.getCreds(context);
    const text = `Progress update: ${progress.percentage}% (${progress.commitsDone}/${progress.commitsTotal} commits)${
      progress.commitMessage ? `\nLatest commit: ${progress.commitMessage}` : ""
    }`;
    const params = new URLSearchParams({ key, token, text });

    const res = await fetchWithRetry(
      `${BASE_URL}/cards/${encodeURIComponent(taskId)}/actions/comments?${params.toString()}`,
      { method: "POST" }
    );

    if (!res.ok) {
      throw new ProviderError(`Failed to report progress on Trello card: HTTP ${res.status}`, this.id);
    }
    return res.json();
  }

  /**
   * Logs actual time spent as a card comment — Trello has no native
   * timesheet field either, so this rides the same comment-feed pattern
   * as reportProgress.
   */
  async logTime(taskId, timeLog, context) {
    const { key, token } = await this.getCreds(context);
    const text = `Time logged: ${timeLog.minutes} min${timeLog.note ? `\nNote: ${timeLog.note}` : ""}`;
    const params = new URLSearchParams({ key, token, text });

    const res = await fetchWithRetry(
      `${BASE_URL}/cards/${encodeURIComponent(taskId)}/actions/comments?${params.toString()}`,
      { method: "POST" }
    );

    if (!res.ok) {
      throw new ProviderError(`Failed to log time on Trello card: HTTP ${res.status}`, this.id);
    }
    return res.json();
  }

  async syncFileOrProject(payload, context) {
    try {
      await this.createTask(
        {
          title: `Sync: ${payload.fileName ?? payload.workspaceName ?? "workspace"}`,
          description: payload.contentSnippet,
        },
        context
      );
      return { success: true };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  // Trello has no equivalent of the automatic tracking backend endpoints
  // (project lifecycle timestamps, commit/active-time heartbeats, rollups).
  // These no-op stubs exist as a defensive second layer — the extension
  // already gates all automatic-tracking calls on `providerId === "custom"`
  // before ever reaching a provider, so these should never actually run.
  async markProjectStarted() {
    return { success: false, unsupported: true };
  }

  async logCommitHeartbeat() {
    return { success: false, unsupported: true };
  }

  async logActiveHeartbeat() {
    return { success: false, unsupported: true };
  }

  async getRollup() {
    return { success: false, unsupported: true };
  }

  async autoCreateProject() {
    return { success: false, unsupported: true };
  }

  async getMyRollups() {
    return [];
  }

  async autoMatch() {
    return { success: false, unsupported: true };
  }
}

module.exports = { TrelloProvider };
