// core/index.js
//
// The Project Manager / Controller. It does not know how to log in, fill
// forms, or take screenshots -- it simply coordinates the modules that do.
// Every other file only talks to the modules it actually needs; index.js
// is the only one that sees the whole picture.
//
//   Load Config -> Create Logger -> Create Browser -> Restore Session
//     -> Session valid? --YES--> Dashboard -> Forms -> Reports -> Close
//                       --NO---> Login -> Save Session -> Dashboard -> Forms -> Reports -> Close
//
// On any failure: log it, screenshot it, still generate a report, still
// close the browser. No crashes -- a controlled shutdown every time.

const config = require("./config");
const logger = require("./utils/logger");
const { launchBrowser, closeBrowser, clearSession } = require("./browser");
const { login, isSessionValid } = require("./login");
const { isLoggedIn } = require("./utils/validation");
const { openDailyLog } = require("./dashboard");
const { submitEntriesForDay } = require("./forms");
const { readDailyLogEntries, groupEntriesByDate, removeRows } = require("./utils/dataReader");
const { generateReport } = require("./reports");
const { takeScreenshot } = require("./utils/screenshots");

/**
 * Run one full DailyBot pass: login (or resume session), open the Daily
 * Log form, submit every row in data/dailyLog.xlsx, and write a report.
 *
 * Exposed as a function (rather than only running on require) so the GUI
 * server and scheduler.js can call it repeatedly without spawning a new
 * process each time.
 *
 * @param {Object} [options]
 * @param {(line: string) => void} [options.onLog] - called with each
 *   human-readable progress line, in addition to the normal logger output.
 *   Used by the GUI server to stream progress to the browser.
 * @returns {Promise<{jsonPath: string, htmlPath: string, report: Object}>}
 */
async function run(options = {}) {
  const { onLog } = options;
  const emit = (line) => {
    if (onLog) {
      try {
        onLog(line);
      } catch {
        // never let a broken listener take down the actual run
      }
    }
  };

  const startTime = new Date();
  let browser;
  const screenshots = [];
  let results = [];
  let errors = [];
  let fatalError = null;

  emit("====================================");
  emit("      DailyBot Starting...");
  emit("====================================");

  try {
    const session = await launchBrowser();
    browser = session.browser;
    const { context, page } = session;

    let sessionValid = false;
    try {
      sessionValid = await isSessionValid(page);
    } catch (err) {
      logger.warning(`Session validity check errored: ${err.message}`);
    }

    if (sessionValid) {
      logger.info("✅ Existing session is valid -- skipping login.");
    } else {
      logger.info("Session invalid or missing -- logging in...");
      // Login expired or absent sessions can't be trusted; clear whatever
      // stale state.json exists so we don't restore it again next run.
      clearSession();
      emit("A browser window has opened. If it asks for a login code, type it into that window.");
      await login(page, context);
    }

    const entries = await readDailyLogEntries();
    const dateGroups = groupEntriesByDate(entries);

    if (dateGroups.length === 0) {
      logger.warning("No entries found in data/dailyLog.xlsx -- nothing to submit.");
    }

    for (const { date, entries: dayEntries } of dateGroups) {
      // "YYYY-MM-DD" parsed with an explicit local-midnight time, not
      // `new Date("YYYY-MM-DD")` -- that form is parsed as UTC by the
      // spec, which can land on the wrong day-of-month once shifted to a
      // local timezone behind UTC.
      const targetDate = new Date(`${date}T00:00:00`);

      // The site rejects any save more than config.maxEditAgeDays old
      // with a 400 ("Editing logs older than N days is disabled."), no
      // matter how many times it's retried. Catching this upfront --
      // before ever opening the browser flow for this date -- avoids a
      // guaranteed-futile fill-and-submit-and-retry cycle.
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const daysOld = Math.floor((today.getTime() - targetDate.getTime()) / 86400000);
      if (daysOld > config.maxEditAgeDays) {
        const message =
          `${daysOld} days old, past the site's ${config.maxEditAgeDays}-day edit window ` +
          `("Editing logs older than ${config.maxEditAgeDays} days is disabled.")`;
        logger.warning(`Skipping ${date} -- ${message}`);
        emit(`Skipping ${date} -- ${message}`);
        errors.push(...dayEntries.map((e) => ({ partner: e.Partner, date, message })));
        continue;
      }

      // The site also blocks the opposite direction: a date doesn't open
      // up for logging until that day actually arrives, no matter how far
      // ahead it's entered here. Skip it now rather than run the whole
      // fill-and-submit flow against a date the site won't accept yet --
      // it'll be picked up automatically on a future run once daysOld
      // reaches 0.
      if (daysOld < 0) {
        const message = `${date} is a future date -- the site won't open it for logging until that day arrives.`;
        logger.warning(`Skipping ${date} -- ${message}`);
        emit(`Skipping ${date} -- ${message}`);
        errors.push(...dayEntries.map((e) => ({ partner: e.Partner, date, message })));
        continue;
      }

      // Don't check login status pre-emptively before every date -- that
      // races against the SPA re-hydrating its client-side auth state and
      // produces false "session expired" positives more often than the
      // session actually died. Just try to process the date; only
      // investigate a real logout if it genuinely fails, then retry this
      // same date exactly once after logging back in.
      let attemptedRelogin = false;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          emit(`Processing ${date}...`);
          await openDailyLog(page, targetDate);
          const dayResult = await submitEntriesForDay(page, dayEntries);
          results.push(...dayResult.results);
          errors.push(...dayResult.errors);
          break;
        } catch (err) {
          // If the browser/page itself is gone, there's nothing left to
          // recover on this page -- stop immediately and let the whole
          // run end cleanly instead of repeating the same dead-page error.
          if (page.isClosed()) {
            throw new Error(`Browser window was closed while processing ${date} -- stopping the run. (${err.message})`);
          }

          if (!attemptedRelogin) {
            attemptedRelogin = true;
            await page.goto(config.urls.dashboard, { waitUntil: "domcontentloaded" }).catch(() => {});
            const stillLoggedIn = await isLoggedIn(page, { timeout: config.timeouts.navigation });
            if (!stillLoggedIn) {
              logger.warning(`Session actually expired while processing ${date} -- logging in again...`);
              emit(`Session expired -- logging in again. A browser window will need the login code if asked.`);
              clearSession();
              await login(page, context);
              continue; // retry this same date once, now genuinely logged back in
            }
          }
          logger.error(`Could not process ${date}`, err);
          emit(`Could not process ${date}: ${err.message}`);
          errors.push(...dayEntries.map((e) => ({ partner: e.Partner, date, message: err.message })));
          break;
        }
      }
    }
  } catch (err) {
    fatalError = err.message;
    logger.error("DailyBot failed", err);
    emit(`DailyBot failed: ${err.message}`);

    if (browser) {
      try {
        const pages = browser.contexts().flatMap((c) => c.pages());
        const page = pages[pages.length - 1];
        if (page) {
          const shot = await takeScreenshot(page, { name: "fatal-error" });
          if (shot) screenshots.push(shot);
        }
      } catch (screenshotErr) {
        logger.warning(`Could not capture failure screenshot: ${screenshotErr.message}`);
      }
    }
  } finally {
    await closeBrowser(browser);
  }

  // Remove every row that actually made it in, so a future run (especially
  // one that starts after this very run crashed partway through) can never
  // resubmit an already-logged visit against the real site.
  const submittedRowNumbers = results.map((r) => r.rowNumber).filter((n) => typeof n === "number");
  if (submittedRowNumbers.length > 0) {
    try {
      await removeRows(submittedRowNumbers);
      logger.info(`Removed ${submittedRowNumbers.length} submitted row(s) from the data file.`);
    } catch (err) {
      logger.warning(`Could not remove submitted rows from the data file: ${err.message}`);
    }
  }

  const endTime = new Date();

  const { jsonPath, htmlPath, report } = await generateReport({
    startTime,
    endTime,
    results,
    errors,
    screenshots,
    fatalError,
  });

  if (fatalError) {
    emit(`❌ DailyBot failed. See report: ${htmlPath}`);
  } else if (errors.length > 0) {
    emit(`⚠️  DailyBot finished with ${errors.length} error(s). See report: ${htmlPath}`);
  } else {
    emit(`✅ DailyBot finished successfully. See report: ${htmlPath}`);
  }

  return { jsonPath, htmlPath, report };
}

// Only auto-run when executed directly (`node index.js`), not when
// required by the GUI server or scheduler.js.
if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Fatal error outside run():", err);
      process.exit(1);
    });
}

module.exports = { run };
