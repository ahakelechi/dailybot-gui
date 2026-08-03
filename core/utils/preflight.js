// core/utils/preflight.js
//
// Checked only before a SCHEDULED (unattended) run fires -- a manual
// Run Now has a human right there to watch it fail and react, but a
// scheduled run has nobody. Rather than silently burning a run attempt
// on a browser binary that's missing or a session that's already dead
// (both guaranteed failures, not maybes), catch them first and skip
// with a clear reason instead.

const fs = require("fs");
const { getSessionExpiry } = require("./sessionInfo");

function isChromiumInstalled() {
  const { chromium } = require("playwright");
  try {
    return fs.existsSync(chromium.executablePath());
  } catch (err) {
    return false;
  }
}

/**
 * @returns {Array<{reason: string, message: string}>} empty if clear to run
 */
function preflightForScheduledRun() {
  const issues = [];

  if (!isChromiumInstalled()) {
    issues.push({
      reason: "chromium-missing",
      message:
        "Browser engine (Chromium) isn't installed, so this run couldn't start. " +
        "Run \"npx playwright install\" in the DailyBot-GUI folder, or double-click Setup.bat again.",
    });
  }

  const session = getSessionExpiry();
  if (!session.exists || session.expired) {
    issues.push({
      reason: "session-expired",
      message:
        "The saved login session has expired, so this run needs the login code -- " +
        "which nobody was here to type in. Click Run Now when you're at the computer to sign in again.",
    });
  }

  return issues;
}

module.exports = { isChromiumInstalled, preflightForScheduledRun };
