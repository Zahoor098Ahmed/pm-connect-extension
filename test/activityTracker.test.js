const { computeIdleGate, accumulateSeconds } = require("../src/trackerUtils");

describe("computeIdleGate", () => {
  it("is idle when there's no prior activity signal", () => {
    expect(computeIdleGate(null, Date.now(), 5 * 60 * 1000)).toBe(true);
  });

  it("is not idle right after an activity signal", () => {
    const now = 100000;
    expect(computeIdleGate(now - 1000, now, 5 * 60 * 1000)).toBe(false);
  });

  it("becomes idle once the threshold has elapsed", () => {
    const now = 100000;
    const threshold = 5 * 60 * 1000;
    expect(computeIdleGate(now - threshold, now, threshold)).toBe(true);
    expect(computeIdleGate(now - threshold - 1, now, threshold)).toBe(true);
  });
});

describe("accumulateSeconds", () => {
  it("adds the tick when focused and not idle", () => {
    expect(accumulateSeconds(true, false, 30)).toBe(30);
  });

  it("adds nothing when unfocused", () => {
    expect(accumulateSeconds(false, false, 30)).toBe(0);
  });

  it("adds nothing when idle", () => {
    expect(accumulateSeconds(true, true, 30)).toBe(0);
  });

  it("adds nothing when both unfocused and idle", () => {
    expect(accumulateSeconds(false, true, 30)).toBe(0);
  });
});
