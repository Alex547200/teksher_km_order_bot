const path = require("node:path");
const { chromium } = require("playwright");

const BASE_URL = "https://label.teksher.kg";
const OPERATIONS_URL = `${BASE_URL}/operations`;
const PROFILE_DIR = path.resolve(__dirname, "teksher-session-profile");
const PLAYWRIGHT_HOME = path.join(__dirname, ".playwright-home");
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT = 30000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProfileLogin(page) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < LOGIN_TIMEOUT_MS) {
    const url = page.url();
    const inSignIn = url.includes("/sign-in") || url.includes("/login");
    const hasOperationsText = await page.locator("text=Операции").first().isVisible().catch(() => false);

    if (!inSignIn && hasOperationsText) {
      return {
        url,
        hasOperationsText,
      };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`LOGIN_TIMEOUT: не дождался ручного логина за ${Math.round(LOGIN_TIMEOUT_MS / 60000)} минут`);
}

async function main() {
  await require("node:fs/promises").mkdir(PLAYWRIGHT_HOME, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    acceptDownloads: false,
    viewport: { width: 1440, height: 1200 },
    env: {
      ...process.env,
      HOME: PLAYWRIGHT_HOME,
    },
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    await page.waitForLoadState("networkidle", { timeout: DEFAULT_TIMEOUT }).catch(() => {});

    await waitForProfileLogin(page);
    console.log("PROFILE_LOGIN_SUCCESS");
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
