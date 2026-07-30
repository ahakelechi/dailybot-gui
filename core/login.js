// core/login.js
//
// This module has ONE responsibility: authentication. It does NOT click
// "Daily Log" -- that belongs to dashboard.js. It goes to the login page,
// enters credentials, waits out the OTP, verifies the login worked, saves
// the session, and hands back the page. That's it.

const config = require("./config");
const logger = require("./utils/logger");
const { saveSession } = require("./browser");
const { isLoggedIn } = require("./utils/validation");
const { takeScreenshot } = require("./utils/screenshots");
const { withRetry } = require("./utils/retry");
const { sleep, waitVisible } = require("./utils/helpers");

/**
 * Check whether the current page/session is already authenticated,
 * without going through the login form. Used by index.js right after
 * restoring a saved session so a valid session can skip login entirely.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function isSessionValid(page) {
  try {
    // "domcontentloaded" only means the raw HTML parsed -- it says
    // nothing about whether this SPA has finished its own client-side
    // check of whether the restored session is actually valid (which for
    // a Next.js app like this typically needs an async API round-trip
    // after load). Checking for the logged-in marker too soon after that
    // races against the app still deciding, and reads as "logged out"
    // even when the saved session is genuinely still good. "networkidle"
    // plus a generous marker timeout gives the app time to actually
    // decide before we judge it.
    await page.goto(config.urls.dashboard, { waitUntil: "networkidle" });
  } catch (err) {
    logger.warning(`Could not reach dashboard while checking session: ${err.message}`);
    return false;
  }

  const valid = await isLoggedIn(page, { timeout: config.timeouts.navigation });
  logger.info(`Session check: ${valid ? "valid" : "invalid/expired"}`);
  return valid;
}

/**
 * Click the "Sign In" link that gates the login form on the landing page,
 * if it's present. If a session partially exists or the site's already
 * showing the form, this is a harmless no-op.
 *
 * @param {import('playwright').Page} page
 */
async function openSignInForm(page) {
  const signInLink = config.selectors.login.signInLink(page);
  const visible = await waitVisible(signInLink, 8000);
  if (visible) {
    await signInLink.click();
  } else {
    logger.info("\"Sign In\" link not seen -- assuming the login form is already showing.");
  }
}

/**
 * Wait for the user to enter a one-time password (OTP) sent to their
 * phone/email/authenticator app. DailyBot cannot generate or intercept
 * OTPs itself -- it simply pauses until one is typed into the site,
 * then proceeds once the OTP field is submitted or the dashboard loads.
 *
 * @param {import('playwright').Page} page
 */
async function handleOtpIfPresent(page) {
  // The site renders 6 separate single-digit boxes (login-otp-digit-0..5)
  // rather than one field. We only need to detect the first one to know
  // an OTP step is being asked for -- DailyBot can't read the code itself
  // (it's sent to the person's phone/email), so it just waits for a human
  // to type all 6 digits in.
  const firstDigit = config.selectors.login.otpDigit(page, 0);

  const otpStepVisible = await waitVisible(firstDigit, 8000);

  if (!otpStepVisible) {
    logger.info("No OTP step detected -- continuing.");
    return;
  }

  logger.info(
    `OTP step detected (${config.selectors.login.otpDigitCount} digit boxes). ` +
      `Waiting up to ${config.timeouts.otpWait / 1000}s for it to be completed...`
  );

  // Give a human time to read the OTP from their phone/email and type it
  // in (DailyBot runs non-headless for exactly this reason). We consider
  // the OTP step done once the logged-in marker appears.
  await config.selectors.login
    .loggedInMarker(page)
    .waitFor({ state: "visible", timeout: config.timeouts.otpWait })
    .catch(() => {
      logger.warning("Logged-in marker did not appear after OTP wait window.");
    });
}

/**
 * Navigate to the login page and submit credentials. This is the only
 * part of the login flow that's safe to retry by reloading -- it's pure
 * automation with no human-paced step in it.
 *
 * @param {import('playwright').Page} page
 * @param {number} attempt
 */
async function submitCredentials(page, attempt) {
  logger.info(`Login attempt ${attempt}: navigating to login page...`);
  await page.goto(config.urls.login, { waitUntil: "domcontentloaded" });
  await openSignInForm(page);

  await config.selectors.login.emailInput(page).fill(config.credentials.email);
  await config.selectors.login.passwordInput(page).fill(config.credentials.password);
  await config.selectors.login.submitButton(page).click();
}

/**
 * Run the full login flow: navigate, enter email, enter password, OTP,
 * verify, save session.
 *
 * Only `submitCredentials` (navigate + fill + submit) is wrapped in a
 * retry loop -- that's pure automation and safe to redo from scratch.
 * The OTP wait is deliberately run exactly once, outside any retry, with
 * its full timeout budget: it depends on a human reading a code off
 * their phone/email and typing it in, and reloading the page mid-typing
 * would wipe out whatever they'd already entered.
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<import('playwright').Page>}
 */
async function login(page, context) {
  if (!config.credentials.email || !config.credentials.password) {
    throw new Error(
      "Missing LOGIN_EMAIL or LOGIN_PASSWORD in .env -- cannot log in."
    );
  }

  await withRetry(
    async (attempt) => submitCredentials(page, attempt),
    { label: "submit login credentials" }
  );

  await sleep(1000); // give the OTP screen a moment to render, if any
  await handleOtpIfPresent(page);

  const success = await isLoggedIn(page, { timeout: 5000 });
  if (!success) {
    await takeScreenshot(page, { name: "login-failed" });
    throw new Error(
      "Login did not reach the dashboard after the OTP wait window " +
        `(${config.timeouts.otpWait / 1000}s). If you need more time to enter the code, ` +
        "raise TIMEOUT_OTP in .env."
    );
  }

  logger.info("✅ Login successful.");

  // The "logged in" marker (a sidebar link) can render before the SPA has
  // actually finished establishing a durable session client-side. A hard
  // reload triggered too soon after this -- which dashboard.js's
  // openDailyLog() will do if the sidebar link isn't immediately visible
  // on the very first check -- can land before that finishes, landing
  // back on the login page. A short settle pause first reduces that risk.
  await sleep(2000);
  await saveSession(context);

  return page;
}

module.exports = { login, isSessionValid };
