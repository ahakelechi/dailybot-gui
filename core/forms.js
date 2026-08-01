// core/forms.js
//
// This becomes the biggest module, because every website has forms. It
// fills in calls/meetings/blockers/priority/notes for each entry handed
// to it and submits, confirming the submission actually succeeded
// (utils/validation.js). It does NOT navigate or decide which day/entries
// to submit -- that's index.js's job (via dashboard.js + utils/dataReader.js)
// -- forms.js only fills whatever form is already open. Retries and
// screenshots are handled per-entry so one bad row doesn't sink the rest
// of the day, let alone the whole run.

const config = require("./config");
const logger = require("./utils/logger");
const { validateSubmission } = require("./utils/validation");
const { takeScreenshot } = require("./utils/screenshots");
const { withRetry } = require("./utils/retry");
const { waitVisible, sanitizeForFilename } = require("./utils/helpers");
const { captureDuring } = require("./utils/networkCapture");

/**
 * Fill and submit one daily-log entry into the currently-open form.
 *
 * @param {import('playwright').Page} page
 * @param {Object} entry - one row from the Excel data file.
 * @param {Object} [options]
 * @param {boolean} [options.isLastOfDay] - if true, uses the final "save
 *   and close" button; otherwise uses "Save & Add Another Visit" so the
 *   form stays open for the next entry on the same day.
 */
async function submitEntry(page, entry, options = {}) {
  const { form } = config.selectors;
  const partner = String(entry.Partner || "").trim();
  const isLastOfDay = options.isLastOfDay !== false; // default true (single-entry days, unchanged behavior)

  if (!partner) {
    throw new Error("Row is missing a Partner value -- skipping is unsafe, fix data/dailyLog.xlsx.");
  }

  // Partner is free text from the GUI's Add Entry form -- fine to use
  // as-is for matching the real site's combobox, but NOT safe to drop
  // straight into a filename (a "/", "\", or ".." could write outside
  // the intended folder, or just fail to save). These sanitized copies
  // are only ever used for screenshot/diagnostic filenames below.
  const partnerForFilename = sanitizeForFilename(partner);
  const dateForFilename = sanitizeForFilename(entry.Date || "unknown-date");

  return withRetry(
    async () => {
      logger.info(`Filling entry for partner: ${partner}`);

      // Per-entry location override: blank Latitude/Longitude columns
      // mean "use the default from Settings" -- anything else overrides
      // it for just this one visit. Playwright's context.setGeolocation()
      // can be called any time during a session, so each entry in the
      // same day can genuinely report a different place, matching a rep
      // actually visiting different locations. This has to happen BEFORE
      // the "Enable location" flow below, so the site picks up the right
      // coordinates when it asks.
      const hasLatOverride = entry.Latitude !== undefined && entry.Latitude !== "";
      const hasLngOverride = entry.Longitude !== undefined && entry.Longitude !== "";
      let lat = hasLatOverride ? Number(entry.Latitude) : config.geolocation.latitude;
      let lng = hasLngOverride ? Number(entry.Longitude) : config.geolocation.longitude;
      if (Number.isNaN(lat) || Number.isNaN(lng)) {
        logger.warning(
          `Entry for ${partner} has an invalid Latitude/Longitude (${entry.Latitude}, ${entry.Longitude}) -- falling back to the default location.`
        );
        lat = config.geolocation.latitude;
        lng = config.geolocation.longitude;
      }
      await page.context().setGeolocation({ latitude: lat, longitude: lng });
      if (hasLatOverride || hasLngOverride) {
        logger.info(`Using entry-specific location for ${partner}: ${lat}, ${lng}`);
      }

      // The form has a required Location field that silently blocks
      // saving until enabled. Granting geolocation permission at the
      // browser-context level (browser.js) should prevent this button
      // from appearing at all, but check for it anyway in case the site
      // still requires an explicit click.
      const enableLocation = form.enableLocationButton(page);
      const locationPromptShown = await waitVisible(enableLocation, 3000);
      if (locationPromptShown) {
        logger.info('Location prompt detected -- clicking "Enable location"...');
        await enableLocation.click();
        // The button's own accessible name changes to "Locating..." while
        // resolving -- waiting for "Enable location" to become hidden is
        // NOT proof location finished, only that its label changed. Wait
        // out the "Locating..." state too (if it appears) before treating
        // location as handled.
        await enableLocation
          .waitFor({ state: "hidden", timeout: config.timeouts.action })
          .catch(() => {
            logger.warning('"Enable location" button did not disappear after clicking -- continuing anyway.');
          });

        const locating = form.locatingIndicator(page);
        const stillLocating = await waitVisible(locating, 1000);
        if (stillLocating) {
          logger.info('Waiting for "Locating..." to resolve...');
          await locating.waitFor({ state: "hidden", timeout: config.timeouts.action }).catch(() => {
            throw new Error(
              'Location never resolved -- "Locating..." was still showing after ' +
                `${config.timeouts.action / 1000}s. The site's Location field will block saving until this finishes.`
            );
          });
        }
      }

      await form.partnerTrigger(page).click();

      // The combobox is a searchable field. Rather than hunting for the
      // search input's own selector, just type directly: opening this
      // kind of combobox (shadcn/cmdk-style) auto-focuses its own search
      // field, so keystrokes land there without needing to locate/click
      // it first.
      await page.keyboard.type(partner, { delay: 50 });

      const option = form.partnerOption(page, partner).first();
      const found = await waitVisible(option, config.timeouts.action);
      if (!found) {
        // Capture exactly what the dropdown looks like at the moment of
        // failure -- this is the fastest way to tell whether typing
        // didn't filter it, the option renders differently than expected,
        // or the partner name genuinely isn't in the list.
        await takeScreenshot(page, { name: `partner-not-found-${partnerForFilename}` });
        throw new Error(
          `Partner option "${partner}" did not appear after typing into the combobox. ` +
            `Check the partner-not-found-${partnerForFilename} screenshot in screenshots/.`
        );
      }
      await option.click();

      if (entry.Calls !== undefined) {
        await form.callsInput(page).fill(String(entry.Calls));
      }
      if (entry.Meetings !== undefined) {
        await form.meetingsInput(page).fill(String(entry.Meetings));
      }
      if (entry.Blockers !== undefined) {
        await form.blockersInput(page).fill(String(entry.Blockers));
      }
      if (entry.Priority !== undefined) {
        await form.priorityInput(page).fill(String(entry.Priority));
      }
      if (entry.Notes !== undefined) {
        await form.notesInput(page).fill(String(entry.Notes));
      }

      const saveButton = isLastOfDay ? form.submitButton(page) : form.saveAndAddAnotherButton(page);

      // Button state alone is never proof of a real save -- a save can be
      // rejected server-side (e.g. a validation rule) while the button
      // still completes its click-cycle normally. Capturing the actual
      // save request/response is the only way to catch that.
      let dump;
      try {
        dump = await captureDuring(
          page,
          async () => {
            await saveButton.click();
            // validateSubmission() waits for the save to settle (button
            // re-enabled or form closed) before returning, so the
            // screenshot below is taken AFTER it -- capturing the real
            // end state instead of a transient "saving..." frame.
            await validateSubmission(page);
          },
          `submit-${dateForFilename}-${partnerForFilename}`
        );

        const saveRequest = dump.apiResponses.find(
          (r) => r.method !== "GET" && r.url.includes("/api/daily-log")
        );
        if (saveRequest && saveRequest.status >= 400) {
          let serverMessage = saveRequest.bodySnippet || `HTTP ${saveRequest.status}`;
          try {
            serverMessage = JSON.parse(saveRequest.bodySnippet).error || serverMessage;
          } catch {
            // bodySnippet wasn't JSON -- use it as-is.
          }
          throw new Error(`Save rejected by the server (${saveRequest.status}): ${serverMessage}`);
        }
      } catch (err) {
        await takeScreenshot(page, { name: `submit-failed-${partnerForFilename}` });
        throw err;
      }

      await takeScreenshot(page, {
        name: `post-save-${dateForFilename}-${partnerForFilename}`,
      });

      logger.info(
        `✅ Submitted entry for ${partner}${isLastOfDay ? "" : " (more to come today)"} ` +
          `-- confirmed via the save request's own response.`
      );
      return { partner, success: true, rowNumber: entry.__rowNumber };
    },
    { label: `submit entry (${partner})` }
  );
}

/**
 * Submit every entry for a single day, into a form that's already open
 * on that day (via dashboard.openDailyLog). All entries but the last use
 * "Save & Add Another Visit" to keep the form open; the last uses the
 * normal final save.
 *
 * @param {import('playwright').Page} page
 * @param {Array<Object>} entries - all rows for one date.
 * @returns {Promise<{results: Array, errors: Array}>}
 */
async function submitEntriesForDay(page, entries) {
  const results = [];
  const errors = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLastOfDay = i === entries.length - 1;
    try {
      const result = await submitEntry(page, entry, { isLastOfDay });
      results.push({ ...result, date: entry.Date });
    } catch (err) {
      logger.error(`Entry failed permanently for partner "${entry.Partner}" on ${entry.Date}`, err);
      errors.push({ partner: entry.Partner, date: entry.Date, message: err.message });
      // Don't try to continue this day's remaining entries -- the form is
      // in an unknown state after a failed submit (mid-error, possibly
      // still open, possibly not). Let index.js move on to the next date.
      break;
    }
  }

  return { results, errors };
}

module.exports = { submitEntry, submitEntriesForDay };
