const fs = require("fs");
const path = require("path");
const os = require("os");
const { ActivityLog, LOG_FILE } = require("../src/activityLog");

describe("ActivityLog", () => {
  let tempDir;
  let activityLog;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-activity-log-test-"));
    activityLog = new ActivityLog(tempDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("records a coding session entry with all required fields", () => {
    const entry = activityLog.recordSession({
      projectId: "proj_101",
      startTime: "14:05:12",
      endTime: "14:23:47",
      durationMinutes: 18,
      filesChanged: ["src/app.js", "src/utils.js"],
      summary: "Active coding session detected",
    });

    expect(entry.id).toMatch(/^session-/);
    expect(entry.projectId).toBe("proj_101");
    expect(entry.startTime).toBe("14:05:12");
    expect(entry.endTime).toBe("14:23:47");
    expect(entry.durationMinutes).toBe(18);
    expect(entry.type).toBe("coding-session");
    expect(entry.filesChanged).toEqual(["src/app.js", "src/utils.js"]);
    expect(entry.summary).toBe("Active coding session detected");

    const filePath = path.join(tempDir, LOG_FILE);
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(stored.length).toBe(1);
    expect(stored[0].id).toBe(entry.id);
  });

  it("records a git commit entry as type commit in the same log", () => {
    const entry = activityLog.recordCommit({
      projectId: "proj_101",
      commitSha: "abc1234def5678",
      commitMessage: "fixed login bug",
      filesChanged: ["src/auth.js"],
      timestamp: "2026-09-17T14:24:00.000Z",
    });

    expect(entry.id).toMatch(/^commit-/);
    expect(entry.type).toBe("commit");
    expect(entry.commitSha).toBe("abc1234def5678");
    expect(entry.summary).toBe("fixed login bug");
    expect(entry.filesChanged).toEqual(["src/auth.js"]);
  });

  it("maintains append-only history and returns entries newest first", () => {
    activityLog.recordSession({
      projectId: "proj_101",
      startTime: "10:00:00",
      endTime: "10:30:00",
      durationMinutes: 30,
    });

    activityLog.recordCommit({
      projectId: "proj_101",
      commitSha: "111aaa",
      commitMessage: "First commit",
    });

    activityLog.recordSession({
      projectId: "proj_101",
      startTime: "11:00:00",
      endTime: "11:15:00",
      durationMinutes: 15,
    });

    const entries = activityLog.getEntries("proj_101");
    expect(entries.length).toBe(3);
    // Newest first
    expect(entries[0].durationMinutes).toBe(15);
    expect(entries[1].type).toBe("commit");
    expect(entries[2].durationMinutes).toBe(30);
  });

  it("calculates today minutes directly from coding sessions in log", () => {
    activityLog.recordSession({
      projectId: "proj_101",
      startTime: "09:00:00",
      endTime: "09:45:00",
      durationMinutes: 45,
    });

    activityLog.recordCommit({
      projectId: "proj_101",
      commitSha: "222bbb",
      commitMessage: "Refactor",
    });

    activityLog.recordSession({
      projectId: "proj_101",
      startTime: "10:00:00",
      endTime: "10:20:00",
      durationMinutes: 20,
    });

    const todayMin = activityLog.getTodayMinutesFromLog("proj_101");
    expect(todayMin).toBe(65);
  });

  it("returns all commit comments for a project newest first", () => {
    activityLog.recordCommit({
      projectId: "proj_200",
      commitSha: "sha1",
      commitMessage: "First commit comment",
      filesChanged: ["file1.js"],
    });

    activityLog.recordSession({
      projectId: "proj_200",
      startTime: "11:00:00",
      endTime: "11:30:00",
      durationMinutes: 30,
    });

    activityLog.recordCommit({
      projectId: "proj_200",
      commitSha: "sha2",
      commitMessage: "Second commit comment",
      filesChanged: ["file2.js", "file3.js"],
    });

    activityLog.recordCommit({
      projectId: "proj_other",
      commitSha: "sha3",
      commitMessage: "Other project commit",
    });

    const commits = activityLog.getAllCommits("proj_200");
    expect(commits.length).toBe(2);
    expect(commits[0].summary).toBe("Second commit comment");
    expect(commits[1].summary).toBe("First commit comment");
    expect(commits[0].filesChanged).toEqual(["file2.js", "file3.js"]);
  });
});

