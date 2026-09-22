const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  OfflineQueue,
  PENDING_FILE,
  FAILED_FILE,
  OVERFLOW_FILE,
  MAX_RETRIES,
} = require("../src/offlineQueue");

describe("OfflineQueue", () => {
  let tempDir;
  let queue;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-offline-queue-test-"));
    queue = new OfflineQueue(tempDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("enqueues and retrieves entries in strict FIFO order", () => {
    queue.enqueue({
      endpoint: "/commits",
      payload: { sha: "111" },
      projectId: "proj-1",
      apiKey: "key-1",
      baseUrl: "https://api.test",
    });

    queue.enqueue({
      endpoint: "/activity/heartbeat",
      payload: { seconds: 60 },
      projectId: "proj-1",
      apiKey: "key-1",
      baseUrl: "https://api.test",
    });

    const pending = queue.getPending();
    expect(pending.length).toBe(2);
    expect(pending[0].endpoint).toBe("/commits");
    expect(pending[0].payload.sha).toBe("111");
    expect(pending[1].endpoint).toBe("/activity/heartbeat");
    expect(pending[1].payload.seconds).toBe(60);
    expect(queue.getPendingCount()).toBe(2);
  });

  it("removes entry by id", () => {
    const e1 = queue.enqueue({ endpoint: "/a", payload: {} });
    const e2 = queue.enqueue({ endpoint: "/b", payload: {} });

    expect(queue.getPendingCount()).toBe(2);
    const removed = queue.remove(e1.id);
    expect(removed).toBe(true);

    const pending = queue.getPending();
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe(e2.id);
  });

  it("increments attempt count and moves to failed-logs.json after 10 attempts", () => {
    const entry = queue.enqueue({ endpoint: "/commits", payload: { sha: "abc" } });

    for (let i = 1; i < MAX_RETRIES; i++) {
      const updated = queue.incrementAttempt(entry.id, `Error ${i}`);
      expect(updated.attempts).toBe(i);
      expect(queue.getPendingCount()).toBe(1);
    }

    // 10th attempt: should move to failed-logs.json and be removed from pending
    const finalResult = queue.incrementAttempt(entry.id, "Fatal Error 10");
    expect(finalResult.movedToFailed).toBe(true);
    expect(queue.getPendingCount()).toBe(0);

    const failedPath = path.join(tempDir, FAILED_FILE);
    expect(fs.existsSync(failedPath)).toBe(true);
    const failedContent = JSON.parse(fs.readFileSync(failedPath, "utf8"));
    expect(failedContent.length).toBe(1);
    expect(failedContent[0].id).toBe(entry.id);
    expect(failedContent[0].attempts).toBe(10);
  });

  it("recovers gracefully from corrupted JSON file without crashing", () => {
    const pendingPath = path.join(tempDir, PENDING_FILE);
    fs.writeFileSync(pendingPath, "INVALID JSON {{{", "utf8");

    // Should return empty array instead of throwing
    expect(queue.getPending()).toEqual([]);
    expect(queue.getPendingCount()).toBe(0);

    // Enqueueing should overwrite corrupt file with valid JSON
    queue.enqueue({ endpoint: "/test", payload: {} });
    expect(queue.getPendingCount()).toBe(1);
  });
});
