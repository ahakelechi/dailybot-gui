// core/utils/retry.js
//
// Suppose the internet disconnects for a second while forms.js is
// submitting the daily log. Without retry logic, that's an immediate
// failure. With it, DailyBot tries, fails, waits, tries again, and only
// gives up after exhausting its attempts.

const logger = require("./logger");
const { sleep } = require("./helpers");
const defaultConfig = require("../config").retry;

/**
 * Run an async function, retrying on failure.
 *
 * @param {Function} fn - async function to run. Receives the attempt number (1-indexed).
 * @param {Object} [options]
 * @param {number} [options.attempts] - total attempts before giving up.
 * @param {number} [options.delayMs] - delay between attempts.
 * @param {string} [options.label] - human-readable name for log messages.
 * @returns {Promise<*>} the return value of fn() once it succeeds.
 */
async function withRetry(fn, options = {}) {
  const attempts = options.attempts || defaultConfig.attempts;
  const delayMs = options.delayMs || defaultConfig.delayMs;
  const label = options.label || "operation";

  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      logger.warning(
        `${label} failed on attempt ${attempt}/${attempts}: ${err.message}`
      );

      if (attempt < attempts) {
        await sleep(delayMs);
      }
    }
  }

  logger.error(`${label} failed after ${attempts} attempts`, lastError);
  throw lastError;
}

module.exports = { withRetry };
