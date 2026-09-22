# PM Connect — Zero-Interaction Automatic Tracking

## Context

Ab tak PM Connect extension mein progress/time tracking **manual** thi — developer ko khud "Start Timer", "Stop Timer", ya "Push & Report Progress" chalana padta tha, task select karna padta tha, commits ka andaza dena padta tha. Sir (client) ko yeh approach pasand nahi aayi — unki demand hai ke **developer ko kuch bhi na karna pade**: extension khud silently track kare ke project kab shuru hua, roz kya kaam hua (commits/active coding time se), aur jab project complete ho (admin website se mark kare) to end date bhi record ho. Har hafte/mahine ka progress khud-ba-khud calculate ho, aur ek downloadable PDF report bhi mil sake.

Yeh badlav dono jagah lagega: **VS Code extension** (`d:\pm-connect-extension`) aur **Projex website backend** (`C:\xampp\htdocs\projex`). Manual commands (Start/Stop Timer, Push & Report Progress) hata diye jayenge — sirf automatic, silent tracking rahegi. VS Code mein ek naya "Reports" sidebar panel banega jisme har project ka start date, days taken, is hafte/mahine ka progress dikhega. Website pe admin "Mark Project Complete" bata sake aur PDF-printable report download kar sake.

**Zaroori design decisions (user se confirm hue):**
- Manual timer/push commands **completely hatane hain**, sirf automatic tracking rahegi.
- Naya sidebar TreeView VS Code mein — projects list + har ek ka detail.
- Report download **PDF** format mein (browser Print → Save as PDF se, koi naya PHP dependency add kiye bina).
- "Project start" = jab developer **pehli baar us project ka VS Code folder khole** (workspace/extension activation).
- "Project complete" = **admin website se** mark kare (developer isme involve nahi, code se reliably detect nahi ho sakta).

---

## PART 1 — Backend (`C:\xampp\htdocs\projex`)

### 1.1 Naya migration file: `pm-connect-tracking-migration.sql`

`pm-connect-migration.sql` waisi hi rehne degi (already applied). Naya file banao:

```sql
-- 1. activity_log ka pehle koi migration file nahi tha (sirf live DB mein tha) — ab add karo
CREATE TABLE IF NOT EXISTS `activity_log` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `employee` VARCHAR(255) NOT NULL,
  `action` VARCHAR(50) NOT NULL,
  `task_id` INT NULL,
  `task_title` VARCHAR(255) NULL,
  `detail` VARCHAR(500) NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. Project lifecycle timestamps
ALTER TABLE `projects`
  ADD COLUMN `started_at` TIMESTAMP NULL DEFAULT NULL AFTER `created_at`,
  ADD COLUMN `completed_at` TIMESTAMP NULL DEFAULT NULL AFTER `started_at`;
-- days taken = DATEDIFF(COALESCE(completed_at, NOW()), started_at)

-- 3. Daily rollup — commits + active coding seconds, per (project, employee, date)
CREATE TABLE IF NOT EXISTS `project_daily_log` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `project_id` INT UNSIGNED NOT NULL,
  `employee` VARCHAR(255) NOT NULL,
  `log_date` DATE NOT NULL,
  `commits_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `active_seconds` INT UNSIGNED NOT NULL DEFAULT 0,
  `first_activity_at` TIMESTAMP NULL DEFAULT NULL,
  `last_activity_at` TIMESTAMP NULL DEFAULT NULL,
  `last_commit_sha` VARCHAR(40) NULL,
  `last_commit_message` VARCHAR(255) NULL,
  UNIQUE KEY `uniq_project_employee_date` (`project_id`, `employee`, `log_date`),
  CONSTRAINT `fk_daily_log_project` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. Commit dedup — same SHA se do baar count na ho (event handler + fallback poll dono chal sakte hain)
CREATE TABLE IF NOT EXISTS `project_commit_log` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `project_id` INT UNSIGNED NOT NULL,
  `employee` VARCHAR(255) NOT NULL,
  `commit_sha` VARCHAR(40) NOT NULL,
  `commit_message` VARCHAR(255) NULL,
  `committed_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uniq_project_sha` (`project_id`, `commit_sha`),
  CONSTRAINT `fk_commit_log_project` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Employee-ID (`EMP001`-style) scoped connections ka koi single project nahi hota — inhe auto-start/heartbeat se explicitly exclude karo (sirf numeric-project workspaces participate karengi).

### 1.2 Naye `?action=` endpoints — `api/pmconnect.php`

Existing `mine`/`progress`/`timelog` jaisi hi auth/scoping convention follow karo:

- **`POST ?action=projectstart`** — Idempotent: `UPDATE projects SET started_at = NOW() WHERE id = ? AND started_at IS NULL`. Response `{success, startedAt, alreadyStarted}`. `logActivity(..., 'project_start', ...)` sirf pehli baar transition pe.
- **`POST ?action=commitheartbeat`** — Body `{commitSha, commitMessage, committedAt?}`. `INSERT IGNORE` into `project_commit_log`; agar naya row bana (duplicate nahi tha) to `project_daily_log` upsert karo (`commits_count += 1`), aur agar `projects.started_at` NULL hai to usko bhi set kar do (commit khud proof hai project start hone ka — agar activation-ping miss ho jaye tab bhi self-heal ho jaye).
- **`POST ?action=activeheartbeat`** — Body `{seconds}` (delta). `project_daily_log.active_seconds += seconds` upsert. Server-side clamp (max ~900) kyunki yeh untrusted client input hai.
- **`GET ?action=rollup`** — `X-Project-Id` se scoped (Employee-ID scope read-only allowed). "This week" (Monday-start) aur "This month" ka sum, `daysTaken`, aur last 30 din ka `dailyBreakdown` array — ek hi response mein (Reports TreeView aur PDF report dono isi se feed honge).
- **`POST ?action=complete`** (admin-session-gated, `activity`/`employees` jaisa) — Body `{projectId, completed}` (bool, taaki galti se mark hone par undo bhi ho sake). `UPDATE projects SET completed_at = ? WHERE id = ?`.

File ke top comment block mein yeh 4 naye actions document karo.

### 1.3 Admin UI additions

- **"Mark Project Complete" button** — `loadProjectDetail()` (`js/app.js`) mein, existing `#proj-status` ke paas. `markProjectComplete(id)` function `POST ?action=complete` call kare (`credentials:'same-origin'`, jaisa `loadActivity()` karta hai). Success pe detail view refresh.
- **`report.php`** (naya file, `index.php` ka sibling) — clean print-optimized standalone page (`?project=<id>`, session-gated), project name/start/end/days-taken/week-month summary/30-din table dikhaye. `@media print` stylesheet + "Print / Save as PDF" button (`window.print()`). Rollup SQL ko `api/reportData.php` mein extract karo taaki `pmconnect.php` (action=rollup) aur `report.php` dono usi ko reuse karein — duplicate query nahi.
- Project detail page se `report.php?project=<id>` ka link (Mark Complete ke paas ek "Report" button).

---

## PART 2 — Extension (`d:\pm-connect-extension`)

### 2.1 Deletions

- **`package.json`**: `contributes.commands` se `pmConnect.pushAndReport`, `pmConnect.startTimer`, `pmConnect.stopTimer` hatao. Ek optional `pmConnect.refreshReports` command add karo (naye TreeView ke refresh icon ke liye, `pmConnect.viewMyTasks` jaisa).
- **`src/extension.js`**: `pmConnect.pushAndReport` block hatao (ismein `pmConnect.progress.<taskId>` workspaceState use hota hai), `pmConnect.startTimer`/`stopTimer` blocks hatao, `ACTIVE_TIMER_KEY` constant, `TimerStatusBar` import/instantiation, aur timer-resume block (lines ~6, 11, 22-29) hatao.
- **`src/timerStatusBar.js`**: pura file delete (ab kahin use nahi hoga).
- **`src/formatElapsed.js`**: **rakho** — chhota pure function hai, naye Reports panel mein active-time duration format karne ke liye reuse hoga.
- **`test/timerStatusBar.test.js`**: delete.
- Purani workspaceState keys (`pmConnect.activeTimer`, `pmConnect.progress.<taskId>`) simply likhi jaani band ho jayengi — koi explicit cleanup code nahi chahiye.

### 2.2 Automatic idempotent project-start ping

`activate()` mein `providerContext` banne ke baad, ek `pingProjectStartOnce()` helper (fire-and-forget, `void`):
- Skip agar `providerId !== "custom"` ya `pmConnect.custom.projectId` khali/Employee-ID-shaped ho.
- Fast-path: `workspaceState.get('pmConnect.startPinged.' + projectId, false)` check karo, agar already true hai to network call skip.
- Warna `activeProvider().markProjectStarted(providerContext)` call karo; success pe flag set; error silently swallow (agla launch pe retry apne aap ho jayega kyunki flag set hi nahi hua).
- Har activation pe call karna safe hai kyunki server-side `started_at IS NULL` guard already idempotent hai.

### 2.3 Commit-detection mechanism — naya `src/commitTracker.js`

**Pure/testable part:**
- `gitProgress.js` mein `newCommitsDetail(cwd, sinceSha)` add karo — `git log --format=%H%x1f%s <sinceSha>..HEAD` shell-out, `{sha, message}[]` return kare (capped ~20 taaki bada `git pull` flood na kare). Purana `newCommitsSince` waisa hi rehne do (harmless, koi caller nahi tod raha).
- `shouldFallbackPoll(lastPolledAt, now, intervalMs)` — trivial pure helper `commitTracker.js` mein.

**VS Code glue** — `startCommitTracking(folder, context, providerContext, activeProvider)`, har workspace folder ke liye ek baar `activate()` se call:
1. `cwd` resolve karo; na mile to no-op.
2. `vscode.extensions.getExtension('vscode.git')` — agar missing/unavailable, seedha interval-only fallback pe jao (kabhi error dialog mat dikhao — remote/restricted environments mein yeh extension nahi bhi ho sakta).
3. `gitExt.activate()` → `api = gitExt.exports.getAPI(1)` → `repository.state.onDidChange` (har repo ke liye) + `api.onDidOpenRepository` subscribe karo.
4. `lastSeenSha` ko `workspaceState` mein rakho (`pmConnect.lastSeenSha.<projectId>`), pehli baar current HEAD se seed karo (taaki purani history "naya commit" na ban jaye).
5. Change pe: `newCommitsDetail` se diff nikalo, har naye commit ke liye `activeProvider().logCommitHeartbeat({commitSha, commitMessage}, providerContext)` sequentially call karo, har success ke baad `lastSeenSha` update karo (beech mein fail ho to confirmed commits lose na hon).
6. **Interval fallback**: `setInterval` har 5 minute — terminal se kiye commits bhi catch ho jayen. `dispose()` return karo, `context.subscriptions` mein push karo.
7. Saari failures (git extension missing, repo na milna, POST fail) silently catch karo — ek shared `vscode.window.createOutputChannel("PM Connect")` mein log karo, dialog kabhi mat dikhao.

### 2.4 Passive active-time heartbeat — naya `src/activityTracker.js`

**Pure/testable functions:** `computeIdleGate(lastActivityAt, now, idleThresholdMs)` → boolean; `accumulateSeconds(windowFocused, isIdle, tickSeconds)` → integer.

**VS Code glue** — `startActivityTracking(folder, context, providerContext, activeProvider)`, same gating jaisa 2.2:
- Activity signals: `onDidChangeTextEditorSelection`, `onDidChangeActiveTextEditor`, `onDidChangeTextDocument`. Focus signal: `onDidChangeWindowState`.
- Naya config `pmConnect.activity.idleThresholdMinutes` (default 5).
- Har 30s tick: agar focused aur idle nahi, `pendingSecondsBuffer += 30`.
- Har 60s flush: buffer > 0 to `logActiveHeartbeat({seconds}, providerContext)`, success pe reset, fail pe retry (capped ~600s).
- Dispose pe ek last fire-and-forget flush try karo. **Known limitation**: VS Code ungracefully band hone par ~60s tak ka data lose ho sakta hai — koi guaranteed fix nahi (extension host mein reliable "before exit" hook nahi hota).
- Purana per-task `{minutes, note}` timer model completely replace ho jata hai project-scoped daily active-seconds se. `logTime` method aur `task_time_logs` table ko delete nahi karna — bas unused chhod do.

### 2.5 Naye provider methods — `src/providers/customProvider.js`

`DEFAULT_PATHS` mein: `markProjectStarted`, `logCommitHeartbeat`, `logActiveHeartbeat`, `getRollup` (existing `getPaths()` override pattern se overridable).

`CustomProvider` mein naye methods (existing `reportProgress`/`logTime` jaisi structure — baseUrl+apiKey+projectId+authHeaders, `ProviderError` non-ok pe):
- `markProjectStarted(context)` — POST, no body.
- `logCommitHeartbeat({commitSha, commitMessage}, context)` — POST.
- `logActiveHeartbeat({seconds}, context)` — POST.
- `getRollup(context)` — GET.

`src/providers/trelloProvider.js` mein in 4 ke no-op stubs add karo (`{success: false, unsupported: true}`) — defensive second layer (calling code already `providerId !== "custom"` pe gate karta hai).

### 2.6 Naya Reports TreeView — `src/reportsTreeView.js`

`tasksTreeView.js` ka do-level pattern mirror karo (`_onDidChangeTreeData` EventEmitter, `setRollup()` setter):
- Root: `ProjectSummaryItem` — "Started Jul 3 — 12 days" jaisa description.
- Children: "Started: date", "Completed: date | In progress", "Days taken: n", "This week: n commits, duration", "This month: n commits, duration" (duration `formatElapsed.js` se), aur ek collapsible "Last 30 days" group (`dailyBreakdown` se, `StatusGroupItem` jaisa).
- Root item pe optional `command` — `report.php?project=<id>` browser mein khole (`vscode.env.openExternal`). Iske liye naya `pmConnect.custom.siteUrl` setting chahiye ho sakti hai (base API URL se site root derive karna ambiguous hai) — agar clearly derive na ho sake to link skip karo, galat guess mat karo.

**Registration:**
- `package.json`: `contributes.views.pmConnect` mein `{"id": "pmConnectReports", "name": "Reports"}` add karo (existing "PM Connect" container reuse hoga).
- `extension.js`: `pmConnectReports` tree register karo, activation pe ek baar `getRollup()` se populate, phir `setInterval` (~2 min) se refresh (har heartbeat ke baad nahi — rollup endpoint pe load na daalna). `pmConnect.refreshReports` command se bhi refresh ho sake.

### 2.7 Test coverage

- **Delete**: `test/timerStatusBar.test.js`.
- **Extend**: `test/gitProgress.test.js` (naya `newCommitsDetail` — no-prior-SHA, normal range, empty range cases).
- **Extend**: `test/customProvider.test.js` (naye 4 methods, mocked-fetch pattern).
- **Extend**: `test/trelloProvider.test.js` (no-op stubs assert).
- **Naya**: `test/commitTracker.test.js` — sirf pure helpers (`shouldFallbackPoll`), `vscode.git` glue test nahi hoga (no integration harness).
- **Naya**: `test/activityTracker.test.js` — `computeIdleGate`, `accumulateSeconds` (pure, deterministic).

---

## Open Risks / Edge Cases

1. **Multiple workspace folders**: naye trackers `workspaceFolders` array ke har folder ke liye alag instance chalayein (sirf `[0]` nahi, jaisa kuch purane commands karte hain) — yeh shuru se hi multi-folder-aware banao.
2. **Ungraceful close pe last ~60s active-time lose ho sakta hai** — accepted limitation.
3. **`vscode.git` API na mile** (remote/restricted/disabled) — silently sirf interval-fallback pe chale jao.
4. **Employee-ID scoping ka koi single project nahi hota** — auto-tracking se excluded; Reports tree mein explanatory empty-state dikhao.
5. **Commit double-counting** — `project_commit_log` ki unique `(project_id, commit_sha)` key se server-side handle.
6. **Timezone**: `log_date` MySQL server ka `CURDATE()` use karta hai, developer ka local time nahi — accepted for internal tool.
7. **Rollup endpoint polling** — ~2 min per project, chhota row-count, koi real bottleneck nahi.

---

## Verification Plan

1. Migration SQL chalao (`mysql -u root projex_db < pm-connect-tracking-migration.sql`), `DESCRIBE` se confirm columns/tables bane.
2. `curl` se naye 4 endpoints manually test karo (`projectstart` idempotency, `commitheartbeat` dedup, `activeheartbeat` clamp, `rollup` shape) — jaisa is session mein pehle har naya endpoint curl se verify kiya gaya hai.
3. Extension: `npx jest` se saare tests pass (purane + naye), `node --check` har touched file pe.
4. `.vsix` rebuild + reinstall, VS Code reload, real workspace khol ke: activation pe silent `projectstart` ping ho (curl/DB se confirm), ek commit karke `commitheartbeat` fire ho (DB check), Reports panel mein data dikhe.
5. Website: "Mark Project Complete" button se `completed_at` set ho, `report.php` khul ke Print-to-PDF try karo.

---

### Critical Files

- `D:\pm-connect-extension\src\extension.js`
- `D:\pm-connect-extension\src\providers\customProvider.js`
- `D:\pm-connect-extension\src\providers\trelloProvider.js`
- `D:\pm-connect-extension\src\gitProgress.js`
- `D:\pm-connect-extension\package.json`
- `C:\xampp\htdocs\projex\api\pmconnect.php`
- `C:\xampp\htdocs\projex\js\app.js`
- `C:\xampp\htdocs\projex\pm-connect-tracking-migration.sql` (naya)
- `C:\xampp\htdocs\projex\report.php` (naya)
