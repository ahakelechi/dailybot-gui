// core/utils/sessionInfo.js
//
// Reads the actual expiry timestamp baked into the saved session, instead
// of guessing from how often OTP prompts happen to occur. Playwright's
// storageState() (sessions/state.json) records every cookie the portal
// set, including its own "expires" field (a Unix timestamp assigned by
// the site's server) -- that's authoritative, not an estimate.

const fs = require("fs");
const config = require("../config");

/**
 * @returns {{ exists: boolean, cookieName: string|null, expiresAt: string|null, expired: boolean|null }}
 */
function getSessionExpiry() {
  if (!fs.existsSync(config.paths.sessionFile)) {
    return { exists: false, cookieName: null, expiresAt: null, expired: null };
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(config.paths.sessionFile, "utf8"));
  } catch (err) {
    return { exists: true, cookieName: null, expiresAt: null, expired: null };
  }

  const cookies = state.cookies || [];

  // The portal's auth cookie is named "sales_app_session" as of the
  // current site build. If that ever changes, fall back to whichever
  // cookie on this domain has the furthest-out fixed expiry -- session
  // cookies (expires === -1, meaning "until the browser closes") aren't
  // useful here since they carry no real deadline to report.
  const onThisDomain = cookies.filter((c) => (c.domain || "").includes("mitsumi.ai") && c.expires > 0);
  const named = onThisDomain.find((c) => c.name === "sales_app_session");
  const best = named || onThisDomain.sort((a, b) => b.expires - a.expires)[0];

  if (!best) {
    return { exists: true, cookieName: null, expiresAt: null, expired: null };
  }

  const expiresAt = new Date(best.expires * 1000);
  return {
    exists: true,
    cookieName: best.name,
    expiresAt: expiresAt.toISOString(),
    expired: expiresAt.getTime() < Date.now(),
  };
}

module.exports = { getSessionExpiry };
