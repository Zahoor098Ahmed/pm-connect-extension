jest.mock("child_process", () => ({ execSync: jest.fn() }));
const { execSync } = require("child_process");
const gitProgress = require("../src/gitProgress");

describe("gitProgress", () => {
  beforeEach(() => {
    execSync.mockReset();
  });

  it("runs git push in the given cwd", () => {
    execSync.mockReturnValue("");
    gitProgress.push("/repo");
    expect(execSync).toHaveBeenCalledWith("git push", expect.objectContaining({ cwd: "/repo" }));
  });

  it("returns the current commit sha, trimmed", () => {
    execSync.mockReturnValue("abc123\n");
    expect(gitProgress.currentCommitSha("/repo")).toBe("abc123");
  });

  it("returns the latest commit message", () => {
    execSync.mockReturnValue("fix: bug\n");
    expect(gitProgress.latestCommitMessage("/repo")).toBe("fix: bug");
  });

  it("counts new commits since a known sha", () => {
    execSync.mockReturnValue("3\n");
    expect(gitProgress.newCommitsSince("/repo", "abc123")).toBe(3);
    expect(execSync).toHaveBeenCalledWith("git rev-list --count abc123..HEAD", expect.objectContaining({ cwd: "/repo" }));
  });

  it("treats the first tracked push (no prior sha) as 1 new commit", () => {
    expect(gitProgress.newCommitsSince("/repo", null)).toBe(1);
    expect(execSync).not.toHaveBeenCalled();
  });

  it("falls back to 1 if the commit count is unparsable or zero", () => {
    execSync.mockReturnValue("0\n");
    expect(gitProgress.newCommitsSince("/repo", "abc123")).toBe(1);
  });

  it("newCommitsDetail returns [] with no prior sha (seeding is the caller's job)", () => {
    expect(gitProgress.newCommitsDetail("/repo", null)).toEqual([]);
    expect(execSync).not.toHaveBeenCalled();
  });

  it("newCommitsDetail parses sha+message pairs for a known range", () => {
    execSync.mockReturnValue("abc123\x1ffix login\ndef456\x1fadd tests\n");
    const commits = gitProgress.newCommitsDetail("/repo", "abc123", 20);
    expect(commits).toEqual([
      { sha: "abc123", message: "fix login" },
      { sha: "def456", message: "add tests" },
    ]);
    expect(execSync).toHaveBeenCalledWith(
      "git log --format=%H%x1f%s -n 20 abc123..HEAD",
      expect.objectContaining({ cwd: "/repo" })
    );
  });

  it("newCommitsDetail returns [] for an empty range", () => {
    execSync.mockReturnValue("");
    expect(gitProgress.newCommitsDetail("/repo", "abc123")).toEqual([]);
  });

  it("changedFiles lists the file paths touched by a commit", () => {
    execSync.mockReturnValue("src/home.php\ncss/home.css\n");
    const files = gitProgress.changedFiles("/repo", "abc123");
    expect(files).toEqual(["src/home.php", "css/home.css"]);
    expect(execSync).toHaveBeenCalledWith(
      "git show --name-only --format= abc123",
      expect.objectContaining({ cwd: "/repo" })
    );
  });

  it("changedFiles returns [] on empty output", () => {
    execSync.mockReturnValue("");
    expect(gitProgress.changedFiles("/repo", "abc123")).toEqual([]);
  });

  it("changedFiles returns [] instead of throwing if git fails", () => {
    execSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });
    expect(gitProgress.changedFiles("/repo", "abc123")).toEqual([]);
  });
});
