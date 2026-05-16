const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const PROJECT_DIR = __dirname;
const OPERATIONS_URL = "https://label.teksher.kg/operations";
const LOGIN_URL = "https://label.teksher.kg/login";
const SESSION_PROFILE_DIR = path.join(PROJECT_DIR, "teksher-session-profile");
const TMP_DIR = path.join(PROJECT_DIR, "tmp");
const DEBUG_DIR = path.join(PROJECT_DIR, "debug", "debug-date-filter");
const DEFAULT_TIMEOUT = 30000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilePart(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function extractControls(page) {
  return page
    .locator("button,input,select,option,textarea,a,[role='button'],[role='option'],[role='menuitem'],[role='combobox']")
    .evaluateAll((els) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
      };
      return els.filter(visible).map((el, index) => ({
        index,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        role: el.getAttribute("role") || "",
        text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
        value: el.tagName.toLowerCase() === "input" ? el.value || "" : "",
        placeholder: el.getAttribute("placeholder") || "",
        name: el.getAttribute("name") || "",
        id: el.id || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        title: el.getAttribute("title") || "",
      }));
    });
}

async function saveArtifacts(page, step) {
  await ensureDir(DEBUG_DIR);
  const stamp = `${Date.now()}_${sanitizeFilePart(step)}`;
  const screenshotPath = path.join(DEBUG_DIR, `${stamp}.png`);
  const htmlPath = path.join(DEBUG_DIR, `${stamp}.html`);
  const controlsPath = path.join(DEBUG_DIR, `${stamp}.controls.json`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  await fs.writeFile(htmlPath, await page.content(), "utf8").catch(() => {});
  const controls = await extractControls(page).catch(() => []);
  await fs.writeFile(controlsPath, `${JSON.stringify(controls, null, 2)}\n`, "utf8").catch(() => {});
  console.log(`screenshot: ${screenshotPath}`);
  console.log(`html: ${htmlPath}`);
  console.log(`controls: ${controlsPath}`);
  console.table(controls);
  return { screenshotPath, htmlPath, controlsPath, controls };
}

async function clickVisible(locator) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) {
      await item.click({ timeout: DEFAULT_TIMEOUT });
      return true;
    }
  }
  return false;
}

async function clickText(page, text) {
  const locators = [
    page.getByRole("button", { name: text, exact: false }),
    page.getByRole("link", { name: text, exact: false }),
    page.getByText(text, { exact: false }),
    page.locator(`button:has-text("${text}")`),
    page.locator(`a:has-text("${text}")`),
    page.locator(`[role='button']:has-text("${text}")`),
  ];
  for (const locator of locators) {
    if (await clickVisible(locator)) return true;
  }
  return false;
}

async function clickInVisibleDrawer(page, text, force = false) {
  const drawer = page.locator("div[class*='_wrapper_'][class*='_visible_']").last();
  const locators = [
    drawer.getByText(text, { exact: false }),
    drawer.getByRole("button", { name: text, exact: false }),
    drawer.locator(`button:has-text("${text}")`),
    drawer.locator(`a:has-text("${text}")`),
    drawer.locator(`div:has-text("${text}")`),
  ];

  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      const visible = await item.isVisible().catch(() => false);
      if (!visible) continue;
      await item.click({ timeout: DEFAULT_TIMEOUT, force }).catch(async () => {
        if (!force) {
          await item.click({ timeout: DEFAULT_TIMEOUT, force: true });
        } else {
          throw new Error(`Could not click ${text} in visible drawer`);
        }
      });
      return true;
    }
  }

  return false;
}

async function waitForAuthorized(page) {
  const ok = await page
    .waitForURL(
      (url) => {
        try {
          const parsed = new URL(String(url));
          return parsed.pathname.includes("/operations") && !parsed.pathname.includes("/login") && !parsed.pathname.includes("/sign-in");
        } catch {
          return false;
        }
      },
      { timeout: LOGIN_TIMEOUT_MS },
    )
    .then(() => true)
    .catch(() => false);
  if (!ok) throw new Error("LOGIN_REQUIRED");
}

async function main() {
  await ensureDir(DEBUG_DIR);
  await ensureDir(TMP_DIR);

  const context = await chromium.launchPersistentContext(SESSION_PROFILE_DIR, {
    headless: false,
    acceptDownloads: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1200 },
    env: {
      ...process.env,
      CHROME_CONFIG_HOME: TMP_DIR,
      XDG_CACHE_HOME: TMP_DIR,
      XDG_CONFIG_HOME: TMP_DIR,
      TMPDIR: TMP_DIR,
    },
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-popup-blocking",
      "--disable-crash-reporter",
      "--disable-crashpad",
      "--disable-breakpad",
      "--host-resolver-rules=MAP label.teksher.kg 109.71.231.11",
    ],
  });

  const page = context.pages()[0] || (await context.newPage());

  try {
    await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: DEFAULT_TIMEOUT }).catch(() => {});

    if (page.url().includes("/login") || page.url().includes("/sign-in")) {
      console.log("Waiting for manual login...");
      if (!page.url().includes("/login")) {
        await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT }).catch(() => {});
      }
      await waitForAuthorized(page);
    }

    await clickText(page, "Фильтры").then((ok) => {
      if (!ok) throw new Error('Could not click "Фильтры"');
    });
    await sleep(1800);
    await page.waitForSelector("div[class*='_wrapper_'][class*='_visible_']", { timeout: DEFAULT_TIMEOUT }).catch(() => {});

    const filterOpened = await page.locator("h4:has-text('Фильтрация')").isVisible().catch(() => false);
    if (!filterOpened) {
      await saveArtifacts(page, "filters_not_opened");
      throw new Error("Filter panel did not open");
    }

    const clickedDate = await clickInVisibleDrawer(page, "Дата от: 16.04.2026", false)
      || await clickInVisibleDrawer(page, "Дата от", false)
      || await clickInVisibleDrawer(page, "Дата от: 16.04.2026", true)
      || await clickInVisibleDrawer(page, "Дата от", true);
    if (!clickedDate) {
      await saveArtifacts(page, "date_button_not_found");
      throw new Error('Could not click "Дата от: 16.04.2026"');
    }

    await sleep(1000);
    await saveArtifacts(page, "after_click_date_from");
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
