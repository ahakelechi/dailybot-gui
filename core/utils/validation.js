// core/utils/validation.js
//
// Very underrated module. After submitting a form, how do you actually
// know it worked? A page not crashing isn't proof of success. This module
// checks for real evidence -- and forms.js additionally checks the actual
// save network response (see networkCapture.js), since button state alone
// can miss a server-side rejection.

const config = require("../config");
const logger = require("./logger");
const { sleep } = require("./helpers");

/**
 * Poll a locator until it's no longer disabled (the save request actually
 * finished), or until it disappears from the DOM entirely (the form/dialog
 * closed, which is an even stronger sign the save completed). Unlike a
 * single isDisabled() check, this genuinely waits -- isDisabled() is a
 * snapshot, not a wait, so checking it once right after a click almost
 * always catches the button still mid-save.
 *
 * @param {import('playwright').Locator} locator
 * @param {number} timeout
 * @returns {Promise<boolean>}
 */
async function waitForSaveToSettle(locator, timeout) {
  const start = Date.now();
  const pollInterval = 150;

  while (Date.now() - start < timeout) {
    let disabled;
    try {
      disabled = await locator.isDisabled();
    } catch (err) {
      // Locator no longer resolves to anything -- the form/dialog closed.
      return true;
    }
    if (!disabled) return true;
    await sleep(pollInterval);
  }

  return false;
}

/**
 * Confirm a form submission actually settled (button re-enabled or form
 * closed). This alone does NOT prove the save was accepted server-side --
 * forms.js separately checks the actual save response for that.
 *
 * @param {import('playwright').Page} page
 * @param {Object} [options]
 * @param {(page: import('playwright').Page) => import('playwright').Locator} [options.successLocator]
 * @param {number} [options.timeout] - how long to wait for evidence of success.
 * @throws {Error} if no evidence of success appears before the timeout.
 */
async function validateSubmission(page, options = {}) {
  const successLocatorFn = options.successLocator || config.selectors.form.successMessage;
  const timeout = options.timeout || config.timeouts.action;

  if (successLocatorFn) {
    try {
      await successLocatorFn(page).waitFor({ state: "visible", timeout });
      logger.info("Submission validated: success message found.");
      return true;
    } catch (err) {
      throw new Error(`Validation failed: no success indicator appeared within ${timeout}ms.`);
    }
  }

  try {
    await config.selectors.form.submitButton(page).waitFor({ state: "attached", timeout });
    const settled = await waitForSaveToSettle(config.selectors.form.submitButton(page), timeout);
    if (!settled) {
      throw new Error("save button was still disabled (still saving) when the timeout ran out");
    }
    return true;
  } catch (err) {
    throw new Error(`Validation failed: save button unresponsive after submit (${err.message}).`);
  }
}

/**
 * Confirm the browser is actually logged in (as opposed to sitting on
 * a login form). Used by index.js right after restoring a saved session,
 * and by login.js right after submitting credentials.
 *
 * @param {import('playwright').Page} page
 * @param {Object} [options]
 * @param {(page: import('playwright').Page) => import('playwright').Locator} [options.markerLocator]
 * @param {number} [options.timeout]
 * @returns {Promise<boolean>}
 */
async function isLoggedIn(page, options = {}) {
  const markerLocatorFn = options.markerLocator || config.selectors.login.loggedInMarker;
  const timeout = options.timeout || config.timeouts.action;

  try {
    await markerLocatorFn(page).waitFor({ state: "visible", timeout });
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = { validateSubmission, isLoggedIn };
