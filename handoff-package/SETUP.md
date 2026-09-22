# PM Connect — Setup Guide

This single file answers three questions:
1. **How does a new user set up** the extension
2. **What does the website (backend) need to do** in this whole system
3. **What data gets saved**, and how time/activity tracking actually works

---

## 1. How a New User Sets Up

There is no manual login, credentials typing, or "Connect" button clicking. The extension connects and links developers to their projects completely hands-free using background auto-matching.

### Hands-free Silent Handshake (Auto-Matching)

```
1. Install the extension (.vsix or Marketplace), reload VS Code.
2. Open the project folder.
3. The extension automatically detects your Git configuration (user.email & remote URL) and OS username.
4. It sends a silent handshake request to the backend.
5. The backend matches your developer details and project in the database.
6. The extension saves the returned link (API Key + Project ID) and immediately starts background tracking.
```

If matching succeeds, background tracking and the Reports panel start immediately. If no match is found (e.g. the developer or project is not registered in the system yet), the extension stays **completely silent** (no error dialogs or prompts) and will try again on the next activation.

### Fallback: Auto-Creation

If a folder is opened that is not matched, but the developer is already connected globally (with an API key) and opens a new workspace, the extension can automatically create a project on the backend named after the folder, link the workspace to it, and start tracking.

### Switching Providers manually

If you ever need to manually switch your settings or providers (e.g. switching to Trello), you can run:
`Ctrl+Shift+P` → **"PM Connect: Switch Provider"**.

### What you get after setup

| UI element | Where | What it does |
|---|---|---|
| PM Connect icon | Left Activity Bar | Opens "My Tasks" and "Reports" panels |
| Status bar indicator | Bottom-left | Click to sync; color shows status |
| Command Palette commands | `Ctrl+Shift+P` → `PM Connect` | Manual actions (task creation, provider switch, etc.) |
| Reports panel | PM Connect sidebar | Every project you've touched, with automatic time/commit rollups |

---

## 2. What the Website (Backend) Needs to Do

The extension stores no data itself — **all data lives in your website's database.**
The extension is a background reporter: it silently pushes signals from VS Code to your
backend as they happen.

```
VS Code (extension)  ──HTTP request──▶  Your Website / Backend  ──▶  Database
        │                                       │
        │◀──────────── response ────────────────┘
```

### Endpoints for automatic tracking (Custom provider)

| # | Endpoint | Trigger | Authorization | Body / Response |
|---|---|---|---|---|
| 1 | `POST /projects/auto-match` | Extension activation (silent handshake) | None (Public) | Body: `{ gitEmail, machineUsername, workspaceFolderName, gitRemoteUrl }`<br>Response: `{ success: true, apiKey, projectId }` |
| 2 | `POST /projects/auto-create` | First time a folder connects with no project ID yet | `Bearer <api_key>` | Body: `{ name }`<br>Response: `{ success: true, id, name }` |
| 3 | `POST /projects/start` | Every activation of an already-linked folder | `Bearer <api_key>` | — (idempotent; server sets `started_at`) |
| 4 | `POST /commits` | A new commit is detected (Git extension or fallback poll) | `Bearer <api_key>` | Body: `{ commitSha, commitMessage, filesChanged }` |
| 5 | `POST /activity/heartbeat` | Every ~60s while developer is focused and active | `Bearer <api_key>` | Body: `{ seconds }` (delta — clamp server-side, e.g. max 900) |
| 6 | `GET /reports/rollup` | Reports panel refresh (one project, scoped by `X-Project-Id`) | `Bearer <api_key>` | — (returns weekly/monthly statistics and 30-day breakdown) |
| 7 | `GET /reports/my-rollups` | Reports panel refresh (all developer's projects) | `Bearer <api_key>` | — (returns all projects' rollup data) |

Except for `/projects/auto-match`, every request carries the developer's **API key** (`Authorization: Bearer ...`) and, where relevant, an **`X-Project-Id`** header — the backend must scope every read/write by both so that only the authenticated developer's own data is processed.

**The website is this system's source of truth.** The extension never caches or re-derives anything on its own — it always writes through to the backend and reads fresh.

### Weekly & Monthly Cron Reports (Backend only)

The backend (`C:\xampp\htdocs\projex`) includes scheduled cron jobs that run to update the Admin:
- **Weekly report (`cron/weekly-report.php`)**: Executed every Monday at 8 AM. It compiles statistics for the last 7 days for active projects, generates a PDF via `dompdf`, archives it in `uploads/reports/`, and emails it to the Admin using `PHPMailer`.
- **Monthly report (`cron/monthly-report.php`)**: Executed at the end of each month. It generates and emails a monthly rollup PDF to the Admin.

### Legacy manual endpoints (still supported, no longer the primary flow)

`PATCH /tasks/{id}/progress` and `PATCH /tasks/{id}/timelog` still exist, but the extension's UI no longer exposes manual commands for them — commit and time data now flow automatically through the heartbeats listed above.

---

## 3. What Data Gets Saved, and How Tracking Actually Works

### Per project

| Field | Where it comes from |
|---|---|
| `started_at` | Set once, on the first `POST /projects/start` (or self-heals on the first commit if that ping was ever missed) |
| `completed_at` | Set by an **admin**, from the website — never automatically, and never from the developer's side |
| Daily commit count + active seconds | Aggregated from every `/commits` and `/activity/heartbeat` call, grouped by (project, developer, date) |

### Per commit

Each detected commit is stored once (deduplicated by SHA), with its message and the
list of changed file paths. A backend can turn changed file paths into a human-readable
"what did they actually work on" summary purely from filenames (e.g. `home.php` →
"Home Page") — no manual entry, ever.

### Active time

Sampled passively — the extension only counts time where the VS Code window is
focused **and** there's been a recent edit/selection change (not idle). This is a
best-effort automatic signal, not a precise stopwatch; the goal is a realistic sense of
"was this developer actually working," not exact-to-the-second billing.

### Daily/weekly/monthly rollups

`GET /reports/rollup` and `/reports/my-rollups` should return, per project: total
commits and active minutes for "this week" and "this month," plus a day-by-day
breakdown for the last ~30 days. The Reports sidebar and any admin-facing report page
render directly from this shape — no extra client-side computation needed.

---

## Quick Reference — The Whole System At a Glance

```
┌─────────────────┐     git commit    ┌──────────────┐
│   Developer's    │ ────────────────▶ │  Local Git    │  (normal — untouched)
│   VS Code        │                   │  Repository   │
└────────┬─────────┘                   └───────────────┘
         │  (automatic, silent — no commands to run)
         ├── project start ping (once per folder, idempotent)
         ├── commit heartbeat (Git API event + 5-min fallback poll)
         ├── active-time heartbeat (every ~60s while focused & active)
         ▼
┌─────────────────────────────┐
│  Your Website (Backend)       │  ← all data lives here
│  - projects (started/completed_at)│
│  - project_daily_log (commits, active_seconds, per developer/day) │
│  - project_commit_log (sha, message, files_changed) │
│  - scoped by API key + project ID — never cross-client │
└─────────────────────────────┘
         │
         ▼
   Admin panel / Reports sidebar — both read the same rollup
   endpoints, so what the developer sees in VS Code and what
   the admin sees on the website always match.
```
