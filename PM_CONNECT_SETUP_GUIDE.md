# PM Connect — ERP Integration & Developer Onboarding Guide

> **Standard Operating Procedure (SOP)**  
> **Version:** 1.0.0 (Production)  
> **Target Systems:** Visual Studio Code & Corporate ERP / CRM  
> **Generated PDF:** [`PM_CONNECT_SETUP_GUIDE.pdf`](file:///d:/pm-connect-extension/PM_CONNECT_SETUP_GUIDE.pdf)

---

## 1. Executive Summary & Core Architecture

**PM Connect** is an automated developer productivity bridge connecting local VS Code workspaces directly with the central Corporate ERP / Project Management system without requiring developers to operate manual timers, write repetitive progress logs, or switch contexts.

### Key Benefits:
- **Zero-Friction Passive Tracking:** Monitors active keystrokes, editor focus, and file modifications. When developers leave their desk or switch windows, the timer pauses automatically—guaranteeing 100% leak-free timesheets.
- **Git-Powered Progress Reporting:** Automatically listens to git commit and push operations. Commits, messages, and touched files are synced to the ERP dashboard, converting file paths into readable features (e.g. `voice.ts` → *Voice Module*).
- **Secure Credentials:** API keys are never stored in plain-text configs; they are sealed inside VS Code's OS-level `SecretStorage`.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                ARCHITECTURAL WORKFLOW                                  │
└────────────────────────────────────────────────────────────────────────────────────────┘

  [1. Project Manager / Admin]
             │
             ▼
   Creates Project in ERP  ────────► Generates `Project ID` & Developer API Keys
                                                      │
                                                      ▼
  [2. Developer Workspace]              Repo Clone & VS Code Initialization
             │                                        │
             ▼                                        ▼
   Installs PM Connect Extension  ◄───── Configures `pmconnect.config.json`
             │
             ├───────────────────────────────────────────────────────┐
             ▼                                                       ▼
   [3. Passive Activity Engine]                           [4. Git Commit Engine]
   • Tracks focused coding seconds                        • Detects commits (SHA & message)
   • Generates local `BACKLOG.md`                         • Maps touched files/features
   • Deduplicates idle gaps (>5 min)                      • Reports live progress %
             │                                                       │
             └───────────────────────┬───────────────────────────────┘
                                     │
                                     ▼
  [5. ERP Backend (/api/pmconnect)] ──► Real-Time Commits, Active Hours, & Daily Work Digest
```

---

## 2. Step 1: Setting Up the Project in ERP (Admin / Manager)

Before developers can connect their local workspace, the project must be registered on the ERP portal.

### 1.1 Log into the ERP Portal
Open your browser and navigate to the corporate CRM/ERP system (e.g., `https://crm.tgailab.site` or your local development URL).

### 1.2 Register the New Project
1. Navigate to **Projects** from the sidebar and click **Create New Project**.
2. Fill in the project information:
   - **Project Name:** Full name (e.g. `Special Needs Children App`).
   - **Git Repository URL:** GitHub repository clone URL (e.g. `https://github.com/company/angel-talk.git`).
   - **Assign Developers:** Assign the developer accounts responsible for the repository.
3. Save the project. The ERP will issue a unique numeric **Project ID** (e.g. `15`). Note down this ID.

### 1.3 Obtain Developer API Keys
Each developer account possesses a unique Personal Access Token (API Key) located under **User Profile > Developer API Settings** (e.g. `gt_live_sec_...`). Provide each developer with their personal key.

---

## 3. Step 2: Developer Environment Setup (VS Code)

Developers only need to perform this one-time initial configuration inside their editor.

### 2.1 Install the PM Connect Extension
1. Launch **Visual Studio Code**.
2. Open the Extensions panel by pressing `Ctrl + Shift + X` (or `Cmd + Shift + X` on macOS).
3. Click the three dots (`...`) in the top-right corner of the Extensions view.
4. Select **Install from VSIX...**.
5. Select the provided `pm-connect-0.1.0.vsix` file.

### 2.2 Connect Provider & API Key
1. Press `Ctrl + Shift + P` to open the VS Code Command Palette.
2. Type and run: `PM Connect: Connect Provider`.
3. Select **Custom / Our Website**.
4. Paste your personal **API Key** and hit **Enter**.

> **Verification:** In the bottom-left status bar of VS Code, you should see `$(check) PM Connect`. This indicates successful authentication.

---

## 4. Step 3: Repository-Level Configuration (Team Sharing)

To ensure zero friction for all teammates who clone the project, create a configuration file in the project's root folder:

### Create `pmconnect.config.json` in Project Root:
```json
{
  "provider": "custom",
  "projectId": "15",
  "projectName": "Special Needs Children App"
}
```

Commit and push this file:
```bash
git add pmconnect.config.json
git commit -m "chore: add pmconnect project configuration"
git push origin main
```

*Now, any team member who pulls the repository is automatically connected to Project `15` without manual configuration.*

---

## 5. Step 4: Daily Development & Git Sync Workflow

Once configured, developers work normally without running any manual timers:

| Activity | Developer Action | PM Connect Automation |
| :--- | :--- | :--- |
| **Writing Code** | Open files, edit code, save changes. | Tracks active coding seconds; pauses when idle (>5 min); logs sessions to `BACKLOG.md`. |
| **Git Commits** | `git commit -m "feat: added voice recognition"` | Intercepts commit SHA, message, and changed files; sends telemetry to ERP. |
| **Git Push** | `git push origin main` | Verifies remote delivery; advances task milestone and progress % on ERP. |

### Optional Integrated Push Command:
Developers can also run `Ctrl + Shift + P` ➔ **`PM Connect: Push & Report Progress`** to push commits, calculate progress, and update tasks in one step.

---

## 6. Step 5: Verification on the ERP Dashboard

Team Leads and Project Managers can immediately see:
- **Active Coding Time:** Genuine coding hours verified against keyboard activity.
- **Git Commit History:** Exact commit messages and files modified.
- **Daily Digests:** Auto-generated summaries (e.g. *"Aug 25: Worked on Voice Module, Navigation"*).
- **Milestones & Status:** Real-time completion percentages.

---

## 7. Developer FAQ & Troubleshooting

1. **Git Email Mismatch:** Ensure local Git email matches your registered ERP email:
   ```bash
   git config user.email "your.email@company.com"
   ```
2. **Status Bar Shows Warning:** Run `PM Connect: Connect Provider` to re-enter your API key.
3. **Offline Development:** If the ERP is temporarily unreachable, all commits and time heartbeats are safely buffered in local storage (`pending-logs.json`) and auto-synced once reconnected.
