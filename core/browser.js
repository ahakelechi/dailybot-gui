// core/browser.js
//
// Very important module. Instead of `chromium.launch(...)` living inside
// login.js, dashboard.js, AND forms.js -- with three separate browsers
// fighting each other -- only THIS file creates browsers. Everyone else
// (login.js, dashboard.js, forms.js) is handed the same browser/context/page
// and reuses it. They never create another one.

const fs = require("fs");
const { chromium } = require("playwright");
const config = require("./config");
const logger = require("./utils/logger");
const { ensureDir } = require("./utils/helpers");

ensureDir(config.paths.sessions);

// Patch the JS-observable automation fingerprints a bot-detection script
// would check for. This is the account owner automating their own
// sanctioned daily task, not evading access controls -- the goal is just
// to stop a false-positive "this is a bot" flag from killing a
// legitimate session.
function stealthInitScript() {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  window.chrome = window.chrome || { runtime: {} };
  Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) =>
    parameters.name === "notifications"
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(parameters);
}

/**
 * Launch Chromium using the account owner's own real, already-signed-in
 * Chrome profile instead of a fresh blank one. Chrome must be FULLY
 * closed before this runs -- a profile directory can't be opened by two
 * processes at once.
 *
 * @returns {Promise<{browser: import('playwright').BrowserContext, context: import('playwright').BrowserContext, page: import('playwright').Page}>}
 */
async function launchWithRealProfile() {
  const { userDataDir, profileDirectory } = config.chromeProfile;
  logger.info(`Launching Chromium with real profile: ${userDataDir} (${profileDirectory})`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: config.browser.headless,
    slowMo: config.browser.slowMo,
    viewport: config.browser.viewport,
    permissions: ["geolocation"],
    geolocation: config.geolocation,
    args: [
      "--disable-blink-features=AutomationControlled",
      `--profile-directory=${profileDirectory}`,
    ],
  });

  await context.addInitScript(stealthInitScript);
  context.setDefaultNavigationTimeout(config.timeouts.navigation);
  context.setDefaultTimeout(config.timeouts.action);

  // launchPersistentContext often opens with a blank tab already present
  // (from the profile's own startup behavior) -- reuse it instead of
  // opening a second one.
  const page = context.pages()[0] || (await context.newPage());

  // A persistent context IS the browser as far as Playwright's API is
  // concerned (no separate top-level Browser object) -- returning it as
  // both `browser` and `context` keeps index.js/closeBrowser() working
  // unchanged, since BrowserContext.close() exists just like Browser.close().
  return { browser: context, context, page };
}

/**
 * Launch Chromium in a fresh, isolated profile (restoring a saved
 * DailyBot session if one exists), create a page, and hand it all back.
 * This is the default, lower-risk path -- it never touches the account
 * owner's real browser data.
 *
 * @returns {Promise<{browser: import('playwright').Browser, context: import('playwright').BrowserContext, page: import('playwright').Page}>}
 */
async function launchFreshProfile() {
  const browser = await chromium.launch({
    headless: config.browser.headless,
    slowMo: config.browser.slowMo,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const hasSavedSession = fs.existsSync(config.paths.sessionFile);

  const context = await browser.newContext({
    viewport: config.browser.viewport,
    storageState: hasSavedSession ? config.paths.sessionFile : undefined,
    // The Daily Log form has a required Location field that silently
    // blocks saving until location is granted -- granting permission here
    // means the browser never shows a permission prompt to begin with.
    permissions: ["geolocation"],
    geolocation: config.geolocation,
  });

  await context.addInitScript(stealthInitScript);

  if (hasSavedSession) {
    logger.info("Restored saved session from sessions/state.json");
  } else {
    logger.info("No saved session found -- starting fresh.");
  }

  context.setDefaultNavigationTimeout(config.timeouts.navigation);
  context.setDefaultTimeout(config.timeouts.action);

  const page = await context.newPage();

  return { browser, context, page };
}

/**
 * Launch Chromium, create a context, create a page, and hand it all back.
 * Uses the real Chrome profile if CHROME_USER_DATA_DIR is set in .env,
 * otherwise a fresh isolated profile.
 *
 * @returns {Promise<{browser: import('playwright').Browser, context: import('playwright').BrowserContext, page: import('playwright').Page}>}
 */
async function launchBrowser() {
  logger.info("Launching Chromium...");

  if (config.chromeProfile.userDataDir) {
    return launchWithRealProfile();
  }

  return launchFreshProfile();
}

/**
 * Persist the current context's cookies/localStorage to disk so future
 * runs can skip the login flow entirely.
 *
 * @param {import('playwright').BrowserContext} context
 */
async function saveSession(context) {
  await context.storageState({ path: config.paths.sessionFile });
  logger.info("Session saved to sessions/state.json");
}

/**
 * Delete any saved session, forcing the next run to log in from scratch.
 * Useful when a session has expired or become invalid.
 */
function clearSession() {
  if (fs.existsSync(config.paths.sessionFile)) {
    fs.unlinkSync(config.paths.sessionFile);
    logger.info("Cleared saved session.");
  }
}

/**
 * Close the browser cleanly. Safe to call even if browser is undefined.
 * @param {import('playwright').Browser} browser
 */
async function closeBrowser(browser) {
  if (browser) {
    try {
      await browser.close();
      logger.info("Browser closed.");
    } catch (err) {
      // Already closed/crashed (e.g. the user closed the window, or the
      // process died mid-run) -- calling close() again on a dead browser
      // can throw. This runs from index.js's `finally` block, where a
      // throw here would mask whatever the real failure was, so log and
      // move on instead.
      logger.warning(`Browser was already closed: ${err.message}`);
    }
  }
}

module.exports = { launchBrowser, saveSession, clearSession, closeBrowser };
