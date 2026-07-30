// core/reports.js
//
// This module knows nothing about browsers. It simply reads execution
// time, errors, screenshots, successes, and warnings, then builds a
// JSON report (machine-readable) and an HTML report (human-readable).

const fs = require("fs");
const path = require("path");
const config = require("./config");
const logger = require("./utils/logger");
const { ensureDir, formatDate, formatDisplayDate } = require("./utils/helpers");

ensureDir(config.paths.reports);

/**
 * @param {Object} summary
 * @param {Date} summary.startTime
 * @param {Date} summary.endTime
 * @param {Array} summary.results - successful entries, e.g. [{ partner, success }]
 * @param {Array} summary.errors - failed entries, e.g. [{ partner, message }]
 * @param {Array<string>} [summary.screenshots] - file paths of any screenshots taken
 * @param {string} [summary.fatalError] - message if the whole run failed
 */
async function generateReport(summary) {
  const {
    startTime,
    endTime,
    results = [],
    errors = [],
    screenshots = [],
    fatalError = null,
  } = summary;

  const durationMs = endTime - startTime;
  const durationSec = (durationMs / 1000).toFixed(1);

  const report = {
    generatedAt: new Date().toISOString(),
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    durationSeconds: Number(durationSec),
    status: fatalError ? "failed" : errors.length > 0 ? "partial" : "success",
    fatalError,
    successCount: results.length,
    errorCount: errors.length,
    results,
    errors,
    screenshots,
  };

  const stamp = formatDate(endTime);
  const jsonPath = path.join(config.paths.reports, `${stamp}_report.json`);
  const htmlPath = path.join(config.paths.reports, `${stamp}_report.html`);

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(htmlPath, buildHtml(report, startTime, endTime));

  logger.info(`Report written: ${jsonPath}`);
  logger.info(`Report written: ${htmlPath}`);

  return { jsonPath, htmlPath, report };
}

function buildHtml(report, startTime, endTime) {
  const statusColor = { success: "#1a7f37", partial: "#b26a00", failed: "#c0392b" }[report.status];

  const rows = (items, columns) =>
    items
      .map((item) => `<tr>${columns.map((c) => `<td>${escapeHtml(String(item[c] ?? ""))}</td>`).join("")}</tr>`)
      .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>DailyBot Report - ${formatDisplayDate(endTime)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background: #f4f5f7; color: #1a1a1a; margin: 0; padding: 32px; }
  .card { background: #fff; border-radius: 10px; padding: 24px 28px; max-width: 760px; margin: 0 auto 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .status { display: inline-block; padding: 2px 10px; border-radius: 12px; color: #fff; font-size: 13px; font-weight: 600; background: ${statusColor}; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 14px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; }
  th { color: #666; font-weight: 600; font-size: 12px; text-transform: uppercase; }
  .muted { color: #777; font-size: 13px; }
</style>
</head>
<body>
  <div class="card">
    <h1>DailyBot Run Report</h1>
    <p class="muted">${formatDisplayDate(startTime)} &rarr; ${formatDisplayDate(endTime)} (${report.durationSeconds}s)</p>
    <span class="status">${report.status.toUpperCase()}</span>
    ${report.fatalError ? `<p style="color:${statusColor}">${escapeHtml(report.fatalError)}</p>` : ""}
  </div>

  <div class="card">
    <h1>Successful entries (${report.successCount})</h1>
    <table>
      <tr><th>Partner</th></tr>
      ${rows(report.results, ["partner"])}
    </table>
  </div>

  <div class="card">
    <h1>Errors (${report.errorCount})</h1>
    <table>
      <tr><th>Partner</th><th>Message</th></tr>
      ${rows(report.errors, ["partner", "message"])}
    </table>
  </div>

  <div class="card">
    <h1>Screenshots</h1>
    <p class="muted">${report.screenshots.length} screenshot(s) captured in /screenshots</p>
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

module.exports = { generateReport };
