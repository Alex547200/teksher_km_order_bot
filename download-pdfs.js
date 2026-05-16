const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const OPERATIONS_URL = "https://label.teksher.kg/operations";
const SESSION_PROFILE_DIR = path.join(__dirname, "teksher-session-profile");
const SOURCE_PATH = path.join(__dirname, "audit_local_selected.json");
const OUTPUT_DIR = path.join(os.homedir(), "Desktop", "электросталь печать кодов паркеровки");
const DEFAULT_TIMEOUT = 30000;
const DOWNLOAD_TIMEOUT = 60000;

const BAD_STATUSES = new Set(["ERROR", "500", "502"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function sanitizeFilePart(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function uniqueByPair(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${row.gtin}|${row.operationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitForNoTmpDownloads(dir) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const files = await fs.readdir(dir).catch(() => []);
    if (!files.some((name) => name.endsWith(".crdownload"))) return true;
    await sleep(1000);
  }
  return false;
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
  ];

  for (const locator of locators) {
    if (await clickVisible(locator)) return true;
  }

  throw new Error(`Could not click "${text}"`);
}

async function findAndOpenOperation(page, operationId, gtin) {
  const candidates = [
    page.getByText(operationId, { exact: false }),
    page.getByText(gtin, { exact: false }),
    page.locator(`text=${operationId}`),
    page.locator(`text=${gtin}`),
  ];

  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = candidate.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      await item.click({ timeout: DEFAULT_TIMEOUT }).catch(async () => {
        const row = item.locator("xpath=ancestor::tr[1]");
        if (await row.isVisible().catch(() => false)) {
          await row.click({ timeout: DEFAULT_TIMEOUT });
        } else {
          throw new Error(`Could not open operation ${operationId}`);
        }
      });
      return true;
    }
  }

  const rows = page.locator("table tbody tr, [role='row'], .operation, .operations-row, li");
  const rowCount = await rows.count().catch(() => 0);
  for (let index = 0; index < rowCount; index += 1) {
    const row = rows.nth(index);
    if (!(await row.isVisible().catch(() => false))) continue;
    const text = await row.innerText().catch(() => "");
    if (!text.includes(operationId) && !text.includes(gtin)) continue;
    const clickable = row.locator("a,button,[role='button']").first();
    if (await clickable.isVisible().catch(() => false)) {
      await clickable.click({ timeout: DEFAULT_TIMEOUT });
    } else {
      await row.click({ timeout: DEFAULT_TIMEOUT });
    }
    return true;
  }

  throw new Error(`Could not locate operation ${operationId}`);
}

async function extractGtinFromPage(page) {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const match = bodyText.match(/GTIN\s*[:#]?\s*(\d{8,20})/i) || bodyText.match(/\b\d{14,20}\b/);
  if (match?.[1] || match?.[0]) return match[1] || match[0];
  throw new Error("Could not determine GTIN on operation page");
}

async function savePdfForOperation(page, gtin, outputDir) {
  const targetPath = path.join(outputDir, `${sanitizeFilePart(gtin)}.pdf`);
  if (await fileExists(targetPath)) {
    return { filePath: targetPath, skipped: true };
  }

  await clickText(page, "Печать и нанесение");
  const downloadPromise = page.waitForEvent("download", { timeout: DOWNLOAD_TIMEOUT });
  await clickText(page, "Печать");
  const download = await downloadPromise;

  await download.saveAs(targetPath);
  await waitForNoTmpDownloads(outputDir);

  if (!(await fileExists(targetPath))) {
    throw new Error(`Downloaded PDF not found: ${targetPath}`);
  }

  const stat = await fs.stat(targetPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Downloaded PDF is empty: ${targetPath}`);
  }

  return { filePath: targetPath, skipped: false };
}

async function main() {
  await ensureDir(OUTPUT_DIR);

  const payload = await readJson(SOURCE_PATH);
  const selected = Array.isArray(payload?.selected) ? payload.selected : [];
  const records = uniqueByPair(
    selected
      .filter((row) => row && row.gtin && row.operationId)
      .filter((row) => !BAD_STATUSES.has(normalizeStatus(row.status)))
  );

  const context = await chromium.launchPersistentContext(SESSION_PROFILE_DIR, {
    headless: false,
    acceptDownloads: true,
    viewport: { width: 1440, height: 1200 },
  });

  const results = [];

  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    await page.waitForLoadState("networkidle", { timeout: DEFAULT_TIMEOUT }).catch(() => {});

    const loginPage = page.url().includes("/login") || page.url().includes("/sign-in");
    if (loginPage) {
      throw new Error("LOGIN_REQUIRED");
    }

    for (const record of records) {
      try {
        await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
        await page.waitForLoadState("networkidle", { timeout: DEFAULT_TIMEOUT }).catch(() => {});

        await findAndOpenOperation(page, record.operationId, record.gtin);
        await page.waitForLoadState("networkidle", { timeout: DEFAULT_TIMEOUT }).catch(() => {});

        const gtin = await extractGtinFromPage(page).catch(() => record.gtin);
        const { filePath } = await savePdfForOperation(page, gtin, OUTPUT_DIR);

        results.push({
          gtin,
          operationId: record.operationId,
          status: record.status,
          filePath,
        });
      } catch (error) {
        if (String(error?.message || error) === "LOGIN_REQUIRED") throw error;
        results.push({
          gtin: record.gtin,
          operationId: record.operationId,
          status: record.status,
          filePath: `ERROR: ${error.message || String(error)}`,
        });
      }
    }

    console.table(results.map((row) => ({
      GTIN: row.gtin,
      operationId: row.operationId,
      status: row.status,
      filePath: row.filePath,
    })));
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
