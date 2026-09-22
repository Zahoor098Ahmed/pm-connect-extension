const fs = require("fs");
const path = require("path");
const os = require("os");
const { OfflineQueue } = require("../src/offlineQueue");
const { SyncManager } = require("../src/syncManager");

jest.mock("node-fetch", () => jest.fn());
const fetchMock = require("node-fetch");

describe("SyncManager", () => {
  let tempDir;
  let queue;
  let syncManager;
  let outputLines;
  let mockOutputChannel;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-sync-manager-test-"));
    queue = new OfflineQueue(tempDir);
    syncManager = new SyncManager(queue);
    outputLines = [];
    mockOutputChannel = {
      appendLine: (line) => outputLines.push(line),
    };
    syncManager.init({
      outputChannel: mockOutputChannel,
      statusBar: { setPendingCount: jest.fn() },
    });
    fetchMock.mockReset();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("syncs entries sequentially in strict FIFO order and removes on success", async () => {
    queue.enqueue({
      endpoint: "/commits",
      payload: { sha: "1" },
      baseUrl: "https://api.test",
    });
    queue.enqueue({
      endpoint: "/activity/heartbeat",
      payload: { seconds: 30 },
      baseUrl: "https://api.test",
    });

    // 1st call: health check (GET https://api.test)
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    // 2nd call: 1st entry (/commits)
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    // 3rd call: 2nd entry (/activity/heartbeat)
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    await syncManager.syncPendingLogs("https://api.test");

    expect(queue.getPendingCount()).toBe(0);
    expect(outputLines.some((l) => l.includes("[SYNCED] Log synced successfully - endpoint: /commits"))).toBe(true);
    expect(outputLines.some((l) => l.includes("[SYNCED] Log synced successfully - endpoint: /activity/heartbeat"))).toBe(true);
  });

  it("breaks sync loop immediately on server failure (HTTP 500) to preserve FIFO order", async () => {
    queue.enqueue({
      endpoint: "/commits",
      payload: { sha: "1" },
      baseUrl: "https://api.test",
    });
    queue.enqueue({
      endpoint: "/activity/heartbeat",
      payload: { seconds: 30 },
      baseUrl: "https://api.test",
    });

    // Health check returns OK
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    // 1st entry fails with HTTP 500
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });

    await syncManager.syncPendingLogs("https://api.test");

    // Loop should break: 1st entry incremented attempt, 2nd entry untouched
    expect(queue.getPendingCount()).toBe(2);
    const pending = queue.getPending();
    expect(pending[0].attempts).toBe(1);
    expect(pending[1].attempts).toBe(0);
    expect(outputLines.some((l) => l.includes("[SYNC FAILED] Backend still unreachable"))).toBe(true);
  });
});
