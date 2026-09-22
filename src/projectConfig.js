const fs = require("fs");
const path = require("path");

const CONFIG_FILENAME = "pmconnect.config.json";

// Non-secret fields only — this file is meant to be committed to git so a
// teammate cloning the repo inherits provider/baseUrl/projectId instantly
// and only has to paste their own personal API key.
const SHAREABLE_KEYS = [
  "pmConnect.provider",
  "pmConnect.custom.baseUrl",
  "pmConnect.custom.projectId",
  "pmConnect.custom.paths",
  "pmConnect.trello.boardId",
  "pmConnect.trello.listId",
];

function configPath(workspaceFolder) {
  return path.join(workspaceFolder.uri.fsPath, CONFIG_FILENAME);
}

function readProjectConfig(workspaceFolder) {
  if (!workspaceFolder) return null;
  const file = configPath(workspaceFolder);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Writes only the shareable (non-secret) subset of settings, so the file is
 * always safe to commit — API keys/tokens never land in it.
 */
function writeProjectConfig(workspaceFolder, values) {
  const file = configPath(workspaceFolder);
  const shareable = {};
  for (const key of SHAREABLE_KEYS) {
    if (values[key] !== undefined && values[key] !== "") {
      shareable[key] = values[key];
    }
  }
  fs.writeFileSync(file, JSON.stringify(shareable, null, 2) + "\n", "utf8");
  return file;
}

module.exports = { readProjectConfig, writeProjectConfig, CONFIG_FILENAME, SHAREABLE_KEYS };
