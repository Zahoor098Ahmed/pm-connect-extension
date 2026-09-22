// Fake "our website" backend — same endpoints a real backend needs to expose
// for the Custom provider: create task, update status, list my tasks, report
// progress, log time. Tasks are scoped by X-Project-Id so a developer working
// across multiple clients only ever sees the project they're currently
// connected to.
// Run: node mock-server/server.js
const http = require("http");

const PORT = 4000;

// Each employee gets their own personal API key — this is how the backend
// tells WHO did an action, so time/progress can be attributed per person
// instead of just per task. In a real backend this would be a `users` table
// with a hashed key, not a hardcoded map.
const EMPLOYEES = {
  "test-key-123": "Hasnain",
  "emp-key-ayesha": "Ayesha",
  "emp-key-bilal": "Bilal",
};

// Seed data for two different "clients" to prove project scoping works.
let tasks = [
  { id: "1", title: "Fix login bug", status: "open", description: "Sample seed task", projectId: "our-project", progress: 0, totalMinutes: 0, timeLogs: [] },
  { id: "2", title: "Write docs", status: "in-progress", description: "Sample seed task", projectId: "our-project", progress: 0, totalMinutes: 0, timeLogs: [] },
  { id: "3", title: "Client B's private task", status: "open", description: "Should never show up for our-project", projectId: "client-b", progress: 0, totalMinutes: 0, timeLogs: [] },
];
let nextId = 4;

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
  });
}

function stripProjectId(task) {
  const { projectId, ...rest } = task;
  return rest;
}

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error("Request handler error:", err.message);
    if (!res.headersSent) send(res, 500, { error: "Internal mock-server error", detail: err.message });
  }
});

async function handleRequest(req, res) {
  console.log(`${req.method} ${req.url} [project: ${req.headers["x-project-id"] ?? "none"}]`);

  const auth = req.headers.authorization;
  const apiKey = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  const employeeName = EMPLOYEES[apiKey];
  if (!employeeName) {
    return send(res, 401, { error: "Invalid or missing API key" });
  }

  const url = req.url;

  // Admin/reporting endpoint — not scoped to a single project, this is the
  // "track every employee" view. In a real backend you'd gate this behind a
  // separate admin role, not just any valid API key.
  if (req.method === "GET" && url === "/admin/employees") {
    return send(res, 200, buildEmployeeSummary());
  }

  const projectId = req.headers["x-project-id"];
  if (!projectId) {
    return send(res, 400, { error: "Missing X-Project-Id header" });
  }

  if (req.method === "GET" && url === "/tasks/mine") {
    const scoped = tasks.filter((t) => t.projectId === projectId).map(stripProjectId);
    return send(res, 200, scoped);
  }

  if (req.method === "POST" && url === "/tasks") {
    const body = await readBody(req);
    const task = {
      id: String(nextId++),
      title: body.title ?? "Untitled",
      status: "open",
      description: body.description ?? "",
      projectId,
      assignee: employeeName,
      progress: 0,
      totalMinutes: 0,
      timeLogs: [],
    };
    tasks.push(task);
    return send(res, 201, stripProjectId(task));
  }

  const statusMatch = url.match(/^\/tasks\/([^/]+)\/status$/);
  if (req.method === "PATCH" && statusMatch) {
    const id = statusMatch[1];
    const body = await readBody(req);
    const task = tasks.find((t) => t.id === id && t.projectId === projectId);
    if (!task) return send(res, 404, { error: "Task not found in this project" });
    task.status = body.status;
    return send(res, 200, stripProjectId(task));
  }

  const progressMatch = url.match(/^\/tasks\/([^/]+)\/progress$/);
  if (req.method === "PATCH" && progressMatch) {
    const id = progressMatch[1];
    const body = await readBody(req);
    const task = tasks.find((t) => t.id === id && t.projectId === projectId);
    if (!task) return send(res, 404, { error: "Task not found in this project" });
    task.progress = body.percentage;
    task.lastCommitMessage = body.commitMessage;
    task.lastActiveEmployee = employeeName;
    if (body.percentage >= 100) task.status = "done";
    else if (task.status === "open") task.status = "in-progress";
    console.log(`  → [${employeeName}] ${task.title}: ${body.percentage}% (${body.commitsDone}/${body.commitsTotal} commits) — "${body.commitMessage}"`);
    return send(res, 200, stripProjectId(task));
  }

  // This is the actual "timesheet" data point: real elapsed minutes from a
  // start/stop timer, accumulated per task AND stamped with who logged it —
  // this is what lets an admin dashboard roll up per-employee performance.
  const timeLogMatch = url.match(/^\/tasks\/([^/]+)\/timelog$/);
  if (req.method === "PATCH" && timeLogMatch) {
    const id = timeLogMatch[1];
    const body = await readBody(req);
    const task = tasks.find((t) => t.id === id && t.projectId === projectId);
    if (!task) return send(res, 404, { error: "Task not found in this project" });
    task.totalMinutes = (task.totalMinutes ?? 0) + body.minutes;
    task.timeLogs = task.timeLogs ?? []; // defensive: older in-memory tasks may predate this field
    task.timeLogs.push({
      employee: employeeName,
      minutes: body.minutes,
      note: body.note,
      loggedAt: new Date().toISOString(),
    });
    console.log(`  → [${employeeName}] ${task.title}: +${body.minutes} min (total ${task.totalMinutes} min)${body.note ? ` — "${body.note}"` : ""}`);
    return send(res, 200, stripProjectId(task));
  }

  send(res, 404, { error: "Unknown endpoint" });
}

/**
 * Rolls every task's timeLogs up into a per-employee summary — total minutes
 * logged, how many distinct tasks they touched, and their most recent
 * activity. This is the "track every employee" view an admin panel would
 * fetch from GET /admin/employees.
 */
function buildEmployeeSummary() {
  const summary = {};
  for (const name of Object.values(EMPLOYEES)) {
    summary[name] = { totalMinutes: 0, tasksTouched: new Set(), lastActiveAt: null };
  }

  for (const task of tasks) {
    for (const log of task.timeLogs ?? []) {
      const entry = summary[log.employee];
      if (!entry) continue;
      entry.totalMinutes += log.minutes;
      entry.tasksTouched.add(task.title);
      if (!entry.lastActiveAt || log.loggedAt > entry.lastActiveAt) {
        entry.lastActiveAt = log.loggedAt;
      }
    }
  }

  return Object.fromEntries(
    Object.entries(summary).map(([name, entry]) => [
      name,
      {
        totalMinutes: entry.totalMinutes,
        tasksTouched: Array.from(entry.tasksTouched),
        lastActiveAt: entry.lastActiveAt,
      },
    ])
  );
}

server.listen(PORT, () => {
  console.log(`Mock backend running at http://localhost:${PORT}`);
  console.log(`Employee API keys: ${Object.entries(EMPLOYEES).map(([k, n]) => `${n}=${k}`).join(", ")}`);
  console.log(`Seeded projects: "our-project" (2 tasks), "client-b" (1 task)`);
  console.log(`Admin summary: GET /admin/employees`);
});
