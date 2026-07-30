// core/utils/screenshots.js
//
// Every module can request "take a screenshot" -- login.js when auth
// fails, forms.js when validation fails, index.js on a crash. But only
// THIS file knows where screenshots go, how they're named, and how
// they're compressed.

const path = require("path");
const config = require("../config");
const logger = require("./logger");
const { ensureDir, formatDate } = require("./helpers");

ensureDir(config.paths.screenshots);

/**
 * Capture a screenshot of the current page.
 *
 * @param {import('playwright').Page} page
 * @param {Object} [options]
 * @param {string} [options.name] - short label describing the moment (e.g. "login-failed").
 * @param {boolean} [options.fullPage] - capture the full scrollable page, not just the viewport.
 * @returns {Promise<string>} absolute path to the saved screenshot, or null if it failed.
 */
async function takeScreenshot(page, options = {}) {
  const name = options.name || "screenshot";
  const fullPage = options.fullPage !== false;

  const filename = `${formatDate()}_${name}.jpg`;
  const filePath = path.join(config.paths.screenshots, filename);

  try {
    await page.screenshot({
      path: filePath,
      fullPage,
      type: "jpeg",
      quality: 70, // compression -- keeps daily screenshot folders small
    });
    logger.info(`Screenshot saved: ${filename}`);
    return filePath;
  } catch (err) {
    logger.error(`Failed to capture screenshot (${name})`, err);
    return null;
  }
}

module.exports = { takeScreenshot };
