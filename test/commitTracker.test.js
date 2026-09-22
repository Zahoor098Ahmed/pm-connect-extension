const { shouldFallbackPoll } = require("../src/trackerUtils");

describe("shouldFallbackPoll", () => {
  it("polls when never polled before", () => {
    expect(shouldFallbackPoll(0, Date.now(), 5000)).toBe(true);
    expect(shouldFallbackPoll(undefined, Date.now(), 5000)).toBe(true);
  });

  it("does not poll if the interval hasn't elapsed", () => {
    const now = 100000;
    expect(shouldFallbackPoll(now - 1000, now, 5000)).toBe(false);
  });

  it("polls once the interval has elapsed", () => {
    const now = 100000;
    expect(shouldFallbackPoll(now - 5000, now, 5000)).toBe(true);
    expect(shouldFallbackPoll(now - 6000, now, 5000)).toBe(true);
  });
});
