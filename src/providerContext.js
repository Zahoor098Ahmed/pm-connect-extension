const vscode = require("vscode");
const { readProjectConfig } = require("./projectConfig");

/**
 * @param {vscode.ExtensionContext} extContext
 */
function createProviderContext(extContext) {
  return {
    workspaceState: extContext.workspaceState,
    getSecret: (key) => extContext.secrets.get(key).then((v) => v ?? undefined),
    setSecret: (key, value) => extContext.secrets.store(key, value),
    getConfig: (key, fallback) => {
      // Scoped to the current workspace folder so settings like projectId
      // resolve per-project when a developer has multiple folders/clients open.
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const config = vscode.workspace.getConfiguration(undefined, workspaceFolder?.uri);
      const inspected = config.inspect(key);
      const explicitlySet =
        inspected &&
        (inspected.workspaceFolderValue !== undefined ||
          inspected.workspaceValue !== undefined ||
          inspected.globalValue !== undefined);

      let val;
      if (!explicitlySet) {
        const projectConfig = readProjectConfig(workspaceFolder);
        if (projectConfig && projectConfig[key] !== undefined) {
          val = projectConfig[key];
        }
      }
      if (val === undefined) {
        val = config.get(key, fallback);
      }

      if (key === "pmConnect.custom.projectId" && !val) {
        const resolved = extContext.workspaceState.get("pmConnect.autoResolvedProjectId");
        if (resolved) return resolved;
      }

      return val;
    },
  };
}

module.exports = { createProviderContext };
