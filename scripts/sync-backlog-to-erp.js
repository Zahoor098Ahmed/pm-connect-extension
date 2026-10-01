#!/usr/bin/env node
/**
 * PM Connect — Backlog to ERP Calibrator & Syncer
 *
 * Reads exact session time date-by-date from BACKLOG.md and synchronizes it
 * idempotently to the ERP backend via /sync-time ($set, never blind $inc).
 * Ensures ERP time always matches BACKLOG.md 100% with ZERO duplicate minutes.
 */

const path = require("path");
const ROOT_DIR = path.resolve(__dirname, "..");
const { getTimeSummaryFromBacklog } = require(path.join(ROOT_DIR, "src", "backlogFile"));

const fetch = globalThis.fetch || require("node-fetch");

async function syncBacklogToErp(projectDir = ROOT_DIR) {
  const summary = getTimeSummaryFromBacklog(projectDir);
  if (!summary || !Array.isArray(summary.dateBreakdown)) {
    console.error("❌ Failed to parse BACKLOG.md time summary.");
    process.exit(1);
  }

  const projectId = process.env.PM_PROJECT_ID || "97972dcf-f3d3-4c8c-8eb0-828d6e359103";
  const apiKey = process.env.PM_API_KEY || "73a62b15-eb2c-42f9-a43d-9cffc648a1bd";
  const erpBaseUrl = process.env.PM_ERP_URL || "http://localhost:5052/api/pmconnect";

  console.log(`\n📋 BACKLOG.md Time Summary (${projectDir}):`);
  console.log(` • Today (${summary.todayDate}): ${summary.todayMinutes}m (${summary.todayHours}h)`);
  console.log(` • Total (From start): ${summary.totalMinutes}m (${summary.totalHours}h)`);
  console.log(` • Dates (${summary.dateBreakdown.length}):`);
  for (const d of summary.dateBreakdown) {
    console.log(`    - ${d.date}: ${d.minutes} min (${d.hours}h)`);
  }

  const targetUrl = `${erpBaseUrl.replace(/\/+$/, "")}/sync-time`;
  console.log(`\n🚀 Uploading exact time to ERP at ${targetUrl}...`);

  try {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Project-Id": projectId,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        projectId,
        todayMinutes: summary.todayMinutes,
        totalMinutes: summary.totalMinutes,
        dateBreakdown: summary.dateBreakdown,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`❌ ERP responded with HTTP ${res.status}: ${errText}`);
      process.exit(1);
    }

    const data = await res.json();
    console.log("✅ Successfully synced to ERP!");
    console.log(`   ERP Response:`, data);
  } catch (err) {
    console.error("❌ Network error connecting to ERP:", err.message);
    process.exit(1);
  }
}

const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : ROOT_DIR;
syncBacklogToErp(targetDir);
