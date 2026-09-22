const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  DailySummaryTracker,
  DAILY_SUMMARY_FILE,
} = require("../src/dailySummaryTracker");

describe("DailySummaryTracker", () => {
  let tempDir;
  let tracker;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-daily-summary-test-"));
    tracker = new DailySummaryTracker(tempDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("records active seconds and converts to minutes per project and date", () => {
    // 60 seconds = 1 minute
    tracker.recordActivity("proj_1", 60, "2026-09-17");
    // another 120 seconds = 3 minutes total
    const totalMinutes = tracker.recordActivity("proj_1", 120, "2026-09-17");

    expect(totalMinutes).toBe(3);
    expect(tracker.getTodayMinutes("proj_1", "2026-09-17")).toBe(3);

    const summaryPath = path.join(tempDir, DAILY_SUMMARY_FILE);
    const content = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    expect(content["2026-09-17"]).toEqual({ proj_1: 3 });
  });

  it("isolates different projects on the same date", () => {
    tracker.recordActivity("proj_A", 300, "2026-09-17"); // 5 minutes
    tracker.recordActivity("proj_B", 600, "2026-09-17"); // 10 minutes

    const summary = tracker.getDailySummary("2026-09-17");
    expect(summary).toEqual({
      proj_A: 5,
      proj_B: 10,
    });
  });

  it("supports multi-day isolation when offline for several days", () => {
    tracker.recordActivity("proj_A", 1800, "2026-09-15"); // 30 mins on day 1
    tracker.recordActivity("proj_A", 3600, "2026-09-16"); // 60 mins on day 2
    tracker.recordActivity("proj_A", 600, "2026-09-17");  // 10 mins on day 3

    const payloads = tracker.prepareAllPayloads();
    expect(payloads.length).toBe(3);

    const day1 = payloads.find((p) => p.date === "2026-09-15");
    const day2 = payloads.find((p) => p.date === "2026-09-16");
    const day3 = payloads.find((p) => p.date === "2026-09-17");

    expect(day1.totalMinutes).toBe(30);
    expect(day2.totalMinutes).toBe(60);
    expect(day3.totalMinutes).toBe(10);
  });
});
