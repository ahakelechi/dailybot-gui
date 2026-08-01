// server/envFile.js
//
// Small helper to update specific keys in .env without disturbing
// anything else in the file (comments, ordering, unrelated settings).
// dotenv can read .env; nothing in the dotenv package writes one, so this
// fills that one gap with a plain line-based merge.

const fs = require("fs");

const DEFAULT_TEMPLATE = `BASE_URL=https://www.account-management.mitsumi.ai
LOGIN_URL=
DASHBOARD_URL=

LOGIN_EMAIL=
LOGIN_PASSWORD=

HEADLESS=false
SLOW_MO=0

TIMEOUT_NAVIGATION=30000
TIMEOUT_ACTION=15000
TIMEOUT_OTP=90000

RETRY_ATTEMPTS=3
RETRY_DELAY_MS=3000

LOG_LEVEL=info
LOG_TO_FILE=true
LOG_TO_CONSOLE=true

SCHEDULE_CRON=0 8 * * 1-6
SCHEDULE_TZ=Africa/Lagos
SCHEDULER_AUTOSTART=false

DATA_FILE=

GEO_LATITUDE=
GEO_LONGITUDE=

MAX_EDIT_AGE_DAYS=2
`;

/**
 * Update (or add) specific KEY=value lines in a .env file, leaving
 * everything else untouched. Creates the file from a sensible default
 * template first if it doesn't exist yet.
 *
 * @param {string} envPath
 * @param {Record<string, string>} updates
 */
function updateEnvFile(envPath, updates) {
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : DEFAULT_TEMPLATE;
  const lines = content.split(/\r?\n/);
  const seen = new Set();

  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (match && Object.prototype.hasOwnProperty.call(updates, match[1])) {
      seen.add(match[1]);
      return `${match[1]}=${updates[match[1]]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      nextLines.push(`${key}=${value}`);
    }
  }

  fs.writeFileSync(envPath, nextLines.join("\n"));
}

module.exports = { updateEnvFile, DEFAULT_TEMPLATE };
