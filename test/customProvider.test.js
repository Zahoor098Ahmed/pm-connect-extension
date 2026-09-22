const { CustomProvider } = require("../src/providers/customProvider");
const { createMockContext } = require("./testUtil");

jest.mock("node-fetch", () => jest.fn());
const fetchMock = require("node-fetch");

describe("CustomProvider", () => {
  const provider = new CustomProvider();

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("creates a task via POST to the configured base URL + path", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "1", title: "Test", status: "open" }),
    });

    const ctx = createMockContext(
      { "pmConnect.custom.baseUrl": "https://example.com/api", "pmConnect.custom.projectId": "our-project" },
      { "pmConnect.custom.apiKey": "secret" }
    );

    const task = await provider.createTask({ title: "Test" }, ctx);

    expect(task.id).toBe("1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/api/tasks",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Project-Id": "our-project" }),
      })
    );
  });

  it("throws a ProviderError when the base URL is missing", async () => {
    const ctx = createMockContext({});
    await expect(provider.createTask({ title: "x" }, ctx)).rejects.toThrow("base URL is not configured");
  });

  it("throws a ProviderError when the API key is missing", async () => {
    const ctx = createMockContext({
      "pmConnect.custom.baseUrl": "https://example.com",
      "pmConnect.custom.projectId": "our-project",
    });
    await expect(provider.createTask({ title: "x" }, ctx)).rejects.toThrow("API key is not set");
  });

  it("throws a ProviderError when the project ID is missing", async () => {
    const ctx = createMockContext(
      { "pmConnect.custom.baseUrl": "https://example.com" },
      { "pmConnect.custom.apiKey": "secret" }
    );
    await expect(provider.createTask({ title: "x" }, ctx)).rejects.toThrow("project ID is not configured");
  });

  it("surfaces non-ok responses as ProviderError", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const ctx = createMockContext(
      { "pmConnect.custom.baseUrl": "https://example.com", "pmConnect.custom.projectId": "our-project" },
      { "pmConnect.custom.apiKey": "secret" }
    );
    await expect(provider.createTask({ title: "x" }, ctx)).rejects.toThrow("HTTP 500");
  });

  it("lists tasks from the configured listMyTasks path, scoped to the project", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ id: "1", title: "A", status: "open" }],
    });
    const ctx = createMockContext(
      { "pmConnect.custom.baseUrl": "https://example.com", "pmConnect.custom.projectId": "our-project" },
      { "pmConnect.custom.apiKey": "secret" }
    );
    const tasks = await provider.listMyTasks(ctx);
    expect(tasks).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/tasks/mine",
      expect.objectContaining({ headers: expect.objectContaining({ "X-Project-Id": "our-project" }) })
    );
  });

  it("reports push-driven progress to the configured reportProgress path", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "1", progress: 60 }),
    });
    const ctx = createMockContext(
      { "pmConnect.custom.baseUrl": "https://example.com", "pmConnect.custom.projectId": "our-project" },
      { "pmConnect.custom.apiKey": "secret" }
    );

    await provider.reportProgress(
      "1",
      { percentage: 60, commitsDone: 3, commitsTotal: 5, commitMessage: "fix bug" },
      ctx
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/tasks/1/progress",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ percentage: 60, commitsDone: 3, commitsTotal: 5, commitMessage: "fix bug" }),
      })
    );
  });

  it("surfaces reportProgress failures as ProviderError", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const ctx = createMockContext(
      { "pmConnect.custom.baseUrl": "https://example.com", "pmConnect.custom.projectId": "our-project" },
      { "pmConnect.custom.apiKey": "secret" }
    );
    await expect(
      provider.reportProgress("missing", { percentage: 10, commitsDone: 1, commitsTotal: 10 }, ctx)
    ).rejects.toThrow("HTTP 404");
  });

  it("logs time via PATCH to the configured logTime path", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "1", totalMinutes: 45 }),
    });
    const ctx = createMockContext(
      { "pmConnect.custom.baseUrl": "https://example.com", "pmConnect.custom.projectId": "our-project" },
      { "pmConnect.custom.apiKey": "secret" }
    );

    await provider.logTime("1", { minutes: 45, note: "fixed the bug" }, ctx);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/tasks/1/timelog",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ minutes: 45, note: "fixed the bug" }),
      })
    );
  });

  it("surfaces logTime failures as ProviderError", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const ctx = createMockContext(
      { "pmConnect.custom.baseUrl": "https://example.com", "pmConnect.custom.projectId": "our-project" },
      { "pmConnect.custom.apiKey": "secret" }
    );
    await expect(provider.logTime("1", { minutes: 10 }, ctx)).rejects.toThrow("HTTP 500");
  });

  it("markProjectStarted POSTs to the configured path with no body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, startedAt: "2026-01-01", alreadyStarted: false }),
    });
    const ctx = createMockContext(
      { "pmConnect.custom.baseUrl": "https://example.com", "pmConnect.custom.projectId": "our-project" },
      { "pmConnect.custom.apiKey": "secret" }
    );

    const result = await provider.markProjectStarted(ctx);

    expect(result.alreadyStarted).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/projects/start",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("logCommitHeartbeat POSTs sha+message to the configured path", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, counted: true }) });
    const ctx = createMockContext(
      { "pmConnect.custom.baseUrl": "https://example.com", "pmConnect.custom.projectId": "our-project" },
      { "pmConnect.custom.apiKey": "secret" }
    );

    await provider.logCommitHeartbeat(
      { commitSha: "abc123", commitMessage: "fix bug", filesChanged: ["src/home.php"] },
      ctx
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/commits",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ commitSha: "abc123", commitMessage: "fix bug", filesChanged: ["src/home.php"] }),
      })
    );
  });

  it("logActiveHeartbeat POSTs seconds and activeFiles to the configured path", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, activeSecondsToday: 90 }) });
    const ctx = createMockContext(
      { "pmConnect.custom.baseUrl": "https://example.com", "pmConnect.custom.projectId": "our-project" },
      { "pmConnect.custom.apiKey": "secret" }
    );

    await provider.logActiveHeartbeat({ seconds: 30, activeFiles: ["src/app.js"] }, ctx);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/activity/heartbeat",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ seconds: 30, activeFiles: ["src/app.js"] }) })
    );
  });

  it("getRollup GETs the configured path", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, project: { id: 1 }, week: {}, month: {}, dailyBreakdown: [] }),
    });
    const ctx = createMockContext(
      { "pmConnect.custom.baseUrl": "https://example.com", "pmConnect.custom.projectId": "our-project" },
      { "pmConnect.custom.apiKey": "secret" }
    );

    const result = await provider.getRollup(ctx);

    expect(result.project.id).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/reports/rollup", expect.objectContaining({ method: "GET" }));
  });

  it("surfaces automatic-tracking endpoint failures as ProviderError when throwOnFailure is set", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const ctx = createMockContext(
      { "pmConnect.custom.baseUrl": "https://example.com", "pmConnect.custom.projectId": "our-project" },
      { "pmConnect.custom.apiKey": "secret" }
    );
    await expect(provider.markProjectStarted(ctx, { throwOnFailure: true })).rejects.toThrow("HTTP 500");
    await expect(provider.logCommitHeartbeat({ commitSha: "x" }, ctx, { throwOnFailure: true })).rejects.toThrow("HTTP 500");
    await expect(provider.logActiveHeartbeat({ seconds: 1 }, ctx, { throwOnFailure: true })).rejects.toThrow("HTTP 500");
    await expect(provider.getRollup(ctx)).rejects.toThrow("HTTP 500");
  }, 15000);

  it("enqueues tracking logs to offlineQueue when server fails without throwing", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const ctx = createMockContext(
      { "pmConnect.custom.baseUrl": "https://example.com", "pmConnect.custom.projectId": "our-project" },
      { "pmConnect.custom.apiKey": "secret" }
    );
    const result = await provider.logCommitHeartbeat({ commitSha: "xyz" }, ctx);
    expect(result.queued).toBe(true);
  });

  it("autoMatch POSTs workspace info to the automatch endpoint", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, apiKey: "autokey", projectId: 12 }),
    });
    const ctx = createMockContext({ "pmConnect.custom.baseUrl": "https://example.com" });

    const result = await provider.autoMatch({
      gitEmail: "dev@example.com",
      machineUsername: "devuser",
      workspaceFolderName: "project-dir",
      gitRemoteUrl: "git@github.com:org/repo.git"
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.apiKey).toBe("autokey");
    expect(result.projectId).toBe(12);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/projects/auto-match",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          gitEmail: "dev@example.com",
          machineUsername: "devuser",
          workspaceFolderName: "project-dir",
          gitRemoteUrl: "git@github.com:org/repo.git"
        })
      })
    );
  });
});
