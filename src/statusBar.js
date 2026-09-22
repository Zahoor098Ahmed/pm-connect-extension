const vscode = require("vscode");

class PmConnectStatusBar {
  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    this.item.command = "pmConnect.statusBarMenu";
    this.pendingCount = 0;
    this.todayMinutes = 0;
    this.currentState = "disconnected";
    this.projectName = "";
    this.item.show();
    this.render();
  }

  setProject(name) {
    this.projectName = name || "";
    this.render();
  }

  setPendingCount(count, todayMinutes = null) {
    this.pendingCount = typeof count === "number" ? Math.max(0, count) : 0;
    if (typeof todayMinutes === "number") {
      this.todayMinutes = todayMinutes;
    }
    this.render();
  }

  setTodayMinutes(minutes) {
    this.todayMinutes = typeof minutes === "number" ? Math.max(0, minutes) : 0;
    this.render();
  }

  setState(state, detail) {
    this.currentState = state;
    this.errorDetail = detail;
    this.render();
  }

  render() {
    this.item.show();

    // If explicitly disconnected
    if (this.currentState === "disconnected") {
      this.item.text = "$(debug-disconnect) PM Connect: Disconnected";
      this.item.tooltip = "PM Connect is Disconnected from ERP — Click to connect";
      this.item.backgroundColor = undefined;
      this.item.color = "#f87171"; // Light Red
      return;
    }

    // If syncing, show spinner
    if (this.currentState === "syncing") {
      this.item.text = "$(sync~spin) PM Connect: Connecting...";
      this.item.tooltip = "PM Connect: Connecting to ERP...";
      this.item.backgroundColor = undefined;
      this.item.color = "#facc15"; // Yellow
      return;
    }

    // If explicit error state
    if (this.currentState === "error") {
      this.item.text = "$(error) PM Connect: Error";
      this.item.tooltip = this.errorDetail ?? "Sync failed — Click to retry";
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      this.item.color = undefined;
      return;
    }

    // If there are pending logs in offline queue
    if (this.pendingCount > 0) {
      this.item.text = `$(cloud-upload) PM Connect: Connected (${this.pendingCount} pending)`;
      const minText = this.todayMinutes > 0 ? ` • ${this.todayMinutes}m active today` : "";
      this.item.tooltip = `PM Connect: Connected to ERP [${this.projectName || "Project"}] — ${this.pendingCount} offline logs queued (Click for menu)`;
      this.item.backgroundColor = undefined;
      this.item.color = "#fbbf24"; // Warm amber
      return;
    }

    // Default Idle / Connected
    const projSuffix = this.projectName ? ` [${this.projectName}]` : "";
    const minText = this.todayMinutes > 0 ? ` (${this.todayMinutes}m)` : "";
    this.item.text = `$(check) PM Connect: Connected${projSuffix}${minText}`;
    this.item.tooltip = `PM Connect: Connected to ERP${projSuffix}${minText} — Click to open menu`;
    this.item.backgroundColor = undefined;
    this.item.color = "#4ade80"; // Vibrant Green
  }

  dispose() {
    this.item.dispose();
  }
}

module.exports = { PmConnectStatusBar };
