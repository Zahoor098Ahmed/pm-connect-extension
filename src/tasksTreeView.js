const vscode = require("vscode");

class TaskItem extends vscode.TreeItem {
  constructor(task) {
    super(task.title, vscode.TreeItemCollapsibleState.None);
    this.task = task;
    this.description = task.status;
    this.tooltip = task.description ?? task.title;
    this.contextValue = "pmConnectTask";
    this.command = { command: "pmConnect.showTaskDetail", title: "Show Task Detail", arguments: [task] };
  }
}

class StatusGroupItem extends vscode.TreeItem {
  constructor(status, tasks) {
    super(status, vscode.TreeItemCollapsibleState.Expanded);
    this.status = status;
    this.tasks = tasks;
    this.description = `${tasks.length}`;
  }
}

class TasksTreeDataProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.tasks = [];
  }

  setTasks(tasks) {
    this.tasks = tasks;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    if (!element) {
      const byStatus = new Map();
      for (const task of this.tasks) {
        const group = byStatus.get(task.status) ?? [];
        group.push(task);
        byStatus.set(task.status, group);
      }
      return Array.from(byStatus.entries()).map(([status, tasks]) => new StatusGroupItem(status, tasks));
    }
    if (element instanceof StatusGroupItem) {
      return element.tasks.map((t) => new TaskItem(t));
    }
    return [];
  }
}

module.exports = { TasksTreeDataProvider };
