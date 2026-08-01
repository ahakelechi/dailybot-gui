// core/config.js
//
// The "Settings Menu" for DailyBot.
//
// Nothing else in this project should hard-code a URL, a CSS selector,
// a timeout, or a file path. Every other module asks config.js for the
// answer. That way, when the target site changes (or a workflow needs
// tweaking), you edit ONE file instead of hunting through five.
//
// Values are pulled from .env first so secrets and environment-specific
// settings never get hard-coded or committed to source control. Sensible
// defaults are provided everywhere else.

require("dotenv").config();
const path = require("path");

// This file lives in core/, but data/sessions/logs/reports/screenshots
// belong at the project root (sibling to core/, server/, public/) so the
// GUI server and the automation engine agree on where everything lives.
const ROOT = path.join(__dirname, "..");

const BASE_URL = process.env.BASE_URL || "https://www.account-management.mitsumi.ai";

const config = {
  // ---------------------------------------------------------------------
  // Site URLs
  // ---------------------------------------------------------------------
  baseURL: BASE_URL,
  urls: {
    // The site is a single-page app: there is no separate /login or
    // /dashboard route. Logged-out, the root shows a "Sign In" link;
    // logged-in, it shows the dashboard ("Log My Day") directly. So both
    // "URLs" are just the root -- kept as two config keys (rather than one)
    // in case that ever changes.
    login: process.env.LOGIN_URL || BASE_URL,
    dashboard: process.env.DASHBOARD_URL || BASE_URL,
  },

  // ---------------------------------------------------------------------
  // Credentials (never hard-code these -- .env only, and .env is gitignored)
  // ---------------------------------------------------------------------
  credentials: {
    email: process.env.LOGIN_EMAIL || "",
    password: process.env.LOGIN_PASSWORD || "",
  },

  // ---------------------------------------------------------------------
  // Locators for the target site (account-management.mitsumi.ai),
  // confirmed against real captured HTML and live runs. Each entry is a
  // function that takes the current `page` and returns a Locator --
  // that's what lets login.js/dashboard.js/forms.js stay selector-agnostic:
  // they call config.selectors.x.y(page), never build their own locator.
  // ---------------------------------------------------------------------
  selectors: {
    login: {
      signInLink: (page) => page.getByRole("link", { name: "Sign In" }),
      emailInput: (page) => page.getByRole("textbox", { name: "Email" }),
      passwordInput: (page) => page.getByRole("textbox", { name: "Password" }),
      submitButton: (page) => page.getByRole("button", { name: "Login" }),
      // The site uses 6 separate single-digit OTP boxes, not one field.
      otpDigitCount: 6,
      otpDigit: (page, index) => page.getByTestId(`login-otp-digit-${index}`),
      // Different account roles show different sidebar labels for the same
      // feature -- e.g. "Log My Day" (some roles) vs "Daily Log" (others) --
      // so this has to match either, same as dashboard.dailyLogLink below.
      loggedInMarker: (page) => page.getByRole("link", { name: /^(Log My Day|Daily Log)$/ }),
    },
    dashboard: {
      // Confirmed via screenshots from real runs: the sidebar nav item
      // once you're anywhere inside the app is labelled "Daily Log", not
      // "Log My Day" -- "Log My Day" only ever showed up on the very
      // first post-login landing page, never again afterward. A single
      // regex-based name match finds whichever label the page is
      // actually showing.
      dailyLogLink: (page) => page.getByRole("link", { name: /^(Log My Day|Daily Log)$/ }),
      // CONFIRMED via error inspection (a strict-mode-violation dump
      // showed the real DOM): each calendar day cell is
      // <button title="YYYY-MM-DD · N entries">DD</button>. Matching on
      // the full ISO date via the title attribute is unambiguous.
      dayButton: (page, isoDate) => page.locator(`button[title^="${isoDate}"]`),
      calendarPrevMonthButton: (page) =>
        page.getByRole("button", { name: /previous month/i }),
      calendarNextMonthButton: (page) => page.getByRole("button", { name: /next month/i }),
      // Text like "July 2026" somewhere in the picker header, used to
      // check which month is currently showing before deciding whether
      // to click prev/next.
      calendarMonthLabel: (page) => page.getByText(/^[A-Z][a-z]+ \d{4}$/),
      // Presence of the partner combobox = the daily-log form is open.
      pageMarker: (page) => page.getByTestId("partner-combobox-trigger"),
    },
    form: {
      // Some daily-log forms show an "Enable location" prompt/button that
      // blocks saving until clicked -- observed specifically on
      // backfilled (non-today) dates. Granting geolocation permission at
      // the browser-context level (see browser.js) should mean this
      // button never even appears, but forms.js still checks/clicks it as
      // a belt-and-suspenders fallback in case the site requires an
      // explicit click regardless of permission state.
      enableLocationButton: (page) =>
        page.getByRole("button", { name: /enable location/i }),
      // Seen in a real failed run: after clicking "Enable location", the
      // button's own accessible name changes to "Locating..." while the
      // coordinates/address are being resolved -- a DIFFERENT name than
      // "Enable location", which is why waiting for the "Enable location"
      // button to become hidden was a false-positive success signal (it
      // "disappears" the instant its label changes, whether or not the
      // location capture actually finished). Used to wait out the real
      // loading state instead.
      locatingIndicator: (page) => page.getByRole("button", { name: /locating/i }),
      partnerTrigger: (page) => page.getByTestId("partner-combobox-trigger"),
      // Once opened, the combobox is a search field ("Search & select a
      // partner..."), not a static list -- typing into it filters the
      // options. This makes selection resilient to case/whitespace
      // differences instead of requiring a byte-exact match.
      partnerSearchInput: (page) => page.getByPlaceholder(/search.*select.*partner/i),
      // CONFIRMED via DevTools inspection: each option is a <button
      // data-testid="partner-combobox-option-<uuid>"> -- there's no
      // role="option" (it's a plain button, so getByRole('option', ...)
      // never matched anything, hence the timeouts). The uuid is
      // per-partner and unknown ahead of time, so we match on the stable
      // testid prefix instead, filtered by visible text. Text match is
      // substring + case-insensitive (Playwright's `hasText` behavior),
      // which also handles the on-screen "Vendor: VMware" prefix the site
      // adds -- "VMware" alone still matches.
      partnerOption: (page, partnerName) =>
        page.locator('[data-testid^="partner-combobox-option-"]').filter({ hasText: partnerName }),
      callsInput: (page) => page.getByRole("textbox", { name: "Calls Made" }),
      meetingsInput: (page) => page.getByRole("textbox", { name: "Meetings Held" }),
      blockersInput: (page) => page.getByRole("textbox", { name: "Blockers" }),
      priorityInput: (page) => page.getByRole("textbox", { name: "Top 3 Priorities for Tomorrow" }),
      notesInput: (page) => page.getByRole("textbox", { name: "Meeting Notes" }),
      // Confirmed working: the final save for a day's entries.
      submitButton: (page) => page.getByTestId("daily-log-save-btn"),
      // CONFIRMED via a real HTML capture of the site: data-testid=
      // "daily-log-save-add-btn". Used for every entry in a day except
      // the last, so the form stays open for the next visit instead of
      // closing.
      saveAndAddAnotherButton: (page) => page.getByTestId("daily-log-save-add-btn"),
      // No real success toast/message confirmed yet -- validation.js
      // falls back to checking the actual save network response instead
      // (see forms.js), which is the real source of truth.
      successMessage: null,
    },
  },

  // ---------------------------------------------------------------------
  // Filesystem paths -- every module asks here instead of building its own
  // ---------------------------------------------------------------------
  paths: {
    root: ROOT,
    sessions: path.join(ROOT, "sessions"),
    sessionFile: path.join(ROOT, "sessions", "state.json"),
    data: path.join(ROOT, "data"),
    dataFile: process.env.DATA_FILE || path.join(ROOT, "data", "dailyLog.xlsx"),
    logs: path.join(ROOT, "logs"),
    reports: path.join(ROOT, "reports"),
    screenshots: path.join(ROOT, "screenshots"),
  },

  // ---------------------------------------------------------------------
  // Browser settings
  // ---------------------------------------------------------------------
  browser: {
    headless: process.env.HEADLESS ? process.env.HEADLESS === "true" : false,
    slowMo: Number(process.env.SLOW_MO || 0),
    viewport: { width: 1440, height: 900 },
  },

  // ---------------------------------------------------------------------
  // Geolocation -- the Daily Log form has a required "Location" field that
  // silently blocks saving until it's granted/enabled. Granting permission
  // at the browser-context level means there's no permission prompt to
  // get stuck behind at all. Defaults to Lagos -- override in .env if
  // entries are logged from elsewhere.
  // ---------------------------------------------------------------------
  geolocation: {
    latitude: Number(process.env.GEO_LATITUDE || 6.5244),
    longitude: Number(process.env.GEO_LONGITUDE || 3.3792),
  },

  // ---------------------------------------------------------------------
  // Real Chrome profile (optional) -- an alternative to the default
  // fresh, isolated automation profile. Set CHROME_USER_DATA_DIR to opt
  // in. Chrome must be FULLY closed first: a profile can't be open in two
  // processes at once.
  // ---------------------------------------------------------------------
  chromeProfile: {
    userDataDir: process.env.CHROME_USER_DATA_DIR || "",
    profileDirectory: process.env.CHROME_PROFILE_DIRECTORY || "Default",
  },

  // ---------------------------------------------------------------------
  // CONFIRMED live via captured network response: POST /api/daily-logs
  // returns 400 "Editing logs older than 2 days is disabled." for any
  // date past this window -- a real, intentional site rule, not a bug.
  // index.js checks this upfront so it can skip a too-old date instantly
  // with a clear message, instead of burning a full form-fill-and-retry
  // cycle on something that can never succeed.
  // ---------------------------------------------------------------------
  maxEditAgeDays: Number(process.env.MAX_EDIT_AGE_DAYS || 2),

  // ---------------------------------------------------------------------
  // Timeouts (ms)
  // ---------------------------------------------------------------------
  timeouts: {
    // Floor of 20s -- this is an SPA; a full reload + client-side
    // re-hydration of auth state genuinely needs more than a few
    // seconds.
    navigation: Math.max(Number(process.env.TIMEOUT_NAVIGATION || 30000), 20000),
    action: Number(process.env.TIMEOUT_ACTION || 15000),
    // Hard floor of 45s regardless of .env -- too short a window costs a
    // full login+entry retry every time a human needs a moment to read
    // and type a 6-digit code.
    otpWait: Math.max(Number(process.env.TIMEOUT_OTP || 90000), 45000),
  },

  // ---------------------------------------------------------------------
  // Retry settings -- how forms.js and login.js recover from flaky steps
  // ---------------------------------------------------------------------
  retry: {
    attempts: Number(process.env.RETRY_ATTEMPTS || 3),
    // Capped at 15s -- retries should be quick, never something a human
    // would mistake for a hung/crashed window.
    delayMs: Math.min(Number(process.env.RETRY_DELAY_MS || 3000), 15000),
  },

  // ---------------------------------------------------------------------
  // Logging settings
  // ---------------------------------------------------------------------
  logging: {
    level: process.env.LOG_LEVEL || "info",
    toFile: process.env.LOG_TO_FILE !== "false",
    toConsole: process.env.LOG_TO_CONSOLE !== "false",
  },

  // ---------------------------------------------------------------------
  // Scheduler settings
  // ---------------------------------------------------------------------
  schedule: {
    // Default: 08:00, Monday-Saturday
    cron: process.env.SCHEDULE_CRON || "0 8 * * 1-6",
    timezone: process.env.SCHEDULE_TZ || "Africa/Lagos",
    autoStart: process.env.SCHEDULER_AUTOSTART === "true",
  },
};

module.exports = config;
