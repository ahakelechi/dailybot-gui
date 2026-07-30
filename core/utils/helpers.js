// core/utils/helpers.js
//
// Small functions used everywhere. Instead of writing sleep(), formatDate(),
// wait(), and random() 20 times across login.js, dashboard.js, forms.js,
// and reports.js -- write them once, here.

const fs = require("fs");

/**
 * Pause execution for a given number of milliseconds.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Alias -- some callers read better as "wait" than "sleep".
const wait = sleep;

/**
 * Format a Date object as YYYY-MM-DD_HH-mm-ss (filesystem-safe, sortable).
 * @param {Date} [date]
 */
function formatDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/**
 * Plain YYYY-MM-DD, no time component. Used for comparing/grouping
 * calendar dates (e.g. dataReader.js's Date column), as opposed to
 * formatDate() above which is for unique timestamped filenames.
 */
function formatDateOnly(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Format a Date as a human-readable timestamp for logs/reports.
 * @param {Date} [date]
 */
function formatDisplayDate(date = new Date()) {
  return date.toLocaleString("en-GB", { hour12: false });
}

/**
 * Random integer between min and max (inclusive). Useful for jittering
 * delays so automated actions don't look perfectly robotic.
 */
function random(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Wait up to `timeout` ms for a locator to become visible, returning
 * true/false instead of throwing.
 *
 * @param {import('playwright').Locator} locator
 * @param {number} timeout
 * @returns {Promise<boolean>}
 */
async function waitVisible(locator, timeout) {
  try {
    await locator.waitFor({ state: "visible", timeout });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Ensure a directory exists, creating it (and parents) if necessary.
 * @param {string} dirPath
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

module.exports = {
  sleep,
  wait,
  formatDate,
  formatDateOnly,
  formatDisplayDate,
  random,
  ensureDir,
  waitVisible,
};
