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
  const { ensureDataFile } = require("../core/utils/dataReader");
  await ensureDataFile();

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
  ]);
  await workbook.xlsx.writeFile(config.paths.dataFile);

  sendJson(res, 200, { ok: true });
}

async function handleDeleteEntry(req, res, rowNumber) {
  const { removeRows } = require("../core/utils/dataReader");
  await removeRows([rowNumber]);
  sendJson(res, 200, { ok: true });
}

async function handlePostRun(req, res) {
  if (isRunning) {
    sendJson(res, 409, { error: "A run is already in progress." });
    return;
  }

  isRunning = true;
  logBuffer = [];
  lastReportUrl = null;
  broadcastLog("Starting DailyBot...");

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

    if (req.method === "POST" && pathname === "/api/run") return await handlePostRun(req, res);
    if (req.method === "GET" && pathname === "/api/run/stream") return handleGetRunStream(req, res);
    if (req.method === "GET" && pathname === "/api/run/status") return handleGetRunStatus(req, res);

    if (req.method === "GET" && pathname === "/api/reports") return await handleGetReports(req, res);
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

server.listen(PORT, () => {
  console.log("====================================");
  console.log("   DailyBot GUI running");
  console.log(`   http://localhost:${PORT}`);
  console.log("====================================");
});
