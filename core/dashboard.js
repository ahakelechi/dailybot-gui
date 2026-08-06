// core/dashboard.js
//
// login is finished. dashboard begins. This module only navigates --
// no forms, no screenshots (except on failure, for diagnostics). It
// opens the dashboard, clicks into "Daily Log", waits, and verifies it
// landed on the right page.

const config = require("./config");
const logger = require("./utils/logger");
const { takeScreenshot } = require("./utils/screenshots");
const { withRetry } = require("./utils/retry");
const { waitVisible, sleep, formatDateOnly } = require("./utils/helpers");
const { captureDuring } = require("./utils/networkCapture");

/**
 * Click prev/next month arrows in the date picker until the target
 * month/year is showing. Safe no-op if the target is already the
 * current month (the common case: today, or a missed date earlier this
 * month).
 *
 * @param {import('playwright').Page} page
 * @param {Date} targetDate
 */
async function navigateToMonth(page, targetDate) {
  const targetLabel = targetDate.toLocaleString("en-US", { month: "long", year: "numeric" });
  const maxSteps = 24; // safety cap, ~2 years either direction

  for (let i = 0; i < maxSteps; i++) {
    const labelLocator = config.selectors.dashboard.calendarMonthLabel(page).first();
    const labelVisible = await waitVisible(labelLocator, 3000);
    if (!labelVisible) {
      logger.warning(
        "Could not find a calendar month label -- skipping month navigation. " +
          "This is fine if the target date is in the currently-shown month; " +
          "otherwise the day-button click below will likely fail."
      );
      return;
    }

    const currentLabel = (await labelLocator.textContent())?.trim();
    if (currentLabel === targetLabel) return;

    const currentAsDate = new Date(`1 ${currentLabel}`);
    if (Number.isNaN(currentAsDate.getTime())) {
      logger.warning(`Could not parse calendar month label "${currentLabel}" -- giving up on navigation.`);
      return;
    }

    if (currentAsDate < targetDate) {
      await config.selectors.dashboard.calendarNextMonthButton(page).click();
    } else {
      await config.selectors.dashboard.calendarPrevMonthButton(page).click();
    }
    await sleep(300); // let the picker re-render before checking again
  }

  logger.warning(`Could not navigate the calendar to ${targetLabel} after ${maxSteps} attempts.`);
}

/**
 * Navigate from the dashboard into the Daily Log form for a specific date.
 *
 * @param {import('playwright').Page} page
 * @param {Date} [targetDate] - defaults to today.
 * @returns {Promise<import('playwright').Page>}
 */
async function openDailyLog(page, targetDate = new Date()) {
  const isoDate = formatDateOnly(targetDate);

  return withRetry(
    async (attempt) => {
      // The site gives each day its own URL (/admin/daily-log/YYYY-MM-DD),
      // which is exactly where clicking a calendar cell lands. Going
      // straight there skips the sidebar click, the month navigation and
      // the day-cell click -- three separate things that can each go
      // wrong -- so it's tried first. The click-through path below stays
      // as the fallback for anything the direct URL doesn't handle.
      try {
        await page.goto(config.urls.dailyLogForDate(isoDate), { waitUntil: "networkidle" });
        const formOpen = await waitVisible(
          config.selectors.dashboard.pageMarker(page),
          config.timeouts.action
        );
        if (formOpen) {
          logger.info(`✅ Daily Log form is open for ${isoDate} (direct URL).`);
          return page;
        }
        logger.info(
          `Direct URL for ${isoDate} did not open the form -- falling back to clicking through the calendar.`
        );
      } catch (err) {
        logger.warning(
          `Direct URL for ${isoDate} failed (${err.message}) -- falling back to clicking through the calendar.`
        );
      }

      const dailyLogLink = config.selectors.dashboard.dailyLogLink(page);

      // Right after a successful login (or after finishing a previous
      // date's entries), the page is already sitting somewhere with this
      // link visible in the sidebar. Reloading here is redundant and, on
      // an SPA, can race against however the site re-establishes client
      // state after navigation. So: only (re)navigate if the link
      // genuinely isn't there yet -- e.g. on retry attempts after a real
      // failure.
      const alreadyThere = await waitVisible(dailyLogLink, 8000);
      if (!alreadyThere) {
        logger.info(`Opening dashboard (attempt ${attempt})...`);
        try {
          await captureDuring(
            page,
            async () => {
              // "networkidle" instead of "domcontentloaded": the latter
              // only means the raw HTML parsed, not that the SPA has
              // finished deciding (via its own async auth check) whether
              // to show the dashboard or redirect to sign-in.
              await page.goto(config.urls.dashboard, { waitUntil: "networkidle" });
              await dailyLogLink.waitFor({ state: "visible", timeout: config.timeouts.navigation });
            },
            "dashboard-link-not-found"
          );
        } catch (err) {
          await takeScreenshot(page, { name: "dashboard-link-not-found" });
          throw err;
        }
      }

      logger.info("Clicking Log My Day...");
      await dailyLogLink.click();

      await navigateToMonth(page, targetDate);

      logger.info(`Selecting ${targetDate.toDateString()} (${isoDate}) in the date picker...`);
      await config.selectors.dashboard.dayButton(page, isoDate).click();

      const onCorrectPage = await waitVisible(
        config.selectors.dashboard.pageMarker(page),
        config.timeouts.action
      );

      if (!onCorrectPage) {
        await takeScreenshot(page, { name: "dashboard-wrong-page" });
        throw new Error(
          `Did not land on the Daily Log form after selecting ${targetDate.toDateString()} (pageMarker not found).`
        );
      }

      logger.info("✅ Daily Log form is open.");
      return page;
    },
    { label: `open daily log (${targetDate.toDateString()})` }
  );
}

module.exports = { openDailyLog };
