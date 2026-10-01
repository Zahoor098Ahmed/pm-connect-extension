const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const browserExe = fs.existsSync(chromePath) ? chromePath : edgePath;
const htmlFile = path.resolve(__dirname, "..", "PM_CONNECT_SETUP_GUIDE.html");
const pdfFile = path.resolve(__dirname, "..", "PM_CONNECT_SETUP_GUIDE.pdf");
const tempProfile = path.join(process.env.TEMP || "C:\\Temp", "browser-pdf-profile-" + Date.now());

const args = [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  `--user-data-dir=${tempProfile}`,
  `--print-to-pdf=${pdfFile}`,
  htmlFile,
];

console.log("Using browser:", browserExe);
console.log("Input HTML:", htmlFile);
console.log("Output PDF:", pdfFile);

execFile(browserExe, args, (error, stdout, stderr) => {
  if (error) {
    console.error("Exec error:", error);
  }
  console.log("Stdout:", stdout);
  console.log("Stderr:", stderr);

  if (fs.existsSync(pdfFile)) {
    const stats = fs.statSync(pdfFile);
    console.log(`SUCCESS: PDF generated successfully (${stats.size} bytes)!`);
  } else {
    console.log("PDF file was not created.");
  }

  // Cleanup temp profile directory
  try {
    fs.rmSync(tempProfile, { recursive: true, force: true });
  } catch {}
});
