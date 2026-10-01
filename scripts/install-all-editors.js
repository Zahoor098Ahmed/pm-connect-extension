#!/usr/bin/env node
/**
 * Automatically detects and installs PM Connect into ALL VS Code-compatible editors:
 * - Antigravity IDE
 * - Microsoft VS Code
 * - Trae / Trae Solo
 * - Kiro
 * - Cursor
 * - Windsurf
 * - VSCodium
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT_DIR = path.resolve(__dirname, "..");
const VSIX_PATH = path.join(ROOT_DIR, "pm-connect-0.1.0.vsix");

if (!fs.existsSync(VSIX_PATH)) {
  console.error(`[ERROR] VSIX package not found at: ${VSIX_PATH}`);
  console.log("Run 'npm run package' first to build the .vsix file.");
  process.exit(1);
}

const homeDir = os.homedir();
const localPrograms = path.join(homeDir, "AppData", "Local", "Programs");

const KNOWN_EDITORS = [
  {
    name: "Antigravity IDE",
    cmd: "antigravity-ide",
    fallbackPaths: [
      path.join(localPrograms, "Antigravity IDE", "bin", "antigravity-ide.cmd"),
      path.join(localPrograms, "Antigravity", "bin", "antigravity.cmd"),
    ],
    extDirs: [
      path.join(homeDir, ".antigravity-ide", "extensions"),
      path.join(homeDir, ".antigravity", "extensions"),
    ],
  },
  {
    name: "VS Code",
    cmd: "code",
    fallbackPaths: [
      path.join(localPrograms, "Microsoft VS Code", "bin", "code.cmd"),
    ],
    extDirs: [
      path.join(homeDir, ".vscode", "extensions"),
    ],
  },
  {
    name: "Trae",
    cmd: "trae",
    fallbackPaths: [
      path.join(localPrograms, "Trae", "bin", "trae.cmd"),
      path.join(localPrograms, "TRAE SOLO", "bin", "trae.cmd"),
    ],
    extDirs: [
      path.join(homeDir, ".trae", "extensions"),
    ],
  },
  {
    name: "Kiro",
    cmd: "kiro",
    fallbackPaths: [
      path.join(localPrograms, "Kiro", "bin", "kiro.cmd"),
    ],
    extDirs: [
      path.join(homeDir, ".kiro", "extensions"),
    ],
  },
  {
    name: "Cursor",
    cmd: "cursor",
    fallbackPaths: [
      path.join(localPrograms, "cursor", "resources", "app", "bin", "cursor.cmd"),
      path.join(localPrograms, "Cursor", "bin", "cursor.cmd"),
    ],
    extDirs: [
      path.join(homeDir, ".cursor", "extensions"),
    ],
  },
  {
    name: "Windsurf",
    cmd: "windsurf",
    fallbackPaths: [
      path.join(localPrograms, "windsurf", "bin", "windsurf.cmd"),
      path.join(localPrograms, "Windsurf", "bin", "windsurf.cmd"),
    ],
    extDirs: [
      path.join(homeDir, ".windsurf", "extensions"),
    ],
  },
  {
    name: "VSCodium",
    cmd: "codium",
    fallbackPaths: [
      path.join(localPrograms, "VSCodium", "bin", "codium.cmd"),
    ],
    extDirs: [
      path.join(homeDir, ".vscode-oss", "extensions"),
    ],
  },
];

function findExecutable(editor) {
  try {
    execSync(`where ${editor.cmd}`, { stdio: "ignore" });
    return editor.cmd;
  } catch {
    // not in PATH
  }

  for (const p of editor.fallbackPaths) {
    if (fs.existsSync(p)) {
      return `"${p}"`;
    }
  }

  return null;
}

console.log("==================================================");
console.log("🚀 PM Connect — Universal Multi-Editor Installer");
console.log("==================================================");
console.log(`📦 VSIX: ${VSIX_PATH}\n`);

let installedCount = 0;

for (const editor of KNOWN_EDITORS) {
  const exe = findExecutable(editor);

  let success = false;
  if (exe) {
    process.stdout.write(`Installing to ${editor.name}... `);
    try {
      execSync(`${exe} --install-extension "${VSIX_PATH}" --force`, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
      });
      console.log("✅ SUCCESS");
      installedCount++;
      success = true;
    } catch (err) {
      console.log(`⚠️ CLI error, attempting direct install fallback...`);
    }
  }

  if (!success) {
    const existingDirs = editor.extDirs.filter((d) => fs.existsSync(d));
    if (existingDirs.length > 0) {
      const targetBase = existingDirs[0];
      const targetExtDir = path.join(targetBase, "time-global-tech.pm-connect-0.1.0");
      try {
        if (!fs.existsSync(targetExtDir)) {
          fs.mkdirSync(targetExtDir, { recursive: true });
        }
        const toCopy = ["src", "resources", "node_modules", "package.json"];
        for (const item of toCopy) {
          const srcPath = path.join(ROOT_DIR, item);
          const destPath = path.join(targetExtDir, item);
          if (fs.existsSync(srcPath)) {
            fs.cpSync(srcPath, destPath, { recursive: true });
          }
        }
        console.log(`✅ Direct copy SUCCESS for ${editor.name} -> ${targetExtDir}`);
        installedCount++;
      } catch (copyErr) {
        console.log(`⚠️ Fallback install failed for ${editor.name}: ${copyErr.message}`);
      }
    }
  }
}

console.log("\n--------------------------------------------------");
console.log(`🎉 Finished! Successfully installed in ${installedCount} editor(s).`);
console.log("Reload or restart any open editor to activate PM Connect.");
console.log("==================================================");
