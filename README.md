# PM Connect

A VS Code extension that automatically connects your editor to a project management
backend — **zero manual interaction**. No timers to start, no progress to report by hand.
PM Connect silently tracks when a project starts, what gets committed, and how much
active coding time is spent — and sends it to your PM backend in the background.

Your company connects the exact same way any external customer would: by picking the
**"Custom / Our Website"** provider.

> **Are you a customer/end-user wanting to connect your own website to this extension?**
> Hand [INTEGRATION.md](INTEGRATION.md) to your backend developer — it has the exact API
> spec so your website works with **zero extra config** once a link + API key are set.

---

## A to Z — Guide For a New User

### A. Prerequisites

- **VS Code** installed (1.85 or newer)
- The `code` command available in your terminal (VS Code can set this up itself —
  Command Palette → "Shell Command: Install 'code' command in PATH")
- If using **Custom / Our Website**: your website's API base URL and a personal API key
  (from your backend team)
- If using **Trello**: a Trello API key + token (from trello.com/app-key)

### B. Installing the Extension

**Option 1 — from a `.vsix` file (not yet published to the Marketplace):**

```bash
code --install-extension "path/to/pm-connect-0.1.0.vsix"
```

Or via the UI: Extensions panel (`Ctrl+Shift+X`) → `...` (More Actions) →
**"Install from VSIX..."** → select the file.

**Option 2 — from the Marketplace (once published):**

Extensions panel (`Ctrl+Shift+X`) → search "PM Connect" → **Install**.

### C. Reload After Install

After installing or updating the extension, **fully reload the window**:
- `Ctrl+Shift+P` → "Developer: Reload Window", or
- close and reopen VS Code entirely

This is required every time the extension is updated — a stale extension host will
keep running old code otherwise. A new **PM Connect** icon appears in the Activity Bar
once activation succeeds.

### D. First-Time Setup — Zero-Interaction Auto-Matching

Setting up is completely automatic and requires no user interaction:

1. **Silent Handshake (Auto-Matching)**: The moment you open a project folder in VS Code, the extension automatically retrieves your Git configuration (email + remote origin URL) and machine/OS username.
2. It sends this metadata to the company's PM backend, which matches you to your assigned project.
3. If matched, the extension silently links your workspace to the project, configures your API key, and begins time and commit tracking immediately.
4. **Silent Behavior**: If you open a project or folder that is not registered or assigned to you yet in the backend system, the extension stays completely silent (no warning popups or prompts), allowing you to code normally without disruption.
5. **Fallback to Auto-Creation**: If you are already connected globally with your personal API key and open a completely new project folder, the extension automatically creates a new project (named after the folder) on the backend and links it to start tracking.

To configure settings or switch providers manually:
`Ctrl+Shift+P` → **"PM Connect: Switch Provider"**.

### E. Sharing Setup With Your Team

After connecting, you may be offered: **"Save these connection settings so teammates can
set up in one step?"** — this writes `pmconnect.config.json` (base URL + provider only,
no secrets, no project ID — project IDs are always per-folder and per-developer now).
Commit that file so new teammates skip straight to the "just paste your API key" step.

### F. What Happens Automatically (No Commands To Run)

| Signal | How it's detected | What gets sent |
|---|---|---|
| Project started | First activation for a linked folder | A one-time "project started" ping (idempotent — safe to fire every launch) |
| A commit happened | VS Code's built-in Git extension (instant) **plus** a 5-minute fallback poll (catches terminal-made commits, or environments without the Git extension) | Commit SHA, message, and changed file names |
| Active coding time | Passive: window focus + recent edits/selection changes, sampled every 30s, flushed every 60s, with an idle cutoff (`pmConnect.activity.idleThresholdMinutes`, default 5) | Accumulated seconds |

Everything above is per **git-repository root**, not just the top-level workspace
folder — if your actual `.git` lives in a subfolder (e.g. a monorepo's `frontend/`
directory), commit tracking still finds and follows it correctly.

All of this fails silently — no error dialogs ever interrupt you. Check the **"PM
Connect"** Output channel (View → Output → select "PM Connect" from the dropdown) if you
want to see what's happening under the hood.

### G. Reports Sidebar

Click the PM Connect icon in the Activity Bar → **"Reports"** panel lists every project
you've worked on, with start date, days taken, this week/month's commits and active
time, and a 30-day breakdown. It refreshes automatically every 2 minutes, or on demand
via **"PM Connect: Refresh Reports"**.

### H. Settings

`Ctrl+,` → search `pmConnect`:

| Setting | Purpose |
|---|---|
| `pmConnect.provider` | Which provider is active (`custom` or `trello`) — workspace-scoped |
| `pmConnect.custom.baseUrl` | Custom provider's API base URL |
| `pmConnect.custom.paths` | Override endpoint paths if your backend names them differently |
| `pmConnect.custom.projectId` | **Workspace-scoped, auto-managed.** You should not normally need to edit this — it's written automatically by the auto-create flow the first time a folder connects |
| `pmConnect.custom.siteUrl` | Optional — base URL of your website (for report links), if different from the API base URL |
| `pmConnect.activity.idleThresholdMinutes` | How many minutes of no activity before active-time tracking pauses (default 5) |
| `pmConnect.trello.boardId` / `pmConnect.trello.listId` | Trello board/list to pull tasks from |

> API keys/tokens never appear in settings — they live in VS Code's secure
> `SecretStorage`.

**Backend endpoints required for automatic tracking** (Custom provider): `POST
/projects/auto-match`, `POST /projects/auto-create`, `POST /projects/start`, `POST /commits`, `POST
/activity/heartbeat`, `GET /reports/rollup`, `GET /reports/my-rollups`. See
[SETUP.md](SETUP.md) for the exact contract.

### I. Common Problems

| Problem | Fix |
|---|---|
| Extension icon never appears / nothing gets tracked | Fully close and reopen VS Code after install — a stale extension host is the most common cause |
| "Cannot find module 'node-fetch'" in the Output/Extension Host log | The installed `.vsix` was packaged without its `node_modules` — rebuild with `npx vsce package` after confirming `.vscodeignore` does **not** exclude `node_modules/**` |
| Commits never show up for a project whose `.git` is in a subfolder | Update to the latest build — earlier versions only checked the workspace root; commit tracking now follows the actual git-repo root wherever the Git extension finds it |
| A folder keeps reusing another project's ID | Check that folder's own `.vscode/settings.json` — if it (or a stray `pmconnect.config.json`) has a leftover `projectId` from earlier testing, remove it and reload so auto-create can run cleanly |
| "base URL is not configured" | Set `pmConnect.custom.baseUrl`, or run `PM Connect: Connect Provider` again |
| "API key is not set" | Run `PM Connect: Connect Provider` and re-enter your key |
| Sidebar "My Tasks" is empty | Run `PM Connect: Refresh My Tasks` |

### J. Switching Providers

`Ctrl+Shift+P` → **"PM Connect: Switch Provider"** → pick the new provider → enter its
credentials. The previous provider's settings are kept, not deleted.

---

## Developer Guide (for building/modifying the extension)

### Project setup

```bash
npm install
npm test           # unit tests (mocked HTTP / mocked child_process)
npm run package     # builds the .vsix (vsce)
```

No build/bundle step — the extension is plain JavaScript (`src/*.js`), loaded via
`require()`. Because of that, **`node_modules` must be included in the packaged
`.vsix`** — `.vscodeignore` must not blanket-exclude it, or the extension will fail to
activate at all with `Cannot find module 'node-fetch'`.

### Run/Debug (F5)

1. Open this folder as the VS Code workspace root
2. `F5` (or Run and Debug panel → "Run PM Connect Extension")
3. A new "Extension Development Host" window opens with the extension active

Note: the Extension Development Host is for **development only**. Don't use it for real
day-to-day tracking — install the packaged `.vsix` in a normal window for that, so the
same activation path real users get is what you're testing.

### Adding a New Provider

1. Implement the `ProjectManagementProvider` interface in
   `src/providers/yourProvider.js` (methods: `authenticate`, `createTask`,
   `updateTaskStatus`, `listMyTasks`, `syncFileOrProject`, plus no-op stubs for
   `markProjectStarted`, `logCommitHeartbeat`, `logActiveHeartbeat`, `getRollup`,
   `autoCreateProject`, `getMyRollups` if the provider doesn't support automatic
   tracking)
2. Register it in `src/providers/index.js`
3. Add it to the `pmConnect.provider` enum in `package.json`
4. Add mocked-HTTP unit tests in `test/`

UI code (`extension.js`, TreeViews, status bar) never calls a provider's API directly —
only through the shared interface, so adding a new provider never breaks existing ones.

### Project Structure

```
src/
  extension.js          # activation, commands, auto-create-project flow
  providerContext.js     # SecretStorage + settings bridge
  providerError.js       # normalized error type
  httpUtil.js            # retry/backoff wrapper
  gitProgress.js          # git shell-out helpers (commit sha/message/diff/changed files)
  commitTracker.js        # automatic commit detection (VS Code Git API + fallback poll)
  activityTracker.js      # passive active-coding-time detection
  trackerUtils.js         # small pure helpers extracted from the two trackers above (unit-testable)
  tasksTreeView.js        # sidebar "My Tasks" panel
  reportsTreeView.js      # sidebar "Reports" panel
  statusBar.js            # status bar indicator
  providers/
    customProvider.js     # generic REST adapter
    trelloProvider.js      # Trello adapter
    index.js               # provider registry
test/                    # unit tests (mocked HTTP / mocked child_process — no VS Code integration harness)
```
