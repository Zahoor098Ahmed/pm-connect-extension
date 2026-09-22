const vscode = require("vscode");
const { getCurrentSessionFiles } = require("./activityTracker");
const { dailySummaryTracker } = require("./dailySummaryTracker");
const { activityLog, getLocalDateString } = require("./activityLog");

function formatMinutes(minutes) {
  if (!minutes) return "0m";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatDate(iso) {
  if (!iso) return null;
  const clean = String(iso).replace(" ", "T");
  const d = new Date(clean);
  return isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

class ProjectSummaryItem extends vscode.TreeItem {
  constructor(entry) {
    const { project } = entry;
    const started = formatDate(project.startedAt);
    const label = project.employee ? `${project.name} (${project.employee})` : project.name;
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.entry = entry;
    this.description = started
      ? `${project.completedAt ? "Completed" : "Started"} ${started}${
          project.daysTaken != null ? ` — ${project.daysTaken}d` : ""
        }`
      : "Not started yet";
    this.iconPath = new vscode.ThemeIcon(project.completedAt ? "check" : "sync");
    this.tooltip = `${label} — click to expand`;
  }
}

class InfoItem extends vscode.TreeItem {
  constructor(label, description) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
  }
}

class AllCommentsGroupItem extends vscode.TreeItem {
  constructor(projectId) {
    const commits = activityLog.getAllCommits(projectId);
    const count = commits.length;
    super(
      `All Commit Comments (${count})`,
      count > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    this.projectId = projectId;
    this.commits = commits;
    this.iconPath = new vscode.ThemeIcon("comment-discussion");
    this.description = count > 0 ? `${count} comment${count > 1 ? "s" : ""}` : "none yet";
    this.tooltip = `All commit comments & messages for this project in one place (${count} comments)`;
  }
}

class CommitCommentItem extends vscode.TreeItem {
  constructor(item) {
    const files = item.filesChanged || [];
    const hasFiles = files.length > 0;
    const shortSha = item.commitSha ? item.commitSha.slice(0, 7) : "";
    const label = `"${item.summary || "Commit"}"`;
    super(
      label,
      hasFiles ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    this.entry = item;
    const timeStr = item.startTime ? item.startTime.slice(0, 5) : "";
    this.description = `${item.date}${timeStr ? " " + timeStr : ""}${shortSha ? ` • ${shortSha}` : ""}${hasFiles ? ` • ${files.length} file${files.length > 1 ? "s" : ""}` : ""}`;
    this.iconPath = new vscode.ThemeIcon("comment");
    this.tooltip = `Comment: "${item.summary}"\nDate: ${item.date} ${item.startTime || ""}\nCommit SHA: ${item.commitSha || "N/A"}\nPages/Files changed (${files.length}):\n${files.map((f) => ` • ${f}`).join("\n") || "None"}`;
  }
}

class DailyGroupItem extends vscode.TreeItem {
  constructor(dailyBreakdown, projectId) {
    super("Daily History & Logs (By Date)", vscode.TreeItemCollapsibleState.Expanded);
    this.dailyBreakdown = dailyBreakdown;
    this.projectId = projectId;
    this.iconPath = new vscode.ThemeIcon("calendar");
    this.tooltip = "Every day's activity log — expand any date to see its commit comments, sessions, and files";
  }
}

class DailyEntryItem extends vscode.TreeItem {
  constructor(entry, projectId) {
    const rawDate = entry.date;
    const isToday = rawDate === getLocalDateString();
    const formatted = formatDate(rawDate) || rawDate;
    const dateLabel = isToday ? `Today (${formatted})` : formatted;
    super(
      dateLabel,
      isToday ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    );
    this.entry = entry;
    this.rawDate = rawDate;
    this.projectId = projectId;
    this.iconPath = new vscode.ThemeIcon(isToday ? "calendar" : "history");
    this.description = `${entry.commits || 0} commits • ${formatMinutes(entry.activeMinutes || 0)}`;
    this.tooltip = `Date: ${rawDate}\nCommits: ${entry.commits || 0}\nActive Time: ${formatMinutes(entry.activeMinutes || 0)}\n(Click to expand this date's comments, coding sessions, and files)`;
  }
}

class TodayFilesGroupItem extends vscode.TreeItem {
  constructor(projectId) {
    const fromLog = activityLog.getTodayFiles(projectId);
    const fromSession = typeof getCurrentSessionFiles === "function" ? getCurrentSessionFiles() : [];
    const allFiles = Array.from(new Set([...fromLog, ...fromSession])).filter(Boolean);
    const count = allFiles.length;

    super(
      `Today's Changed Files (${count})`,
      count > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    );
    this.projectId = projectId;
    this.files = allFiles;
    this.iconPath = new vscode.ThemeIcon("files");
    this.description = count > 0 ? `${count} file${count > 1 ? "s" : ""}` : "none yet";
    this.tooltip = `All files/pages worked on today since morning (${count} files)`;
  }
}

class ActivityHistoryGroupItem extends vscode.TreeItem {
  constructor(projectId) {
    super("Activity & Commit Timeline", vscode.TreeItemCollapsibleState.Collapsed);
    this.projectId = projectId;
    this.iconPath = new vscode.ThemeIcon("history");
    this.tooltip = "Detailed Git-style session and commit history";
  }
}

class ChangedFileItem extends vscode.TreeItem {
  constructor(filePath) {
    const cleanPath = String(filePath).replace(/\\/g, "/");
    const baseName = cleanPath.split("/").pop() || cleanPath;
    super(baseName, vscode.TreeItemCollapsibleState.None);
    this.description = cleanPath !== baseName ? cleanPath : "";
    this.iconPath = vscode.ThemeIcon.File;
    this.tooltip = `Page/File changed: ${cleanPath}\n(Click to open in editor)`;

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, cleanPath);
      this.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [fileUri],
      };
    }
  }
}

class ActivityHistoryEntryItem extends vscode.TreeItem {
  constructor(item) {
    const isCommit = item.type === "commit";
    const files = item.filesChanged || [];
    const hasFiles = files.length > 0;
    const fileCountBadge = hasFiles ? ` • ${files.length} page${files.length > 1 ? "s" : ""}` : "";
    const label = isCommit
      ? `Commit: ${item.commitSha ? item.commitSha.slice(0, 7) + " — " : ""}${item.summary}`
      : `Session: ${item.startTime} – ${item.endTime} (${item.durationMinutes}m)`;

    super(
      label,
      hasFiles ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );

    this.entry = item;
    this.description = `${item.date}${fileCountBadge}`;
    this.iconPath = new vscode.ThemeIcon(isCommit ? "git-commit" : "watch");
    this.tooltip = `${label}\nDate: ${item.date}\nPages/Files changed (${files.length}):\n${files.map((f) => ` • ${f}`).join("\n") || "None"}`;
  }
}

class EmptyStateItem extends vscode.TreeItem {
  constructor(message) {
    super(message, vscode.TreeItemCollapsibleState.None);
  }
}

/**
 * Lists every project the connected employee has real tracked activity on —
 * never another developer's projects, never a project that was only created
 * on the website and never actually opened in VS Code. Click a project to
 * expand its own start/end date, days taken, this week/month's activity,
 * and a 30-day breakdown — all inline here, nothing opens a browser tab.
 * Entirely read-only, populated from the backend's `getMyRollups` response.
 */

function mergeWithLocalDailySummaries(projectId, projectName, backendBreakdown = []) {
  const localSummaries = dailySummaryTracker.getAllSummaries();
  const breakdownMap = new Map();
  for (const d of backendBreakdown) {
    if (d?.date) breakdownMap.set(d.date, { ...d });
  }

  for (const [date, projMap] of Object.entries(localSummaries)) {
    const localMin = projMap[String(projectId)] || projMap[projectName];
    if (localMin && localMin > 0) {
      if (!breakdownMap.has(date)) {
        breakdownMap.set(date, { date, commits: 0, activeMinutes: localMin, isLocal: true });
      } else {
        const existing = breakdownMap.get(date);
        existing.activeMinutes = Math.max(existing.activeMinutes || 0, localMin);
      }
    }
  }
  return Array.from(breakdownMap.values()).sort((a, b) => (b.date > a.date ? 1 : -1));
}

class ReportsTreeDataProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.rollups = null; // array of { project, week, month, dailyBreakdown }
    activityLog.onUpdate(() => this._onDidChangeTreeData.fire());
  }

  setRollups(rollups) {
    this.rollups = rollups;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    if (!element) {
      if (!this.rollups) {
        return [new EmptyStateItem("Connect PM Connect to see your projects here.")];
      }
      if (!this.rollups.length) {
        return [new EmptyStateItem("No projects yet — open a folder in VS Code to create one automatically.")];
      }
      return this.rollups.map((entry) => new ProjectSummaryItem(entry));
    }

    if (element instanceof ProjectSummaryItem) {
      const { project, week, month, dailyBreakdown } = element.entry;
      const combinedDaily = mergeWithLocalDailySummaries(project.id, project.name, dailyBreakdown ?? []);
      return [
        ...(project.employee ? [new InfoItem("Developer", project.employee)] : []),
        new InfoItem("Started", formatDate(project.startedAt) ?? "Not started yet"),
        new InfoItem("Completed", project.completedAt ? formatDate(project.completedAt) : "In progress"),
        new InfoItem("Days taken", project.daysTaken != null ? String(project.daysTaken) : "—"),
        new InfoItem("This week", `${week?.commits ?? 0} commits, ${formatMinutes(week?.activeMinutes ?? 0)}`),
        new InfoItem("This month", `${month?.commits ?? 0} commits, ${formatMinutes(month?.activeMinutes ?? 0)}`),
        new AllCommentsGroupItem(project.id),
        new DailyGroupItem(combinedDaily, project.id),
        new TodayFilesGroupItem(project.id),
        new ActivityHistoryGroupItem(project.id),
      ];
    }

    if (element instanceof AllCommentsGroupItem) {
      if (!element.commits.length) return [new EmptyStateItem("No commit comments recorded yet.")];
      return element.commits.map((c) => new CommitCommentItem(c));
    }

    if (element instanceof CommitCommentItem) {
      const files = element.entry?.filesChanged || [];
      if (!files.length) return [new EmptyStateItem("No pages/files recorded for this commit.")];
      return files.map((file) => new ChangedFileItem(file));
    }

    if (element instanceof TodayFilesGroupItem) {
      if (!element.files.length) return [new EmptyStateItem("No files worked on today yet.")];
      return element.files.map((file) => new ChangedFileItem(file));
    }

    if (element instanceof DailyGroupItem) {
      if (!element.dailyBreakdown.length) return [new EmptyStateItem("No activity recorded yet.")];
      return element.dailyBreakdown.map((entry) => new DailyEntryItem(entry, element.projectId));
    }

    if (element instanceof DailyEntryItem) {
      const rawDate = element.rawDate;
      const dateEntries = activityLog.getEntriesForDate(element.projectId, rawDate);
      const items = [];

      const commitsCount = element.entry?.commits || 0;
      const activeMinutes = element.entry?.activeMinutes || 0;
      items.push(
        new InfoItem(
          "Day Total",
          `${formatMinutes(activeMinutes)} active coding • ${commitsCount} commit${commitsCount !== 1 ? "s" : ""}`
        )
      );

      if (dateEntries.length > 0) {
        for (const item of dateEntries) {
          if (item.type === "commit") {
            items.push(new CommitCommentItem(item));
          } else {
            items.push(new ActivityHistoryEntryItem(item));
          }
        }
      } else {
        if (commitsCount > 0) {
          items.push(new InfoItem("Commits", `${commitsCount} commit(s) reported`));
        }
        if (activeMinutes > 0) {
          items.push(new InfoItem("Active Time", `${formatMinutes(activeMinutes)} logged`));
        }
      }

      return items;
    }

    if (element instanceof ActivityHistoryGroupItem) {
      const entries = activityLog.getEntries(element.projectId, 30);
      if (!entries.length) return [new EmptyStateItem("No session or commit history yet.")];
      return entries.map((e) => new ActivityHistoryEntryItem(e));
    }

    if (element instanceof ActivityHistoryEntryItem) {
      const files = element.entry?.filesChanged || [];
      if (!files.length) return [new EmptyStateItem("No pages/files recorded for this entry.")];
      return files.map((file) => new ChangedFileItem(file));
    }

    return [];
  }
}

module.exports = { ReportsTreeDataProvider };
