const { TrelloProvider } = require("../src/providers/trelloProvider");
const { createMockContext } = require("./testUtil");

jest.mock("node-fetch", () => jest.fn());
const fetchMock = require("node-fetch");

describe("TrelloProvider", () => {
  const provider = new TrelloProvider();

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("creates a card in the configured list", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "card1", name: "Test", idList: "list1", shortUrl: "https://trello.com/c/x" }),
    });

    const ctx = createMockContext(
      { "pmConnect.trello.listId": "list1" },
      { "pmConnect.trello.apiKey": "key", "pmConnect.trello.token": "token" }
    );

    const task = await provider.createTask({ title: "Test" }, ctx);
    expect(task.id).toBe("card1");
    expect(task.status).toBe("list1");
    expect(fetchMock.mock.calls[0][0]).toContain("https://api.trello.com/1/cards?");
  });

  it("throws when list ID is not configured", async () => {
    const ctx = createMockContext({}, { "pmConnect.trello.apiKey": "key", "pmConnect.trello.token": "token" });
    await expect(provider.createTask({ title: "x" }, ctx)).rejects.toThrow("list ID is not configured");
  });

  it("throws when credentials are missing", async () => {
    const ctx = createMockContext({ "pmConnect.trello.listId": "list1" });
    await expect(provider.createTask({ title: "x" }, ctx)).rejects.toThrow("key/token not set");
  });

  it("lists cards for the configured board", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ id: "c1", name: "Card 1", idList: "list1" }],
    });
    const ctx = createMockContext(
      { "pmConnect.trello.boardId": "board1" },
      { "pmConnect.trello.apiKey": "key", "pmConnect.trello.token": "token" }
    );
    const tasks = await provider.listMyTasks(ctx);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Card 1");
  });

  it("updates a card's list via PUT", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const ctx = createMockContext({}, { "pmConnect.trello.apiKey": "key", "pmConnect.trello.token": "token" });
    await provider.updateTaskStatus("card1", "list2", ctx);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/cards/card1?"),
      expect.objectContaining({ method: "PUT" })
    );
  });

  it("reports progress as a comment on the card", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "action1" }) });
    const ctx = createMockContext({}, { "pmConnect.trello.apiKey": "key", "pmConnect.trello.token": "token" });

    await provider.reportProgress(
      "card1",
      { percentage: 40, commitsDone: 2, commitsTotal: 5, commitMessage: "add tests" },
      ctx
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/cards/card1/actions/comments?"),
      expect.objectContaining({ method: "POST" })
    );
    const calledUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(calledUrl.searchParams.get("text")).toContain("40% (2/5 commits)");
  });

  it("logs time as a comment on the card", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "action2" }) });
    const ctx = createMockContext({}, { "pmConnect.trello.apiKey": "key", "pmConnect.trello.token": "token" });

    await provider.logTime("card1", { minutes: 30, note: "reviewed PR" }, ctx);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/cards/card1/actions/comments?"),
      expect.objectContaining({ method: "POST" })
    );
    const calledUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(calledUrl.searchParams.get("text")).toContain("Time logged: 30 min");
    expect(calledUrl.searchParams.get("text")).toContain("reviewed PR");
  });

  it("has no-op stubs for the automatic-tracking methods (Trello has no equivalent)", async () => {
    await expect(provider.markProjectStarted()).resolves.toEqual({ success: false, unsupported: true });
    await expect(provider.logCommitHeartbeat()).resolves.toEqual({ success: false, unsupported: true });
    await expect(provider.logActiveHeartbeat()).resolves.toEqual({ success: false, unsupported: true });
    await expect(provider.getRollup()).resolves.toEqual({ success: false, unsupported: true });
    await expect(provider.autoCreateProject()).resolves.toEqual({ success: false, unsupported: true });
    await expect(provider.getMyRollups()).resolves.toEqual([]);
    await expect(provider.autoMatch()).resolves.toEqual({ success: false, unsupported: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
