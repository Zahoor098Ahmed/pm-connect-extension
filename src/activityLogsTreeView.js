const vscode = require("vscode");
const { activityLogStore } = require("./activityLogStore");

function formatRelativeTime(iso) {
  if (!iso) return "";
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return "just now";
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(iso).toLocaleDateString();
}

class LogTreeItem extends vscode.TreeItem {
  constructor(entry) {
    super(entry.title, vscode.TreeItemCollapsibleState.None);
    this.entry = entry;
    this.description = `${formatRelativeTime(entry.timestamp)}`;
    this.tooltip = `${entry.title}\nTime: ${new Date(entry.timestamp).toLocaleString()}\nStatus: ${entry.status.toUpperCase()}\n\n${entry.detail || ""}`;
    this.contextValue = "activityLogItem";

    // Set GitHub-style icon based on type & status
    switch (entry.type) {
      case "commit":
        this.iconPath = new vscode.ThemeIcon("git-commit", new vscode.ThemeColor("charts.blue"));
        break;
      case "time":
        this.iconPath = new vscode.ThemeIcon("watch", new vscode.ThemeColor("charts.green"));
        break;
      case "sync":
        if (entry.status === "error") {
          this.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
        } else {
          this.iconPath = new vscode.ThemeIcon("pass", new vscode.ThemeColor("charts.green"));
        }
        break;
      case "queue":
        this.iconPath = new vscode.ThemeIcon("cloud-upload", new vscode.ThemeColor("charts.yellow"));
        break;
      case "summary":
        this.iconPath = new vscode.ThemeIcon("graph", new vscode.ThemeColor("charts.purple"));
        break;
      default:
        this.iconPath = new vscode.ThemeIcon("info", new vscode.ThemeColor("charts.foreground"));
        break;
    }

    this.command = {
      command: "pmConnect.showLogEntryDetail",
      title: "View Log Details",
      arguments: [entry],
    };
  }
}

class ActivityLogsTreeDataProvider {
  constructor(store = activityLogStore) {
    this.store = store;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.store.onUpdate(() => this.refresh());
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    if (element) return [];

    const logs = this.store.getRecentLogs(40);
    if (!logs || logs.length === 0) {
      const empty = new vscode.TreeItem("No activity logged yet.", vscode.TreeItemCollapsibleState.None);
      empty.description = "Logs will appear live as you code & commit";
      empty.iconPath = new vscode.ThemeIcon("history");
      return [empty];
    }

    return logs.map((entry) => new LogTreeItem(entry));
  }
}

module.exports = { ActivityLogsTreeDataProvider };
