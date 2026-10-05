// core/utils/overlays.js
//
// The site sometimes throws a full-screen popup over whatever page is open
// -- today, a "Changelog" dialog announcing a new app version. It swallows
// every click, so any step behind it just hangs until its timeout. Nothing
// here is specific to one page: it is installed once per browser page and
// quietly closes the popup whenever it shows up.
//
// Two mechanisms, because each covers a gap in the other:
//   - installOverlayHandlers(): Playwright runs the handler automatically
//     right before any click/fill/etc. whenever the popup is on screen, so a
//     popup that appears late (or mid-run) never gets in the way.
//   - dismissOverlays(): an explicit check at a known-quiet moment (right
//     after a page opens) so the dismissal is logged clearly and happens
//     before anything is touched.

const config = require("../config");
const logger = require("./logger");
const { waitVisible } = require("./helpers");

/**
 * Close the changelog popup if it is currently showing.
 * @param {import('playwright').Locator} overlay
 */
async function closeChangelog(overlay) {
  logger.info("A Changelog popup is covering the page -- closing it...");
  await config.selectors.overlays.changelogClose(overlay).click({ timeout: 5000 });
  await overlay.waitFor({ state: "hidden", timeout: 5000 });
}

/**
 * Register an automatic handler on a page so the changelog popup is closed
 * the moment it blocks an action.
 *
 * @param {import('playwright').Page} page
 */
async function installOverlayHandlers(page) {
  const changelog = config.selectors.overlays.changelog(page);
  await page.addLocatorHandler(changelog, async (overlay) => {
    await closeChangelog(overlay);
  });
}

/**
 * Close the changelog popup if it shows up within `timeout` ms. Safe to call
 * any time; does nothing (quickly) when there's no popup.
 *
 * @param {import('playwright').Page} page
 * @param {number} [timeout]
 * @returns {Promise<boolean>} true if a popup was found and closed.
 */
async function dismissOverlays(page, timeout = 2500) {
  const overlay = config.selectors.overlays.changelog(page);
  const shown = await waitVisible(overlay, timeout);
  if (!shown) return false;

  try {
    await closeChangelog(overlay);
    return true;
  } catch (err) {
    // Not fatal here: the action-time handler gets another chance, and if
    // the popup genuinely can't be closed the failing step's own screenshot
    // will show exactly what is in the way.
    logger.warning(`Could not close the Changelog popup: ${err.message}`);
    return false;
  }
}

module.exports = { installOverlayHandlers, dismissOverlays };
