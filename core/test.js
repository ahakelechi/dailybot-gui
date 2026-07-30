// core/test.js
//
// Standalone sandbox smoke test -- confirms Playwright + Chromium actually
// work in this environment before trying to debug anything in the real
// DailyBot flow.

const { chromium } = require("playwright");

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();

    await page.goto("https://google.com");
    await page.waitForTimeout(3000);

    console.log("Title:", await page.title());
    console.log("✅ Playwright + Chromium are working.");
  } catch (err) {
    console.error("❌ Sandbox test failed:", err.message);
    if (err.message.includes("Executable doesn't exist")) {
      console.error(
        'Chromium isn\'t installed yet. Run: npx playwright install chromium'
      );
    }
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
})();
