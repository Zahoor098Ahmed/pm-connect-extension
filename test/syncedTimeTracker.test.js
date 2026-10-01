const fs = require("fs");
const path = require("path");
const os = require("os");
const { SyncedTimeTracker } = require("../src/syncedTimeTracker");

describe("SyncedTimeTracker", () => {
  let tmpDir;
  let tracker;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "synced-time-test-"));
    tracker = new SyncedTimeTracker(tmpDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("initial state returns 0 synced minutes", () => {
    expect(tracker.getSyncedMinutes("proj-1", "2026-09-23")).toBe(0);
    expect(tracker.getAllSyncedDates("proj-1")).toEqual({});
  });

  test("records and retrieves synced minutes accurately", () => {
    tracker.recordSynced("proj-1", "2026-09-23", 120);
    expect(tracker.getSyncedMinutes("proj-1", "2026-09-23")).toBe(120);

    const all = tracker.getAllSyncedDates("proj-1");
    expect(all["2026-09-23"]).toBe(120);
  });

  test("getPendingSyncItems detects unsynced time on first sync", () => {
    const dateBreakdown = [
      { date: "2026-09-22", minutes: 60 },
      { date: "2026-09-23", minutes: 120 },
    ];

    const pending = tracker.getPendingSyncItems("proj-1", dateBreakdown);
    expect(pending.length).toBe(2);
    expect(pending[0]).toEqual({ date: "2026-09-22", minutes: 60, unsyncedDelta: 60 });
    expect(pending[1]).toEqual({ date: "2026-09-23", minutes: 120, unsyncedDelta: 120 });
    expect(tracker.hasUnsyncedTime("proj-1", dateBreakdown)).toBe(true);
  });

  test("getPendingSyncItems returns empty when already synced (prevents 2nd sync repeat)", () => {
    const dateBreakdown = [
      { date: "2026-09-22", minutes: 60 },
      { date: "2026-09-23", minutes: 120 },
    ];

    // First sync records both
    tracker.recordBatchSynced("proj-1", dateBreakdown);

    // 2nd sync evaluation:
    const pending = tracker.getPendingSyncItems("proj-1", dateBreakdown);
    expect(pending.length).toBe(0);
    expect(tracker.hasUnsyncedTime("proj-1", dateBreakdown)).toBe(false);
  });

  test("getPendingSyncItems detects incremental delta when developer works more", () => {
    tracker.recordSynced("proj-1", "2026-09-23", 120);

    // Later in the day, 30 more minutes are logged
    const updatedBreakdown = [{ date: "2026-09-23", minutes: 150 }];

    const pending = tracker.getPendingSyncItems("proj-1", updatedBreakdown);
    expect(pending.length).toBe(1);
    expect(pending[0]).toEqual({
      date: "2026-09-23",
      minutes: 150,
      unsyncedDelta: 30,
    });
  });

  test("does not report negative delta if minutes decreased", () => {
    tracker.recordSynced("proj-1", "2026-09-23", 120);

    const decreasedBreakdown = [{ date: "2026-09-23", minutes: 100 }];
    const pending = tracker.getPendingSyncItems("proj-1", decreasedBreakdown);
    expect(pending.length).toBe(0);
  });
});
