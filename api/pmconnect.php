<?php
// PM Connect bridge — everything the "PM Connect" VS Code extension needs.
// One file, routed by ?action=..., matching this project's config.php
// (getDB/jsonResponse) conventions instead of Laravel-style routes.
//
// Endpoints (all require an "Authorization: Bearer <api_key>" header,
// and an "X-Project-Id" header set to the numeric `projects.id` you're
// working on — except ?action=employees, which is a cross-project summary):
//
//   GET  ?action=mine        -> list tasks for this project
//   POST ?action=create      -> create a task
//   PATCH ?action=status&id=N   -> update a task's status
//   PATCH ?action=progress&id=N -> push-driven progress % (PM Connect: Push & Report Progress)
//   PATCH ?action=timelog&id=N  -> log timer minutes (PM Connect: Stop Timer)
//   GET  ?action=employees   -> per-employee totals (admin/performance view)
//
//   -- Zero-interaction automatic tracking (see AUTOMATIC_TRACKING_PLAN.md) --
//   POST ?action=projectstart      -> idempotent: mark a project's started_at on first VS Code activation
//   POST ?action=commitheartbeat   -> silently logs one detected git commit (dedup'd by SHA)
//   POST ?action=activeheartbeat   -> silently accumulates passive active-coding seconds for today
//   GET  ?action=rollup            -> this week / this month / days-taken / 30-day breakdown for a project
//   POST ?action=complete          -> admin-only: mark/unmark a project's completed_at

require_once __DIR__ . '/config.php';

$pdo = getDB();

/** Case-insensitive header lookup — some server configs mangle case. */
function getHeader(string $name): ?string {
    $headers = function_exists('getallheaders') ? getallheaders() : [];
    foreach ($headers as $key => $value) {
        if (strcasecmp($key, $name) === 0) return $value;
    }
    // Apache/PHP-FPM sometimes drop Authorization unless picked up this way.
    if (strcasecmp($name, 'Authorization') === 0) {
        return $_SERVER['HTTP_AUTHORIZATION']
            ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION']
            ?? null;
    }
    return null;
}

$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];

// The website's own admin/reporting views (Settings page) are logged in via
// the site's normal session, not a VS Code API key — let those through
// without requiring a Bearer token.
$isAdminSessionView = in_array($action, [
    'activity', 'employees', 'complete', 'rollup',
    'devdirectory', 'devprojects', 'devprojectdetail',
], true) && isset($_SESSION['admin_id']);

// --- Auth: resolve which employee this API key belongs to (VS Code calls) ---
$employee = null;
if (!$isAdminSessionView) {
    $authHeader = getHeader('Authorization') ?? '';
    $apiKey = (stripos($authHeader, 'Bearer ') === 0) ? trim(substr($authHeader, 7)) : null;

    if (!$apiKey) {
        jsonResponse(['error' => 'Invalid or missing API key'], 401);
    }
    $stmt = $pdo->prepare("SELECT id, name FROM users WHERE api_key = ?");
    $stmt->execute([$apiKey]);
    $employee = $stmt->fetch();
    if (!$employee) {
        jsonResponse(['error' => 'Invalid or missing API key'], 401);
    }
}

// --- Admin/reporting view: every employee's logged time, across all projects ---
if ($method === 'GET' && $action === 'employees') {
    $rows = $pdo->query("
        SELECT u.name,
               COALESCE(SUM(l.minutes), 0) AS totalMinutes,
               COUNT(DISTINCT l.task_id) AS tasksTouched
        FROM users u
        LEFT JOIN task_time_logs l ON l.employee = u.name
        WHERE u.api_key IS NOT NULL
        GROUP BY u.id, u.name
    ")->fetchAll();
    jsonResponse(['success' => true, 'employees' => $rows]);
}

/** Turns a changed file path into a human-readable feature/page name —
 *  e.g. "src/home.php" -> "Home Page", "css/about-us.css" -> "About Us" —
 *  purely from the filename, so "what did they work on" is deduced
 *  automatically from real file changes, never typed by the developer. */
function guessFeatureLabel(string $path): string {
    $base = basename($path);
    $ext = strtolower(pathinfo($base, PATHINFO_EXTENSION));
    $name = preg_replace('/\.[a-zA-Z0-9]+$/', '', $base);
    $name = trim(preg_replace('/[-_]+/', ' ', $name));
    if ($name === '') return $base;

    $lower = strtolower($name);
    if (in_array($lower, ['index', 'home', 'main'], true)) return 'Home Page';

    $label = implode(' ', array_map('ucfirst', explode(' ', $lower)));
    if (in_array($ext, ['php', 'html', 'htm']) && stripos($label, 'page') === false) {
        $label .= ' Page';
    }
    return $label;
}

/** Groups a developer's commits by calendar day into a readable digest —
 *  "Aug 1: worked on Home Page, About Page — 'fix navbar', 'add contact form'"
 *  — entirely derived from real commit messages + real changed files, zero
 *  manual entry. This is what the admin/PDF report shows as "daily work". */
function buildDailyWorkSummary(PDO $pdo, int $projectId, string $employeeName): array {
    $stmt = $pdo->prepare("
        SELECT commit_sha, commit_message, files_changed, committed_at
        FROM project_commit_log
        WHERE project_id = ? AND employee = ?
        ORDER BY committed_at ASC
    ");
    $stmt->execute([$projectId, $employeeName]);

    $byDay = [];
    foreach ($stmt->fetchAll() as $row) {
        $day = date('Y-m-d', strtotime($row['committed_at']));
        $byDay[$day] ??= ['date' => $day, 'commitMessages' => [], 'areas' => [], 'files' => []];

        if ($row['commit_message']) $byDay[$day]['commitMessages'][] = $row['commit_message'];

        $files = json_decode($row['files_changed'] ?? '[]', true) ?: [];
        foreach ($files as $file) {
            $label = guessFeatureLabel($file);
            if (!in_array($label, $byDay[$day]['areas'], true)) $byDay[$day]['areas'][] = $label;
            if (!in_array($file, $byDay[$day]['files'], true)) $byDay[$day]['files'][] = $file;
        }
    }

    // Merge active (uncommitted) files
    $stmt = $pdo->prepare("
        SELECT log_date, active_files
        FROM project_daily_log
        WHERE project_id = ? AND employee = ?
        ORDER BY log_date ASC
    ");
    $stmt->execute([$projectId, $employeeName]);
    foreach ($stmt->fetchAll() as $row) {
        $day = $row['log_date'];
        $byDay[$day] ??= ['date' => $day, 'commitMessages' => [], 'areas' => [], 'files' => []];

        $files = json_decode($row['active_files'] ?? '[]', true) ?: [];
        foreach ($files as $file) {
            $label = guessFeatureLabel($file);
            if (!in_array($label, $byDay[$day]['areas'], true)) $byDay[$day]['areas'][] = $label;
            if (!in_array($file, $byDay[$day]['files'], true)) $byDay[$day]['files'][] = $file;
        }
    }

    return array_values(array_reverse($byDay)); // newest day first
}

/** Shared week/month/30-day rollup for one (project, employee) pair — used
 *  by myrollups, devprojects, and devprojectdetail so the numbers are
 *  computed identically everywhere. Real data only — every row here comes
 *  from an actual commit heartbeat or active-time heartbeat the extension
 *  sent; nothing here is placeholder/demo data. */
function computeProjectRollup(PDO $pdo, array $project, string $employeeName): array {
    $daysTaken = $project['started_at']
        ? (new DateTime($project['completed_at'] ?? 'now'))->diff(new DateTime($project['started_at']))->days
        : null;

    $weekStmt = $pdo->prepare("SELECT COALESCE(SUM(commits_count),0) c, COALESCE(SUM(active_seconds),0) s FROM project_daily_log WHERE project_id = ? AND employee = ? AND log_date >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)");
    $weekStmt->execute([$project['id'], $employeeName]);
    $week = $weekStmt->fetch();

    $monthStmt = $pdo->prepare("SELECT COALESCE(SUM(commits_count),0) c, COALESCE(SUM(active_seconds),0) s FROM project_daily_log WHERE project_id = ? AND employee = ? AND log_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')");
    $monthStmt->execute([$project['id'], $employeeName]);
    $month = $monthStmt->fetch();

    $dailyStmt = $pdo->prepare("SELECT log_date, commits_count c, active_seconds s FROM project_daily_log WHERE project_id = ? AND employee = ? AND log_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) ORDER BY log_date DESC");
    $dailyStmt->execute([$project['id'], $employeeName]);

    return [
        'project' => [
            'id' => (int) $project['id'],
            'name' => $project['name'],
            'description' => $project['description'] ?? null,
            'startedAt' => $project['started_at'],
            'completedAt' => $project['completed_at'],
            'daysTaken' => $daysTaken,
            'employee' => $employeeName,
        ],
        'week' => ['commits' => (int) $week['c'], 'activeMinutes' => intdiv((int) $week['s'], 60)],
        'month' => ['commits' => (int) $month['c'], 'activeMinutes' => intdiv((int) $month['s'], 60)],
        'dailyBreakdown' => array_map(fn ($d) => [
            'date' => $d['log_date'],
            'commits' => (int) $d['c'],
            'activeMinutes' => intdiv((int) $d['s'], 60),
        ], $dailyStmt->fetchAll()),
    ];
}

// --- Admin: every real developer (has an API key), with how many real
// projects/commits/active-time they've actually logged. This is the landing
// list for the website's "Developers" page — click a name to drill in. ---
if ($method === 'GET' && $action === 'devdirectory') {
    $rows = $pdo->query("
        SELECT u.name, u.employee_id,
               COUNT(DISTINCT l.project_id) AS projectsCount,
               COALESCE(SUM(l.commits_count), 0) AS totalCommits,
               COALESCE(SUM(l.active_seconds), 0) AS totalActiveSeconds
        FROM users u
        LEFT JOIN project_daily_log l ON l.employee = u.name
        WHERE u.api_key IS NOT NULL
        GROUP BY u.id, u.name, u.employee_id
        ORDER BY u.name
    ")->fetchAll();

    jsonResponse(['success' => true, 'developers' => array_map(fn ($r) => [
        'name' => $r['name'],
        'employeeId' => $r['employee_id'],
        'projectsCount' => (int) $r['projectsCount'],
        'totalCommits' => (int) $r['totalCommits'],
        'totalActiveMinutes' => intdiv((int) $r['totalActiveSeconds'], 60),
    ], $rows)]);
}

// --- Admin: every REAL project a specific developer has opened in VS Code
// and logged activity on — never a website-only/dummy project, and never
// another developer's data. Query param: ?employee=Full Name ---
if ($method === 'GET' && $action === 'devprojects') {
    $employeeName = trim($_GET['employee'] ?? '');
    if (!$employeeName) jsonResponse(['error' => 'employee is required'], 400);

    $projStmt = $pdo->prepare("
        SELECT DISTINCT p.id, p.name, p.started_at, p.completed_at
        FROM projects p
        JOIN project_daily_log l ON l.project_id = p.id
        WHERE l.employee = ?
        ORDER BY p.started_at DESC
    ");
    $projStmt->execute([$employeeName]);
    $projects = $projStmt->fetchAll();

    $results = array_map(fn ($p) => computeProjectRollup($pdo, $p, $employeeName), $projects);
    jsonResponse(['success' => true, 'employee' => $employeeName, 'projects' => $results]);
}

// --- Admin: full drill-down for one developer + one project — the rollup
// PLUS the real commit history (real SHAs/messages the extension detected
// via git, not placeholder text), so the admin can see exactly what was
// pushed to GitHub for that project. Query params: ?employee=Name&project=ID ---
if ($method === 'GET' && $action === 'devprojectdetail') {
    $employeeName = trim($_GET['employee'] ?? '');
    $projectId = intval($_GET['project'] ?? 0);
    if (!$employeeName || !$projectId) jsonResponse(['error' => 'employee and project are required'], 400);

    $projStmt = $pdo->prepare("SELECT id, name, description, started_at, completed_at FROM projects WHERE id = ?");
    $projStmt->execute([$projectId]);
    $project = $projStmt->fetch();
    if (!$project) jsonResponse(['error' => 'Project not found'], 404);

    $rollup = computeProjectRollup($pdo, $project, $employeeName);

    $commitStmt = $pdo->prepare("
        SELECT commit_sha, commit_message, committed_at
        FROM project_commit_log
        WHERE project_id = ? AND employee = ?
        ORDER BY committed_at DESC
        LIMIT 100
    ");
    $commitStmt->execute([$projectId, $employeeName]);
    $rollup['commits'] = array_map(fn ($c) => [
        'sha' => substr($c['commit_sha'], 0, 7),
        'message' => $c['commit_message'],
        'committedAt' => $c['committed_at'],
    ], $commitStmt->fetchAll());

    // "Aug 1: worked on Home Page — 'fix navbar'" style digest, auto-derived
    // from real commit messages + real changed files.
    $rollup['dailyWorkSummary'] = buildDailyWorkSummary($pdo, $projectId, $employeeName);

    jsonResponse(array_merge(['success' => true], $rollup));
}

// --- Admin: mark/unmark a project as complete (sets/clears completed_at) ---
if ($method === 'POST' && $action === 'automatch') {
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $gitEmail = trim($body['gitEmail'] ?? '');
    $machineUsername = trim($body['machineUsername'] ?? '');
    $workspaceFolderName = trim($body['workspaceFolderName'] ?? '');
    $gitRemoteUrl = trim($body['gitRemoteUrl'] ?? '');

    // 1. Try to find the developer/user.
    $matchedUser = null;
    if ($gitEmail) {
        $stmt = $pdo->prepare("SELECT id, name, api_key FROM users WHERE LOWER(email) = LOWER(?)");
        $stmt->execute([$gitEmail]);
        $matchedUser = $stmt->fetch();
    }
    if (!$matchedUser && $machineUsername) {
        $stmt = $pdo->prepare("SELECT id, name, api_key FROM users WHERE LOWER(name) = LOWER(?) OR REPLACE(LOWER(name), ' ', '') = REPLACE(LOWER(?), ' ', '')");
        $stmt->execute([$machineUsername, $machineUsername]);
        $matchedUser = $stmt->fetch();
    }

    // Auto-create user on the fly if not registered
    if (!$matchedUser) {
        $name = $machineUsername ?: 'New Developer';
        $email = $gitEmail ?: (strtolower(str_replace(' ', '', $name)) . '@local.com');
        $apiKey = bin2hex(random_bytes(20));
        $passwordHash = password_hash('welcome123', PASSWORD_DEFAULT);

        // Double check email uniqueness
        $checkStmt = $pdo->prepare("SELECT id, name, api_key FROM users WHERE LOWER(email) = LOWER(?)");
        $checkStmt->execute([$email]);
        $matchedUser = $checkStmt->fetch();

        if (!$matchedUser) {
            $insert = $pdo->prepare("INSERT INTO users (name, email, api_key, password) VALUES (?, ?, ?, ?)");
            $insert->execute([$name, $email, $apiKey, $passwordHash]);
            $matchedUser = [
                'id' => $pdo->lastInsertId(),
                'name' => $name,
                'api_key' => $apiKey
            ];
        }
    }

    // 2. Try to find the project.
    $matchedProject = null;
    if ($gitRemoteUrl) {
        $normalizedUrl = preg_replace('/(\.git|\/)$/', '', $gitRemoteUrl);
        $stmt = $pdo->prepare("SELECT id, name FROM projects WHERE LOWER(repo_url) = LOWER(?) OR LOWER(repo_url) LIKE ?");
        $stmt->execute([$gitRemoteUrl, '%' . $normalizedUrl . '%']);
        $matchedProject = $stmt->fetch();
    }
    if (!$matchedProject && $workspaceFolderName) {
        $stmt = $pdo->prepare("SELECT id, name FROM projects WHERE LOWER(name) = LOWER(?) OR REPLACE(LOWER(name), ' ', '') = REPLACE(LOWER(?), ' ', '')");
        $stmt->execute([$workspaceFolderName, $workspaceFolderName]);
        $matchedProject = $stmt->fetch();
    }

    // Auto-create project on the fly if not found
    if (!$matchedProject) {
        $name = $workspaceFolderName ?: 'New Project';
        $repoUrl = $gitRemoteUrl ?: null;

        $insert = $pdo->prepare("INSERT INTO projects (name, repo_url) VALUES (?, ?)");
        $insert->execute([$name, $repoUrl]);
        $matchedProject = [
            'id' => $pdo->lastInsertId(),
            'name' => $name
        ];
    }
    jsonResponse(['success' => true, 'user' => $matchedUser, 'project' => $matchedProject]);
}

if ($method === 'POST' && $action === 'complete') {
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    $projectId = intval($body['projectId'] ?? 0);
    $completed = (bool) ($body['completed'] ?? true);
    if (!$projectId) jsonResponse(['error' => 'projectId is required'], 400);

    $completedAt = $completed ? date('Y-m-d H:i:s') : null;
    $pdo->prepare("UPDATE projects SET completed_at = ? WHERE id = ?")->execute([$completedAt, $projectId]);

    // Marking complete triggers the one-time Final Summary — a consolidated,
    // GitHub-comment-style overview (separate from the daily/weekly/monthly
    // internal rollups), emailed to the admin and, if set, the client too.
    if ($completed) {
        require_once __DIR__ . '/finalSummary.php';
        try {
            buildAndSendFinalSummary($pdo, $projectId);
        } catch (Throwable $e) {
            finalSummaryLog("buildAndSendFinalSummary failed for project $projectId: " . $e->getMessage());
        }
    }

    jsonResponse(['success' => true, 'projectId' => $projectId, 'completedAt' => $completedAt]);
}

// --- Live activity feed: every PM Connect action, newest first ---
if ($method === 'GET' && $action === 'activity') {
    $rows = $pdo->query("SELECT employee, action, task_id, task_title, detail, created_at FROM activity_log ORDER BY id DESC LIMIT 50")->fetchAll();
    jsonResponse(['success' => true, 'activity' => $rows]);
}

// --- List projects (used to pick a project when connected via Employee ID,
// since creating a task needs one specific project, not "all of them") ---
if ($method === 'GET' && $action === 'projects') {
    $rows = $pdo->query("SELECT id, name FROM projects ORDER BY name")->fetchAll();
    jsonResponse(['success' => true, 'projects' => $rows]);
}

// --- Auto-creates a project straight from VS Code — no website step. Called
// once, silently, the first time a workspace with no configured projectId is
// opened; the folder name becomes the project name. Immediately marked
// started (opening it in VS Code *is* the start signal), and the caller's
// personal API key becomes the project's assignee by default. ---
if ($method === 'POST' && $action === 'autocreateproject') {
    $createBody = json_decode(file_get_contents('php://input'), true) ?? [];
    $name = trim($createBody['name'] ?? '') ?: ('Untitled — ' . date('Y-m-d H:i'));
    $stmt = $pdo->prepare("
        INSERT INTO projects (name, type, status, payment_type, project_origin, started_at, created_by)
        VALUES (?, 'General', 'active', 'unpaid', 'internal', NOW(), ?)
    ");
    $stmt->execute([$name, $employee['name']]);
    $id = (int) $pdo->lastInsertId();

    logActivity($pdo, $employee['name'], 'project_start', null, null, "Auto-created from VS Code: $name");
    jsonResponse(['success' => true, 'id' => $id, 'name' => $name], 201);
}

// --- Every project the connected employee has real tracked activity on —
// this is what the Reports panel lists (not every project on the website,
// only the ones this specific person has actually opened/worked in). ---
if ($method === 'GET' && $action === 'myrollups') {
    $who = $employee['name'];
    $projectIds = $pdo->prepare("
        SELECT DISTINCT p.id, p.name, p.started_at, p.completed_at
        FROM projects p
        JOIN project_daily_log l ON l.project_id = p.id
        WHERE l.employee = ?
        ORDER BY p.started_at DESC
    ");
    $projectIds->execute([$who]);
    $projects = $projectIds->fetchAll();

    $results = array_map(function ($project) use ($pdo, $who) {
        $daysTaken = $project['started_at']
            ? (new DateTime($project['completed_at'] ?? 'now'))->diff(new DateTime($project['started_at']))->days
            : null;

        $weekStmt = $pdo->prepare("SELECT COALESCE(SUM(commits_count),0) c, COALESCE(SUM(active_seconds),0) s FROM project_daily_log WHERE project_id = ? AND employee = ? AND log_date >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)");
        $weekStmt->execute([$project['id'], $who]);
        $week = $weekStmt->fetch();

        $monthStmt = $pdo->prepare("SELECT COALESCE(SUM(commits_count),0) c, COALESCE(SUM(active_seconds),0) s FROM project_daily_log WHERE project_id = ? AND employee = ? AND log_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')");
        $monthStmt->execute([$project['id'], $who]);
        $month = $monthStmt->fetch();

        $dailyStmt = $pdo->prepare("SELECT log_date, commits_count c, active_seconds s FROM project_daily_log WHERE project_id = ? AND employee = ? AND log_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) ORDER BY log_date DESC");
        $dailyStmt->execute([$project['id'], $who]);

        return [
            'project' => [
                'id' => (int) $project['id'],
                'name' => $project['name'],
                'startedAt' => $project['started_at'],
                'completedAt' => $project['completed_at'],
                'daysTaken' => $daysTaken,
                'employee' => $who,
            ],
            'week' => ['commits' => (int) $week['c'], 'activeMinutes' => intdiv((int) $week['s'], 60)],
            'month' => ['commits' => (int) $month['c'], 'activeMinutes' => intdiv((int) $month['s'], 60)],
            'dailyBreakdown' => array_map(fn ($d) => [
                'date' => $d['log_date'],
                'commits' => (int) $d['c'],
                'activeMinutes' => intdiv((int) $d['s'], 60),
            ], $dailyStmt->fetchAll()),
        ];
    }, $projects);

    jsonResponse(['success' => true, 'projects' => $results]);
}

// --- "Project ID" field also accepts an Employee ID (EMP001, EMP002, ...).
// When it's an Employee ID, we drop project scoping entirely and show that
// person's tasks across EVERY project — put in once, see everything assigned
// to you regardless of which project it lives under. A plain numeric value
// still works the old way (scoped to just that one project).
$projectIdRaw = getHeader('X-Project-Id');
if (!$projectIdRaw) {
    jsonResponse(['error' => 'Missing X-Project-Id header'], 400);
}

$employeeScope = null; // set when X-Project-Id is actually an Employee ID
if (preg_match('/^EMP\d+$/i', $projectIdRaw)) {
    $stmt = $pdo->prepare("SELECT id, name FROM users WHERE employee_id = ?");
    $stmt->execute([$projectIdRaw]);
    $employeeScope = $stmt->fetch();
    if (!$employeeScope) {
        jsonResponse(['error' => "No employee found with ID '$projectIdRaw'"], 404);
    }
}
$projectId = $projectIdRaw; // used as-is for the plain-numeric-project code path

$body = json_decode(file_get_contents('php://input'), true) ?? [];

/** Records every action PM Connect performs, so the website can show a live
 *  activity feed (start timer, stop timer, task created, status changed,
 *  progress pushed, etc.) — not just the end result. */
function logActivity(PDO $pdo, string $employee, string $action, ?int $taskId = null, ?string $taskTitle = null, ?string $detail = null): void {
    $pdo->prepare("INSERT INTO activity_log (employee, action, task_id, task_title, detail) VALUES (?, ?, ?, ?, ?)")
        ->execute([$employee, $action, $taskId, $taskTitle, $detail]);
}

// --- Zero-interaction automatic tracking: writes below reject Employee-ID
// scope (there's no single project to attribute the activity to). ---
if (in_array($action, ['projectstart', 'commitheartbeat', 'activeheartbeat'], true) && $employeeScope) {
    jsonResponse(['error' => 'Automatic tracking requires a numeric project ID, not an Employee ID.'], 400);
}

// --- Idempotent: mark this project as started the first time the extension
// activates for it. Safe to call on every VS Code launch — only the first
// call (started_at IS NULL) actually changes anything. ---
if ($method === 'POST' && $action === 'projectstart') {
    $stmt = $pdo->prepare("UPDATE projects SET started_at = NOW() WHERE id = ? AND started_at IS NULL");
    $stmt->execute([$projectId]);
    $alreadyStarted = $stmt->rowCount() === 0;

    if (!$alreadyStarted) {
        logActivity($pdo, $employee['name'], 'project_start', null, null, null);
    }

    $startedAtStmt = $pdo->prepare("SELECT started_at FROM projects WHERE id = ?");
    $startedAtStmt->execute([$projectId]);
    jsonResponse(['success' => true, 'startedAt' => $startedAtStmt->fetchColumn(), 'alreadyStarted' => $alreadyStarted]);
}

// --- Silently logs one detected git commit. Deduped by (project, sha) so
// the vscode.git event handler and the interval fallback poll can both fire
// for the same commit without double-counting. Also self-heals
// started_at if the activation-time ping was somehow missed. ---
if ($method === 'POST' && $action === 'commitheartbeat') {
    $commitSha = trim($body['commitSha'] ?? '');
    $commitMessage = $body['commitMessage'] ?? null;
    // Files the commit touched (e.g. ["src/home.php"]) — this is what lets
    // the daily work summary say "worked on Home Page" automatically, purely
    // from what changed, without the developer describing anything extra.
    $filesChanged = is_array($body['filesChanged'] ?? null) ? json_encode(array_slice($body['filesChanged'], 0, 30)) : null;
    if (!$commitSha) jsonResponse(['error' => 'commitSha is required'], 400);

    $who = $employee['name'];
    $insert = $pdo->prepare("INSERT IGNORE INTO project_commit_log (project_id, employee, commit_sha, commit_message, files_changed) VALUES (?, ?, ?, ?, ?)");
    $insert->execute([$projectId, $who, $commitSha, $commitMessage, $filesChanged]);
    $counted = $insert->rowCount() === 1;

    if ($counted) {
        $pdo->prepare("
            INSERT INTO project_daily_log (project_id, employee, log_date, commits_count, first_activity_at, last_activity_at, last_commit_sha, last_commit_message)
            VALUES (?, ?, CURDATE(), 1, NOW(), NOW(), ?, ?)
            ON DUPLICATE KEY UPDATE
                commits_count = commits_count + 1,
                last_activity_at = NOW(),
                first_activity_at = COALESCE(first_activity_at, NOW()),
                last_commit_sha = VALUES(last_commit_sha),
                last_commit_message = VALUES(last_commit_message)
        ")->execute([$projectId, $who, $commitSha, $commitMessage]);

        // A commit is unambiguous proof the project has started — self-heal
        // in case the activation-time ping never landed.
        $pdo->prepare("UPDATE projects SET started_at = NOW() WHERE id = ? AND started_at IS NULL")->execute([$projectId]);
    }

    jsonResponse(['success' => true, 'counted' => $counted]);
}

// --- Silently accumulates passive active-coding seconds for today. The
// extension decides what counts as "active" (focused + not idle); this
// endpoint just sums whatever delta it's given, clamped against abuse. ---
if ($method === 'POST' && $action === 'activeheartbeat') {
    $seconds = max(0, min(900, intval($body['seconds'] ?? 0)));
    if ($seconds <= 0) jsonResponse(['success' => true, 'activeSecondsToday' => 0]);

    $who = $employee['name'];
    $activeFiles = is_array($body['activeFiles'] ?? null) ? $body['activeFiles'] : [];
    $logDate = (!empty($body['date']) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $body['date'])) ? $body['date'] : date('Y-m-d');

    // Get current active_files
    $stmt = $pdo->prepare("SELECT active_files FROM project_daily_log WHERE project_id = ? AND employee = ? AND log_date = ?");
    $stmt->execute([$projectId, $who, $logDate]);
    $currentJson = $stmt->fetchColumn() ?: '[]';
    $currentFiles = json_decode($currentJson, true) ?: [];

    // Merge and filter unique
    $mergedFiles = array_unique(array_merge($currentFiles, $activeFiles));
    $mergedFiles = array_slice($mergedFiles, 0, 30);
    $activeFilesJson = json_encode(array_values($mergedFiles));

    $pdo->prepare("
        INSERT INTO project_daily_log (project_id, employee, log_date, active_seconds, first_activity_at, last_activity_at, active_files)
        VALUES (?, ?, ?, ?, NOW(), NOW(), ?)
        ON DUPLICATE KEY UPDATE
            active_seconds = active_seconds + VALUES(active_seconds),
            last_activity_at = NOW(),
            first_activity_at = COALESCE(first_activity_at, NOW()),
            active_files = VALUES(active_files)
    ")->execute([$projectId, $who, $logDate, $seconds, $activeFilesJson]);

    $totalStmt = $pdo->prepare("SELECT active_seconds FROM project_daily_log WHERE project_id = ? AND employee = ? AND log_date = ?");
    $totalStmt->execute([$projectId, $who, $logDate]);
    jsonResponse(['success' => true, 'activeSecondsToday' => (int) $totalStmt->fetchColumn()]);
}

// --- Idempotent time sync from BACKLOG.md. Sets the exact total active_seconds
// for the given project & date(s). Safe to call multiple times — NEVER duplicates
// or accumulates existing time. ---
if ($method === 'POST' && $action === 'synctime') {
    $targetProjectId = intval($body['projectId'] ?? $projectId);
    if (!$targetProjectId) jsonResponse(['error' => 'projectId is required'], 400);

    $todayMinutes = intval($body['todayMinutes'] ?? 0);
    $dateBreakdown = is_array($body['dateBreakdown'] ?? null) ? $body['dateBreakdown'] : [];
    $who = $employee['name'];

    if (empty($dateBreakdown) && $todayMinutes > 0) {
        $dateBreakdown = [['date' => date('Y-m-d'), 'minutes' => $todayMinutes]];
    }

    $updatedCount = 0;
    $syncedDatesList = [];

    foreach ($dateBreakdown as $item) {
        $itemDate = trim($item['date'] ?? '');
        if (!$itemDate || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $itemDate)) continue;

        $itemMinutes = intval($item['minutes'] ?? 0);
        $itemSeconds = $itemMinutes * 60;
        if ($itemSeconds < 0) continue;

        $itemFiles = is_array($item['files'] ?? null) ? $item['files'] : [];

        // Check existing active_files for this specific date
        $stmtExisting = $pdo->prepare("SELECT active_files FROM project_daily_log WHERE project_id = ? AND employee = ? AND log_date = ?");
        $stmtExisting->execute([$targetProjectId, $who, $itemDate]);
        $existingJson = $stmtExisting->fetchColumn() ?: '[]';
        $existingFiles = json_decode($existingJson, true) ?: [];

        $mergedFiles = array_values(array_unique(array_merge($existingFiles, $itemFiles)));
        $mergedFiles = array_slice($mergedFiles, 0, 30);
        $activeFilesJson = json_encode($mergedFiles);

        // Idempotently set that specific day's exact active_seconds and files (never duplicates)
        $stmt = $pdo->prepare("
            INSERT INTO project_daily_log (project_id, employee, log_date, active_seconds, first_activity_at, last_activity_at, active_files)
            VALUES (?, ?, ?, ?, NOW(), NOW(), ?)
            ON DUPLICATE KEY UPDATE
                active_seconds = VALUES(active_seconds),
                last_activity_at = NOW(),
                first_activity_at = COALESCE(first_activity_at, NOW()),
                active_files = VALUES(active_files)
        ");
        $stmt->execute([$targetProjectId, $who, $itemDate, $itemSeconds, $activeFilesJson]);
        $updatedCount++;
        $syncedDatesList[] = ['date' => $itemDate, 'minutes' => $itemMinutes];
    }

    // Ensure started_at is stamped
    $pdo->prepare("UPDATE projects SET started_at = NOW() WHERE id = ? AND started_at IS NULL")->execute([$targetProjectId]);

    jsonResponse(['success' => true, 'syncedDates' => $updatedCount, 'details' => $syncedDatesList]);
}

// --- This week / this month / days-taken / 30-day breakdown. When called
// from VS Code (a real employee API key), ALWAYS scoped to that employee —
// never another developer's data, even when several people share the same
// numeric project. When called from the website's own admin session, shows
// the whole project's combined totals instead (the admin's legitimate
// "project overview", not any one person's data). Employee-ID scope
// aggregates across that person's own rows across every project. ---
if ($method === 'GET' && $action === 'rollup') {
    if ($employeeScope) {
        $projStmt = $pdo->prepare("SELECT id, name, started_at, completed_at FROM projects WHERE id IN (SELECT DISTINCT project_id FROM project_daily_log WHERE employee = ?) LIMIT 1");
        $projStmt->execute([$employeeScope['name']]);
        $employeeFilter = "employee = ?";
        $filterParams = [$employeeScope['name']];
        $rollupEmployee = $employeeScope['name'];
    } elseif ($isAdminSessionView) {
        $projStmt = $pdo->prepare("SELECT id, name, started_at, completed_at FROM projects WHERE id = ?");
        $projStmt->execute([$projectId]);
        $employeeFilter = "project_id = ?";
        $filterParams = [$projectId];
        $rollupEmployee = null; // whole-project overview, not any one person's data
    } else {
        $projStmt = $pdo->prepare("SELECT id, name, started_at, completed_at FROM projects WHERE id = ?");
        $projStmt->execute([$projectId]);
        $employeeFilter = "project_id = ? AND employee = ?";
        $filterParams = [$projectId, $employee['name']];
        $rollupEmployee = $employee['name'];
    }
    $project = $projStmt->fetch();
    if (!$project) jsonResponse(['error' => 'Project not found'], 404);

    $daysTaken = $project['started_at']
        ? (new DateTime($project['completed_at'] ?? 'now'))->diff(new DateTime($project['started_at']))->days
        : null;

    $weekStmt = $pdo->prepare("SELECT COALESCE(SUM(commits_count),0) c, COALESCE(SUM(active_seconds),0) s FROM project_daily_log WHERE $employeeFilter AND log_date >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)");
    $weekStmt->execute($filterParams);
    $week = $weekStmt->fetch();

    $monthStmt = $pdo->prepare("SELECT COALESCE(SUM(commits_count),0) c, COALESCE(SUM(active_seconds),0) s FROM project_daily_log WHERE $employeeFilter AND log_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')");
    $monthStmt->execute($filterParams);
    $month = $monthStmt->fetch();

    $dailyStmt = $pdo->prepare("SELECT log_date, SUM(commits_count) c, SUM(active_seconds) s FROM project_daily_log WHERE $employeeFilter AND log_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) GROUP BY log_date ORDER BY log_date DESC");
    $dailyStmt->execute($filterParams);

    jsonResponse([
        'success' => true,
        'project' => [
            'id' => (int) $project['id'],
            'name' => $project['name'],
            'startedAt' => $project['started_at'],
            'completedAt' => $project['completed_at'],
            'daysTaken' => $daysTaken,
            'employee' => $rollupEmployee,
        ],
        'week' => ['commits' => (int) $week['c'], 'activeMinutes' => intdiv((int) $week['s'], 60)],
        'month' => ['commits' => (int) $month['c'], 'activeMinutes' => intdiv((int) $month['s'], 60)],
        'dailyBreakdown' => array_map(fn ($d) => [
            'date' => $d['log_date'],
            'commits' => (int) $d['c'],
            'activeMinutes' => intdiv((int) $d['s'], 60),
        ], $dailyStmt->fetchAll()),
    ]);
}

// --- Timer start marker (no task mutation, just an activity entry) ---
if ($method === 'POST' && $action === 'timerstart') {
    $id = intval($_GET['id'] ?? 0);
    $task = taskRow($pdo, $id, $projectId, $employeeScope);
    $who = $employeeScope ? $employeeScope['name'] : $employee['name'];
    logActivity($pdo, $who, 'start_timer', $id ?: null, $task['title'] ?? null);
    jsonResponse(['success' => true]);
}

/** Looks up a task, respecting whichever scope mode is active. */
function taskRow(PDO $pdo, int $id, string $projectId, ?array $employeeScope): ?array {
    if ($employeeScope) {
        $stmt = $pdo->prepare("SELECT * FROM tasks WHERE id = ? AND assignee = ?");
        $stmt->execute([$id, $employeeScope['name']]);
    } else {
        $stmt = $pdo->prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?");
        $stmt->execute([$id, $projectId]);
    }
    $row = $stmt->fetch();
    return $row ?: null;
}

// Base URL of the website itself (not the API) — used to build a link back
// to a task so clicking it in VS Code's "My Tasks" opens it in the browser.
const SITE_URL = 'http://localhost/projex';
function taskUrl(int $projectId, int $taskId): string {
    return SITE_URL . "/?project={$projectId}&task={$taskId}#tasks";
}

if ($method === 'GET' && $action === 'mine') {
    // Only tasks assigned to THIS employee — so when an admin assigns a task
    // on the website (sets the `assignee` field to this person's name), it
    // shows up in their VS Code, and never in a different developer's list.
    if ($employeeScope) {
        $stmt = $pdo->prepare("SELECT id, project_id, title, description, status, progress FROM tasks WHERE assignee = ? ORDER BY created_at DESC");
        $stmt->execute([$employeeScope['name']]);
    } else {
        $stmt = $pdo->prepare("SELECT id, project_id, title, description, status, progress FROM tasks WHERE project_id = ? AND assignee = ? ORDER BY created_at DESC");
        $stmt->execute([$projectId, $employee['name']]);
    }
    $tasks = array_map(fn ($t) => [
        'id' => (string) $t['id'],
        'title' => $t['title'],
        'description' => $t['description'],
        'status' => $t['status'],
        'progress' => (int) $t['progress'],
        'url' => taskUrl((int) $t['project_id'], (int) $t['id']),
    ], $stmt->fetchAll());
    jsonResponse($tasks);
}

if ($method === 'POST' && $action === 'create') {
    if ($employeeScope) {
        jsonResponse(['error' => 'Cannot create a task while connected by Employee ID — use a project ID to create new tasks.'], 400);
    }
    $title = trim($body['title'] ?? 'Untitled');
    $description = $body['description'] ?? '';

    $stmt = $pdo->prepare("INSERT INTO tasks (project_id, title, description, assignee, status) VALUES (?, ?, ?, ?, 'pending')");
    $stmt->execute([$projectId, $title, $description, $employee['name']]);
    $id = $pdo->lastInsertId();

    logActivity($pdo, $employee['name'], 'create_task', $id, $title);
    jsonResponse(['id' => (string) $id, 'title' => $title, 'status' => 'pending'], 201);
}

if ($method === 'PATCH' && $action === 'status') {
    $id = intval($_GET['id'] ?? 0);
    if (!taskRow($pdo, $id, $projectId, $employeeScope)) jsonResponse(['error' => 'Task not found'], 404);

    $status = $body['status'] ?? 'pending';
    $pdo->prepare("UPDATE tasks SET status = ? WHERE id = ?")->execute([$status, $id]);
    $who = $employeeScope ? $employeeScope['name'] : $employee['name'];
    logActivity($pdo, $who, 'update_status', $id, null, "→ $status");
    jsonResponse(['id' => (string) $id, 'status' => $status]);
}

if ($method === 'PATCH' && $action === 'progress') {
    $id = intval($_GET['id'] ?? 0);
    $task = taskRow($pdo, $id, $projectId, $employeeScope);
    if (!$task) jsonResponse(['error' => 'Task not found'], 404);

    $percentage = intval($body['percentage'] ?? 0);
    $commitMessage = $body['commitMessage'] ?? null;
    $newStatus = $percentage >= 100 ? 'completed' : $task['status'];

    $pdo->prepare("UPDATE tasks SET progress = ?, last_commit_message = ?, status = ? WHERE id = ?")
        ->execute([$percentage, $commitMessage, $newStatus, $id]);

    $who = $employeeScope ? $employeeScope['name'] : $employee['name'];
    logActivity($pdo, $who, 'push_progress', $id, null, "{$percentage}% — {$commitMessage}");
    jsonResponse(['id' => (string) $id, 'progress' => $percentage, 'status' => $newStatus]);
}

if ($method === 'PATCH' && $action === 'timelog') {
    $id = intval($_GET['id'] ?? 0);
    if (!taskRow($pdo, $id, $projectId, $employeeScope)) jsonResponse(['error' => 'Task not found'], 404);

    $minutes = intval($body['minutes'] ?? 0);
    $note = $body['note'] ?? null;
    $loggedAs = $employeeScope ? $employeeScope['name'] : $employee['name'];

    $pdo->prepare("INSERT INTO task_time_logs (task_id, employee, minutes, note) VALUES (?, ?, ?, ?)")
        ->execute([$id, $loggedAs, $minutes, $note]);
    $pdo->prepare("UPDATE tasks SET total_minutes = total_minutes + ? WHERE id = ?")
        ->execute([$minutes, $id]);

    $totalStmt = $pdo->prepare("SELECT total_minutes FROM tasks WHERE id = ?");
    $totalStmt->execute([$id]);

    logActivity($pdo, $loggedAs, 'stop_timer', $id, null, "{$minutes} min" . ($note ? " — $note" : ''));
    jsonResponse(['id' => (string) $id, 'totalMinutes' => (int) $totalStmt->fetchColumn()]);
}

jsonResponse(['error' => 'Unknown action'], 404);
