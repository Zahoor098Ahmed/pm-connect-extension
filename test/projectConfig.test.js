const fs = require("fs");
const os = require("os");
const path = require("path");
const { readProjectConfig, writeProjectConfig, CONFIG_FILENAME } = require("../src/projectConfig");

function makeTempWorkspaceFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmconnect-test-"));
  return { uri: { fsPath: dir } };
}

describe("projectConfig", () => {
  it("returns null when no config file exists", () => {
    const folder = makeTempWorkspaceFolder();
    expect(readProjectConfig(folder)).toBeNull();
  });

  it("returns null for a null/undefined workspace folder", () => {
    expect(readProjectConfig(null)).toBeNull();
    expect(readProjectConfig(undefined)).toBeNull();
  });

  it("writes only shareable (non-secret) keys and reads them back", () => {
    const folder = makeTempWorkspaceFolder();
    writeProjectConfig(folder, {
      "pmConnect.provider": "custom",
      "pmConnect.custom.baseUrl": "https://example.com/api",
      "pmConnect.custom.projectId": "our-project",
      "pmConnect.custom.apiKey": "should-never-be-written", // not in SHAREABLE_KEYS
    });

    const config = readProjectConfig(folder);
    expect(config["pmConnect.provider"]).toBe("custom");
    expect(config["pmConnect.custom.baseUrl"]).toBe("https://example.com/api");
    expect(config["pmConnect.custom.projectId"]).toBe("our-project");
    expect(config["pmConnect.custom.apiKey"]).toBeUndefined();
  });

  it("skips empty-string values", () => {
    const folder = makeTempWorkspaceFolder();
    writeProjectConfig(folder, {
      "pmConnect.provider": "custom",
      "pmConnect.custom.baseUrl": "",
    });
    const config = readProjectConfig(folder);
    expect(config["pmConnect.custom.baseUrl"]).toBeUndefined();
  });

  it("writes the file at the workspace root with the expected filename", () => {
    const folder = makeTempWorkspaceFolder();
    writeProjectConfig(folder, { "pmConnect.provider": "custom" });
    expect(fs.existsSync(path.join(folder.uri.fsPath, CONFIG_FILENAME))).toBe(true);
  });

  it("returns null for malformed JSON instead of throwing", () => {
    const folder = makeTempWorkspaceFolder();
    fs.writeFileSync(path.join(folder.uri.fsPath, CONFIG_FILENAME), "{not valid json");
    expect(readProjectConfig(folder)).toBeNull();
  });
});
