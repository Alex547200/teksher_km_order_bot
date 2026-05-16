const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const PROJECT_DIR = __dirname;
const SOURCE_PATH = path.join(PROJECT_DIR, "audit_local_selected.json");
const OUTPUT_PATH = path.join(os.homedir(), "Desktop", "заказ км", "export_request_capture.json");
const SESSION_PROFILE_DIR = path.join(PROJECT_DIR, "teksher-session-profile");
const TMP_DIR = path.join(PROJECT_DIR, "tmp");
const OPERATIONS_URL = "https://label.teksher.kg/operations";
const DEFAULT_TIMEOUT = 30000;
const CAPTURE_WAIT_MS = 4000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStatus(value) {
  return String(value || "").trim().toUpperCase();
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

async function ensureDirs() {
  await ensureDir(path.dirname(OUTPUT_PATH));
  await ensureDir(TMP_DIR);
  await ensureDir(SESSION_PROFILE_DIR);
}

function sanitizeHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/^authorization$/i.test(key) && typeof value === "string") {
      out[key] = value.slice(0, 12) ? `${value.slice(0, 12)}...` : "present";
      continue;
    }
    if (/^cookie$/i.test(key) && typeof value === "string") {
      out[key] = "present";
      continue;
    }
    out[key] = value;
  }
  return out;
}

function matchesCaptureTarget(url) {
  return /\/facade\/.*(print|download|pdf|csv|operations\/[^/?#]+$)/i.test(url);
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
  return false;
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

async function extractGtinFromPage(page, fallback) {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const match = bodyText.match(/GTIN\s*[:#]?\s*(\d{8,20})/i) || bodyText.match(/\b\d{14,20}\b/);
  return match?.[1] || match?.[0] || fallback;
}

async function main() {
  await ensureDirs();

  const payload = await readJson(SOURCE_PATH);
  const records = uniqueByPair(
    (Array.isArray(payload?.selected) ? payload.selected : [])
      .filter((row) => row && row.gtin && row.operationId)
      .filter((row) => !["ERROR", "500", "502"].includes(normalizeStatus(row.status)))
  );

  if (!records.length) {
    throw new Error(`No selectable operation records found in ${SOURCE_PATH}`);
  }

  const record = records[0];
  console.log(`Using operationId=${record.operationId}, gtin=${record.gtin}, status=${record.status}`);
  console.log(`Using profile: ${SESSION_PROFILE_DIR}`);

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

  const page = context.pages()[0] || await context.newPage();
  const captures = [];
  const downloads = [];
  const responseListener = async (response) => {
    try {
      const request = response.request();
      const url = request.url();
      if (!matchesCaptureTarget(url)) return;

      const requestHeaders = sanitizeHeaders(request.headers());
      const responseHeaders = response.headers();
      const contentType = responseHeaders["content-type"] || responseHeaders["Content-Type"] || "";
      const contentDisposition = responseHeaders["content-disposition"] || responseHeaders["Content-Disposition"] || "";

      captures.push({
        url,
        method: request.method(),
        requestHeaders,
        contentType,
        responseStatus: response.status(),
        contentDisposition,
        responseHeaders: {
          "content-type": contentType,
          "content-disposition": contentDisposition,
        },
      });
    } catch (error) {
      captures.push({
        url: "response-listener-error",
        error: error.message || String(error),
      });
    }
  };

  page.on("response", responseListener);
  page.on("download", async (download) => {
    downloads.push({
      suggestedFilename: download.suggestedFilename(),
    });
  });

  try {
    await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    await page.waitForLoadState("networkidle", { timeout: DEFAULT_TIMEOUT }).catch(() => {});

    if (page.url().includes("/login") || page.url().includes("/sign-in")) {
      throw new Error("LOGIN_REQUIRED");
    }

    await page.goto(`${OPERATIONS_URL}/${encodeURIComponent(record.operationId)}`, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT,
    }).catch(async () => {
      await page.goto(`${OPERATIONS_URL}?operationId=${encodeURIComponent(record.operationId)}`, {
        waitUntil: "domcontentloaded",
        timeout: DEFAULT_TIMEOUT,
      });
    });
    await page.waitForLoadState("networkidle", { timeout: DEFAULT_TIMEOUT }).catch(() => {});

    if (page.url().includes("/login") || page.url().includes("/sign-in")) {
      throw new Error("LOGIN_REQUIRED");
    }

    await findAndOpenOperation(page, record.operationId, record.gtin).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: DEFAULT_TIMEOUT }).catch(() => {});

    const gtin = await extractGtinFromPage(page, record.gtin);
    const clickTargets = ["Печать и нанесение", "Печать", "CSV", "PDF", "Скачать"];
    for (const text of clickTargets) {
      const clicked = await clickText(page, text);
      if (!clicked) continue;
      await sleep(CAPTURE_WAIT_MS);
    }

    await sleep(CAPTURE_WAIT_MS);

    const chosenCapture = captures.find((entry) => /print|download|pdf|csv/i.test(entry.url)) || captures[0] || null;
    const output = {
      generatedAt: new Date().toISOString(),
      source: SOURCE_PATH,
      sessionProfile: SESSION_PROFILE_DIR,
      operation: {
        operationId: record.operationId,
        gtin,
        status: record.status,
        sourceFile: record.sourceFile || null,
      },
      capture: chosenCapture,
      captures,
      downloads,
    };

    await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    console.log(`saved: ${OUTPUT_PATH}`);
    console.log(`captures recorded: ${captures.length}`);
    console.log(`downloads recorded: ${downloads.length}`);
    if (chosenCapture) {
      console.log(`captured url: ${chosenCapture.url}`);
      console.log(`captured method: ${chosenCapture.method}`);
      console.log(`captured status: ${chosenCapture.responseStatus}`);
      console.log(`captured content-type: ${chosenCapture.contentType || "n/a"}`);
      console.log(`captured content-disposition: ${chosenCapture.contentDisposition || "n/a"}`);
    }
  } finally {
    page.off("response", responseListener);
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
