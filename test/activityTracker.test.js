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

  it("adds the tick when unfocused but has recent activity", () => {
    expect(accumulateSeconds(false, false, 30, true)).toBe(30);
  });

  it("adds nothing when unfocused and has recent activity but is idle", () => {
    expect(accumulateSeconds(false, true, 30, true)).toBe(0);
  });
});

describe("isValidWorkFile", () => {
  const { isValidWorkFile } = require("../src/activityTracker");

  it("accepts normal source files", () => {
    expect(isValidWorkFile("src/modules/mathWordProblem.ts")).toBe(true);
    expect(isValidWorkFile("frontend/src/screens/SubjectGradesScreen.tsx")).toBe(true);
    expect(isValidWorkFile("package.json")).toBe(true);
  });

  it("rejects build artifacts and bundle caches", () => {
    expect(isValidWorkFile(".expo/settings.json")).toBe(false);
    expect(isValidWorkFile(".expo-shared/assets.json")).toBe(false);
    expect(isValidWorkFile(".next/server/pages.js")).toBe(false);
    expect(isValidWorkFile(".cache/babel/something.json")).toBe(false);
    expect(isValidWorkFile("build/bundle.js")).toBe(false);
    expect(isValidWorkFile("dist/index.js")).toBe(false);
    expect(isValidWorkFile("node_modules/react/index.js")).toBe(false);
    expect(isValidWorkFile(".git/index")).toBe(false);
    expect(isValidWorkFile("BACKLOG.md")).toBe(false);
    expect(isValidWorkFile("package-lock.json")).toBe(false);
    expect(isValidWorkFile("yarn.lock")).toBe(false);
    expect(isValidWorkFile("app.log")).toBe(false);
    expect(isValidWorkFile("test.tmp")).toBe(false);
  });
});
