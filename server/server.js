// server/server.js
//
// The whole GUI is: this local HTTP server + the static page in public/.
// No framework -- Node's built-in http module and a handful of routes.
// Fewer dependencies means fewer things that can go wrong installing this
// on someone else's machine.
//
// The page in the browser is just a control panel for the same automation
// engine in core/ that the original CLI version uses -- Settings writes
// .env, Entries reads/writes data/dailyLog.xlsx, and Run calls
// core/index.js's run() directly (in-process, not a spawned subprocess)
// so progress can stream back over Server-Sent Events.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const dotenv = require("dotenv");

const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const ENV_PATH = path.join(ROOT, ".env");

const { updateEnvFile } = require("./envFile");

const PORT = Number(process.env.GUI_PORT || 4287);

// ---------------------------------------------------------------------
// In-memory run state. Only one run at a time -- Playwright drives a
// single visible browser window, so a second concurrent run would just
// fight the first one over the same site session.
// ---------------------------------------------------------------------
let isRunning = false;
let logBuffer = [];
const sseClients = new Set();
let lastReportUrl = null;

// ---------------------------------------------------------------------
// Update state. Shares the same "only one automation thing at a time"
// rule as isRunning -- an update can rewrite core/ files out from under
// a running Playwright process, and a run holds the one browser session
// an update shouldn't be touched during either.
// ---------------------------------------------------------------------
let isUpdating = false;
let updateLogBuffer = [];
const updateSseClients = new Set();
let lastUpdateResult = null;

function broadcastUpdateLog(line) {
  updateLogBuffer.push(line);
  if (updateLogBuffer.length > 500) updateLogBuffer.shift();
  for (const res of updateSseClients) {
    res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
  }
}

function broadcastUpdateDone(payload) {
  for (const res of updateSseClients) {
    res.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
  }
}

function broadcastLog(line) {
  logBuffer.push(line);
  if (logBuffer.length > 500) logBuffer.shift();
  for (const res of sseClients) {
    res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
  }
}

function broadcastDone(payload) {
  for (const res of sseClients) {
    res.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
  }
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/** Serves a file from a given base directory, guarding against path traversal. */
function serveStaticFile(res, baseDir, requestedName) {
  const safeName = path.normalize(requestedName).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(baseDir, safeName);
  if (!filePath.startsWith(baseDir)) {
    sendJson(res, 400, { error: "Invalid path" });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// ---------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------

async function handleGetSettings(req, res) {
  // Requiring core/config fresh each time (via a cleared cache) would be
  // overkill -- instead the settings routes read straight from process.env
  // /.env, which updateSettings keeps in sync with the running config
  // object. This avoids ever showing a stale value after a save.
  const config = require("../core/config");
  sendJson(res, 200, {
    email: config.credentials.email || "",
    hasPassword: Boolean(config.credentials.password),
    geoLatitude: config.geolocation.latitude,
    geoLongitude: config.geolocation.longitude,
    headless: config.browser.headless,
    // Advanced (.env) settings -- deliberately a curated subset, not every
    // key in .env. Left out: BASE_URL/LOGIN_URL/DASHBOARD_URL (every
    // selector in core/config.js is hand-verified against this exact
    // site's DOM -- pointing at a different URL would just break
    // everything, not adapt to it) and DATA_FILE (a raw filesystem path,
    // easy to typo into something confusing from a text box).
    slowMo: config.browser.slowMo,
    timeoutNavigation: config.timeouts.navigation,
    timeoutAction: config.timeouts.action,
    timeoutOtp: config.timeouts.otpWait,
    retryAttempts: config.retry.attempts,
    retryDelayMs: config.retry.delayMs,
    maxEditAgeDays: config.maxEditAgeDays,
    logLevel: config.logging.level,
  });
}

async function handlePostSettings(req, res) {
  const body = await readJsonBody(req);
  const updates = {};
  // The form always submits every field, not just the one the user
  // touched -- so "was logLevel in the request" is always true and can't
  // tell us whether it actually changed. Compare against the current
  // value instead, otherwise every save falsely claims a restart is needed.
  const config = require("../core/config");
  const logLevelChanged = typeof body.logLevel === "string" && body.logLevel !== "" && body.logLevel !== config.logging.level;

  if (typeof body.email === "string") updates.LOGIN_EMAIL = body.email.trim();
  // Blank password in the form means "leave the existing one alone" --
  // the GUI never redisplays a saved password, so there's no other way
  // to distinguish "didn't change it" from "wants to clear it".
  if (typeof body.password === "string" && body.password !== "") {
    updates.LOGIN_PASSWORD = body.password;
  }
  if (body.geoLatitude !== undefined && body.geoLatitude !== "") updates.GEO_LATITUDE = String(body.geoLatitude);
  if (body.geoLongitude !== undefined && body.geoLongitude !== "") updates.GEO_LONGITUDE = String(body.geoLongitude);
  if (typeof body.headless === "boolean") updates.HEADLESS = String(body.headless);

  if (body.slowMo !== undefined && body.slowMo !== "") updates.SLOW_MO = String(body.slowMo);
  if (body.timeoutNavigation !== undefined && body.timeoutNavigation !== "") updates.TIMEOUT_NAVIGATION = String(body.timeoutNavigation);
  if (body.timeoutAction !== undefined && body.timeoutAction !== "") updates.TIMEOUT_ACTION = String(body.timeoutAction);
  if (body.timeoutOtp !== undefined && body.timeoutOtp !== "") updates.TIMEOUT_OTP = String(body.timeoutOtp);
  if (body.retryAttempts !== undefined && body.retryAttempts !== "") updates.RETRY_ATTEMPTS = String(body.retryAttempts);
  if (body.retryDelayMs !== undefined && body.retryDelayMs !== "") updates.RETRY_DELAY_MS = String(body.retryDelayMs);
  if (body.maxEditAgeDays !== undefined && body.maxEditAgeDays !== "") updates.MAX_EDIT_AGE_DAYS = String(body.maxEditAgeDays);
  if (typeof body.logLevel === "string" && body.logLevel !== "") updates.LOG_LEVEL = body.logLevel;

  updateEnvFile(ENV_PATH, updates);

  // Refresh process.env from the file, then mutate the shared config
  // object in place so the change is picked up immediately -- no restart
  // needed. core/config.js exports one plain object that every other
  // core module already holds a reference to. The same floors/caps
  // config.js applies on a fresh load (e.g. OTP wait can never go below
  // 45s -- too short for a human to read and type a code) are mirrored
  // here so a live edit can't bypass them.
  dotenv.config({ path: ENV_PATH, override: true });
  if (updates.LOGIN_EMAIL !== undefined) config.credentials.email = updates.LOGIN_EMAIL;
  if (updates.LOGIN_PASSWORD !== undefined) config.credentials.password = updates.LOGIN_PASSWORD;
  if (updates.GEO_LATITUDE !== undefined) config.geolocation.latitude = Number(updates.GEO_LATITUDE);
  if (updates.GEO_LONGITUDE !== undefined) config.geolocation.longitude = Number(updates.GEO_LONGITUDE);
  if (updates.HEADLESS !== undefined) config.browser.headless = updates.HEADLESS === "true";
  if (updates.SLOW_MO !== undefined) config.browser.slowMo = Number(updates.SLOW_MO);
  if (updates.TIMEOUT_NAVIGATION !== undefined) config.timeouts.navigation = Math.max(Number(updates.TIMEOUT_NAVIGATION), 20000);
  if (updates.TIMEOUT_ACTION !== undefined) config.timeouts.action = Number(updates.TIMEOUT_ACTION);
  if (updates.TIMEOUT_OTP !== undefined) config.timeouts.otpWait = Math.max(Number(updates.TIMEOUT_OTP), 45000);
  if (updates.RETRY_ATTEMPTS !== undefined) config.retry.attempts = Number(updates.RETRY_ATTEMPTS);
  if (updates.RETRY_DELAY_MS !== undefined) config.retry.delayMs = Math.min(Number(updates.RETRY_DELAY_MS), 15000);
  if (updates.MAX_EDIT_AGE_DAYS !== undefined) config.maxEditAgeDays = Number(updates.MAX_EDIT_AGE_DAYS);
  // LOG_LEVEL is written to .env either way, but winston's actual logger
  // instance is built once at require-time in utils/logger.js -- there's
  // no live handle to it from here, so this one genuinely needs a
  // restart of DailyBot GUI to take effect (the GUI says so).
  if (updates.LOG_LEVEL !== undefined) config.logging.level = updates.LOG_LEVEL;

  sendJson(res, 200, { ok: true, restartRequired: logLevelChanged });
}

async function handleGetEntries(req, res) {
  const { readDailyLogEntries, ensureDataFile } = require("../core/utils/dataReader");
  await ensureDataFile();
  const entries = await readDailyLogEntries();
  sendJson(
    res,
    200,
    entries.map((e) => ({
      rowNumber: e.__rowNumber,
      date: e.Date,
      partner: e.Partner || "",
      calls: e.Calls ?? "",
      meetings: e.Meetings ?? "",
      blockers: e.Blockers ?? "",
      priority: e.Priority ?? "",
      notes: e.Notes ?? "",
      latitude: e.Latitude ?? "",
      longitude: e.Longitude ?? "",
    }))
  );
}

async function handlePostEntry(req, res) {
  const body = await readJsonBody(req);
  if (!body.partner || !String(body.partner).trim()) {
    sendJson(res, 400, { error: "Partner is required." });
    return;
  }

  const ExcelJS = require("exceljs");
  const config = require("../core/config");
  const { ensureDataFile, ensureLocationColumns } = require("../core/utils/dataReader");
  await ensureDataFile();
  // Older data files (created before location overrides existed) won't
  // have these columns yet -- add them if missing before appending a row
  // that assumes they're there.
  await ensureLocationColumns();

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(config.paths.dataFile);
  const sheet = workbook.worksheets[0];
  sheet.addRow([
    body.date || "",
    body.partner,
    body.calls ?? "",
    body.meetings ?? "",
    body.blockers ?? "",
    body.priority ?? "",
    body.notes ?? "",
    body.latitude ?? "",
    body.longitude ?? "",
  ]);
  await workbook.xlsx.writeFile(config.paths.dataFile);

  sendJson(res, 200, { ok: true });
}

async function handleGetLocations(req, res) {
  const { readLocations } = require("../core/utils/locations");
  sendJson(res, 200, readLocations());
}

async function handlePostLocation(req, res) {
  const body = await readJsonBody(req);
  const name = String(body.name || "").trim();
  const lat = Number(body.latitude);
  const lng = Number(body.longitude);
  if (!name) {
    sendJson(res, 400, { error: "Name is required." });
    return;
  }
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    sendJson(res, 400, { error: "Latitude and longitude must both be numbers." });
    return;
  }
  const { addLocation } = require("../core/utils/locations");
  sendJson(res, 200, { ok: true, locations: addLocation({ name, latitude: lat, longitude: lng }) });
}

async function handleDeleteLocation(req, res, index) {
  const { removeLocation } = require("../core/utils/locations");
  sendJson(res, 200, { ok: true, locations: removeLocation(index) });
}

async function handleDeleteEntry(req, res, rowNumber) {
  const { removeRows } = require("../core/utils/dataReader");
  await removeRows([rowNumber]);
  sendJson(res, 200, { ok: true });
}

/**
 * Shared by the manual "Run Now" button and the scheduler firing --
 * same run, same live log stream either way. Returns { started: false }
 * instead of throwing if a run is already in progress, so each caller
 * can decide how to report that (an HTTP 409 for a manual click, just a
 * log line for a scheduled trigger nobody's watching).
 *
 * @param {"manual"|"scheduled"} triggeredBy
 */
function triggerRun(triggeredBy) {
  if (isRunning || isUpdating) {
    return { started: false };
  }

  isRunning = true;
  logBuffer = [];
  lastReportUrl = null;
  broadcastLog(triggeredBy === "scheduled" ? "Scheduled run starting..." : "Starting DailyBot...");

  const { run } = require("../core/index");

  run({ onLog: broadcastLog })
    .then(({ htmlPath }) => {
      lastReportUrl = `/reports/${path.basename(htmlPath)}`;
      broadcastDone({ ok: true, reportUrl: lastReportUrl });
    })
    .catch((err) => {
      broadcastLog(`Unexpected error: ${err.message}`);
      broadcastDone({ ok: false, error: err.message });
    })
    .finally(() => {
      isRunning = false;
    });

  return { started: true };
}

async function handlePostRun(req, res) {
  const result = triggerRun("manual");
  if (!result.started) {
    sendJson(res, 409, { error: "A run is already in progress." });
    return;
  }
  sendJson(res, 202, { started: true });
}

function handleGetRunStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`event: status\ndata: ${JSON.stringify({ running: isRunning })}\n\n`);
  for (const line of logBuffer) {
    res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
  }

  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
}

function handleGetRunStatus(req, res) {
  sendJson(res, 200, { running: isRunning, lastReportUrl });
}

function schedulerStatusPayload() {
  const scheduler = require("../core/scheduler");
  const status = scheduler.getStatus();
  const friendly = status.cronExpression ? scheduler.parseSimpleCronExpression(status.cronExpression) : null;
  return { ...status, friendly };
}

async function handleGetScheduler(req, res) {
  sendJson(res, 200, schedulerStatusPayload());
}

async function handlePostScheduler(req, res) {
  const body = await readJsonBody(req);
  const scheduler = require("../core/scheduler");
  const config = require("../core/config");

  const enabled = Boolean(body.enabled);
  const timezone = typeof body.timezone === "string" && body.timezone.trim() ? body.timezone.trim() : config.schedule.timezone;

  // The On/Off toggle controls whether the schedule is ACTIVE, not
  // whether an edit gets saved -- editing the time/days while toggled
  // off should still be remembered for next time you turn it on. Only
  // fall back to whatever's already configured when neither the picker
  // nor the raw cron field actually supplied anything new (e.g. a plain
  // {enabled:false} call with nothing else, which should never fail
  // just because there's no time to build a cron from).
  const hasNewSchedule =
    (typeof body.cronExpression === "string" && body.cronExpression.trim()) ||
    (typeof body.time === "string" && body.time.trim());

  let cronExpression = config.schedule.cron;
  if (hasNewSchedule) {
    try {
      cronExpression =
        typeof body.cronExpression === "string" && body.cronExpression.trim()
          ? body.cronExpression.trim()
          : scheduler.buildCronExpression(body.time, body.weekdays);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
  }

  if (enabled) {
    try {
      scheduler.start(cronExpression, timezone, () => triggerRun("scheduled"));
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
  } else {
    scheduler.stop();
  }

  updateEnvFile(ENV_PATH, {
    SCHEDULE_CRON: cronExpression,
    SCHEDULE_TZ: timezone,
    SCHEDULER_AUTOSTART: String(enabled),
  });
  dotenv.config({ path: ENV_PATH, override: true });
  config.schedule.cron = cronExpression;
  config.schedule.timezone = timezone;
  config.schedule.autoStart = enabled;

  sendJson(res, 200, schedulerStatusPayload());
}

async function handleGetReports(req, res) {
  const config = require("../core/config");
  const dir = config.paths.reports;
  if (!fs.existsSync(dir)) {
    sendJson(res, 200, []);
    return;
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith("_report.html"))
    .map((f) => ({
      name: f,
      url: `/reports/${f}`,
      mtime: fs.statSync(path.join(dir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  sendJson(res, 200, files);
}

async function handleGetVersion(req, res) {
  const gitDir = path.join(ROOT, ".git");
  if (!fs.existsSync(gitDir)) {
    sendJson(res, 200, { isGit: false });
    return;
  }
  const { execFile } = require("child_process");
  execFile("git", ["log", "-1", "--format=%h %ci"], { cwd: ROOT }, (err, stdout) => {
    if (err) {
      sendJson(res, 200, { isGit: true, commit: null });
      return;
    }
    const [hash, ...dateParts] = stdout.trim().split(" ");
    sendJson(res, 200, { isGit: true, commit: hash, date: dateParts.join(" ") });
  });
}

async function handleGetUpdateStatus(req, res) {
  sendJson(res, 200, { updating: isUpdating, lastResult: lastUpdateResult });
}

function handleGetUpdateStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`event: status\ndata: ${JSON.stringify({ updating: isUpdating })}\n\n`);
  for (const line of updateLogBuffer) {
    res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
  }

  updateSseClients.add(res);
  req.on("close", () => updateSseClients.delete(res));
}

// Recognized as the last line update-core.ps1 prints -- see that file for
// what each variant means. Everything else it prints is just for humans.
const UPDATE_RESULT_PREFIX = "RESULT:";

async function handlePostUpdate(req, res) {
  if (isRunning) {
    sendJson(res, 409, { error: "A run is in progress -- wait for it to finish before updating." });
    return;
  }
  if (isUpdating) {
    sendJson(res, 409, { error: "An update is already in progress." });
    return;
  }

  isUpdating = true;
  updateLogBuffer = [];
  lastUpdateResult = null;
  broadcastUpdateLog("Starting update...");

  const scriptPath = path.join(ROOT, "update-core.ps1");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { cwd: ROOT }
  );

  let resultLine = null;
  let stdoutTail = "";

  const handleChunk = (chunk) => {
    stdoutTail += chunk.toString();
    const lines = stdoutTail.split(/\r?\n/);
    stdoutTail = lines.pop(); // last piece may be incomplete -- hold it for the next chunk
    for (const line of lines) {
      if (line.startsWith(UPDATE_RESULT_PREFIX)) {
        resultLine = line.slice(UPDATE_RESULT_PREFIX.length);
        continue; // machine-readable marker, not for the log
      }
      if (line.trim()) broadcastUpdateLog(line);
    }
  };

  child.stdout.on("data", handleChunk);
  child.stderr.on("data", handleChunk);

  child.on("close", (code) => {
    if (stdoutTail.trim() && !stdoutTail.startsWith(UPDATE_RESULT_PREFIX)) {
      broadcastUpdateLog(stdoutTail);
    }

    let payload;
    if (resultLine === "SUCCESS_INPLACE") {
      payload = { ok: true, mode: "inplace" };
    } else if (resultLine && resultLine.startsWith("SUCCESS_NEWFOLDER_NO_NODE:")) {
      payload = { ok: true, mode: "newfolder-no-node", path: resultLine.split(":").slice(1).join(":") };
    } else if (resultLine && resultLine.startsWith("SUCCESS_NEWFOLDER:")) {
      payload = { ok: true, mode: "newfolder", path: resultLine.split(":").slice(1).join(":") };
    } else if (resultLine === "FAILED") {
      payload = { ok: false, error: "Update failed -- see the log above for why." };
    } else {
      payload = { ok: false, error: code === 0 ? "Update finished without a clear result -- check the log above." : `Update script exited unexpectedly (code ${code}) -- check the log above.` };
    }

    lastUpdateResult = payload;
    isUpdating = false;
    broadcastUpdateDone(payload);
  });

  child.on("error", (err) => {
    const payload = { ok: false, error: `Could not start the update script: ${err.message}` };
    lastUpdateResult = payload;
    isUpdating = false;
    broadcastUpdateDone(payload);
  });

  sendJson(res, 202, { started: true });
}

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const [pathname, query] = req.url.split("?");

    if (req.method === "GET" && pathname === "/") {
      serveStaticFile(res, PUBLIC_DIR, "index.html");
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/public/")) {
      serveStaticFile(res, PUBLIC_DIR, pathname.replace("/public/", ""));
      return;
    }
    if (req.method === "GET" && pathname === "/api/settings") return handleGetSettings(req, res);
    if (req.method === "POST" && pathname === "/api/settings") return await handlePostSettings(req, res);

    if (req.method === "GET" && pathname === "/api/entries") return await handleGetEntries(req, res);
    if (req.method === "POST" && pathname === "/api/entries") return await handlePostEntry(req, res);
    const deleteMatch = pathname.match(/^\/api\/entries\/(\d+)$/);
    if (req.method === "DELETE" && deleteMatch) return await handleDeleteEntry(req, res, Number(deleteMatch[1]));

    if (req.method === "GET" && pathname === "/api/locations") return await handleGetLocations(req, res);
    if (req.method === "POST" && pathname === "/api/locations") return await handlePostLocation(req, res);
    const deleteLocationMatch = pathname.match(/^\/api\/locations\/(\d+)$/);
    if (req.method === "DELETE" && deleteLocationMatch) return await handleDeleteLocation(req, res, Number(deleteLocationMatch[1]));

    if (req.method === "POST" && pathname === "/api/run") return await handlePostRun(req, res);
    if (req.method === "GET" && pathname === "/api/run/stream") return handleGetRunStream(req, res);
    if (req.method === "GET" && pathname === "/api/run/status") return handleGetRunStatus(req, res);

    if (req.method === "GET" && pathname === "/api/scheduler") return await handleGetScheduler(req, res);
    if (req.method === "POST" && pathname === "/api/scheduler") return await handlePostScheduler(req, res);

    if (req.method === "GET" && pathname === "/api/reports") return await handleGetReports(req, res);

    if (req.method === "GET" && pathname === "/api/version") return await handleGetVersion(req, res);
    if (req.method === "POST" && pathname === "/api/update") return await handlePostUpdate(req, res);
    if (req.method === "GET" && pathname === "/api/update/stream") return handleGetUpdateStream(req, res);
    if (req.method === "GET" && pathname === "/api/update/status") return await handleGetUpdateStatus(req, res);
    if (req.method === "GET" && pathname.startsWith("/reports/")) {
      const config = require("../core/config");
      serveStaticFile(res, config.paths.reports, pathname.replace("/reports/", ""));
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/screenshots/")) {
      const config = require("../core/config");
      serveStaticFile(res, config.paths.screenshots, pathname.replace("/screenshots/", ""));
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

// Bind explicitly to localhost -- Node defaults to all network
// interfaces (0.0.0.0) when no host is given, which would make this
// server (saved credentials, a button that triggers a real automation
// run, zero authentication) reachable by anyone else on the same
// network, not just this computer.
server.listen(PORT, "127.0.0.1", () => {
  console.log("====================================");
  console.log("   DailyBot GUI running");
  console.log(`   http://localhost:${PORT}`);
  console.log("====================================");

  // Resume the schedule from last time, if one was saved as enabled.
  const config = require("../core/config");
  if (config.schedule.autoStart && config.schedule.cron) {
    const scheduler = require("../core/scheduler");
    try {
      scheduler.start(config.schedule.cron, config.schedule.timezone, () => triggerRun("scheduled"));
      console.log(`   Scheduler resumed: "${config.schedule.cron}" (${config.schedule.timezone || "system timezone"})`);
    } catch (err) {
      console.log(`   Could not resume scheduler: ${err.message}`);
    }
  }
});
