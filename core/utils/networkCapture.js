// core/utils/networkCapture.js
//
// Captures real network/console/cookie evidence during a page action.
// Screenshots and logs alone can't show whether a save request actually
// succeeded server-side, what an auth-check call returned, or whether a
// client-side JS error fired silently -- this gives that evidence
// directly instead of guessing from rendered output.

const fs = require("fs");
const path = require("path");
const config = require("../config");
const logger = require("./logger");

/**
 * Run `action` while recording every response, console message, and page
 * error, then dump it all to disk (screenshots/<label>-<timestamp>.json).
 * Full headers + a truncated body are captured for the main document and
 * for any non-GET request to the site -- that's where a save/mutation
 * request's real success or failure would show up, which button-state
 * checks alone can't see.
 *
 * @param {import('playwright').Page} page
 * @param {() => Promise<void>} action - the interaction to run while capturing.
 * @param {string} label - used in the dumped filename.
 * @returns {Promise<object>} the dump that was also written to disk.
 */
async function captureDuring(page, action, label) {
  const responses = [];
  const consoleMessages = [];
  const pageErrors = [];
  const bodyPromises = [];

  const onResponse = (response) => {
    const url = response.url();
    const method = response.request().method();
    const status = response.status();
    const record = { url, status, method };
    responses.push(record);

    const isMutation = method !== "GET";
    const isMainDocument = url === config.baseURL || url === `${config.baseURL}/`;
    if ((isMutation || isMainDocument) && url.startsWith(config.baseURL)) {
      bodyPromises.push(
        (async () => {
          try {
            record.headers = await response.allHeaders();
          } catch {
            // ignore -- diagnostics only
          }
          try {
            const text = await response.text();
            record.bodySnippet = text.slice(0, 3000);
          } catch {
            // ignore -- e.g. a redirect or empty body
          }
        })()
      );
    }
  };
  const onConsole = (msg) => {
    consoleMessages.push({ type: msg.type(), text: msg.text() });
  };
  const onPageError = (err) => {
    pageErrors.push(err.message);
  };

  page.on("response", onResponse);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  try {
    await action();
  } finally {
    page.off("response", onResponse);
    page.off("console", onConsole);
    page.off("pageerror", onPageError);

    // Let any in-flight header/body reads settle before dumping.
    await Promise.allSettled(bodyPromises);

    // Everything past this point is diagnostics only -- if the page/
    // context/browser already closed, these calls would throw and mask
    // the real error. Each one degrades to null/empty instead of failing
    // the dump.
    const cookies = await page
      .context()
      .cookies()
      .catch(() => []);
    const html = await page.content().catch(() => null);

    const dump = {
      timestamp: new Date().toISOString(),
      url: (() => {
        try {
          return page.url();
        } catch {
          return null;
        }
      })(),
      cookies,
      // Only the calls to the site itself, not every static asset --
      // that's the noise, this is the signal.
      apiResponses: responses.filter((r) => r.url.startsWith(config.baseURL)),
      consoleMessages,
      pageErrors,
      htmlSnippet: html ? html.slice(0, 5000) : null,
    };

    const dumpPath = path.join(config.paths.screenshots, `${label}-${Date.now()}.json`);
    fs.writeFileSync(dumpPath, JSON.stringify(dump, null, 2));
    logger.info(`Diagnostic capture saved: ${dumpPath}`);
    return dump;
  }
}

module.exports = { captureDuring };
