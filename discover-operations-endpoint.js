const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const PROJECT_DIR = __dirname;
const OUTPUT_DIR = path.join(os.homedir(), "Desktop", "заказ км");
const LOG_PATH = path.join(PROJECT_DIR, "operations_network_discovery.json");
const USER_DATA_DIR = path.join(PROJECT_DIR, "teksher-session-profile");
const TMP_DIR = path.join(PROJECT_DIR, "tmp");
const OPERATIONS_URL = "https://label.teksher.kg/operations";
const LOGIN_URL = "https://label.teksher.kg/login";
const DISCOVERY_WINDOW_MS = 2 * 60 * 1000;
const MANUAL_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function maskHeaderValue(key, value) {
  const name = String(key || "").toLowerCase();
  if (name === "authorization") {
    const text = String(value || "");
    return text ? `${text.slice(0, 12)}...` : "";
  }
  if (name === "cookie") {
    return String(value || "")
      .split(";")
      .map((part) => {
        const [cookieName] = part.split("=");
        const trimmed = cookieName?.trim();
        if (!trimmed) return "";
        return `${trimmed}=<redacted>`;
      })
      .filter(Boolean)
      .join("; ");
  }
  return value;
}

function sanitizeHeaders(headers = {}) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = maskHeaderValue(key, value);
  }
  return result;
}

function normalizeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function trimSnippet(value, max = 5000) {
  const text = String(value || "");
  return text.length > max ? text.slice(0, max) : text;
}

function looksLikeJson(contentType, bodyText) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("application/json") || type.includes("+json")) return true;
  const trimmed = String(bodyText || "").trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function findKeywordHits(text) {
  const value = String(text || "");
  const keywords = ["operationId", "gtin", "createdAt", "Заказ на эмиссию", "page", "total"];
  return keywords.filter((keyword) => value.includes(keyword));
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function waitForAuthorizedOperations(page) {
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  const authorized = await Promise.race([
    page.waitForURL((url) => {
      try {
        return new URL(String(url)).pathname.includes("/operations");
      } catch {
        return false;
      }
    }, { timeout: 5000 }).then(() => true).catch(() => false),
    page.locator("text=Операции").first().isVisible({ timeout: 5000 }).then(() => true).catch(() => false),
  ]);
  return authorized;
}

async function waitForManualLogin(page) {
  console.log("LOGIN_REQUIRED");
  console.log(`Waiting up to ${Math.round(MANUAL_LOGIN_TIMEOUT_MS / 1000)}s for manual login.`);
  if (!page.url().includes("/login")) {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  }
  const deadline = Date.now() + MANUAL_LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const authorized = await waitForAuthorizedOperations(page);
    if (authorized) return true;
    await sleep(3000);
  }
  return false;
}

async function main() {
  await ensureDir(OUTPUT_DIR);
  await fs.mkdir(TMP_DIR, { recursive: true });

  console.log(`Using Playwright session profile: ${USER_DATA_DIR}`);
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    acceptDownloads: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
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

  const page = await context.newPage();
  const entries = [];
  const entryByRequest = new Map();
  const candidates = new Map();
  const seenRequestKeys = new Set();

  function recordCandidate(entry, reason) {
    if (!entry?.url) return;
    const key = `${entry.url}::${reason}`;
    if (candidates.has(key)) return;
    candidates.set(key, {
      url: entry.url,
      reason,
      method: entry.method,
      status: entry.status ?? "",
      contentType: entry.contentType || "",
      hits: entry.responseBodySnippet ? findKeywordHits(entry.responseBodySnippet) : [],
    });
  }

  page.on("request", (request) => {
    const url = request.url();
    if (!url.includes("label.teksher.kg")) return;
    const method = request.method();
    const key = `${method} ${url} ${request.resourceType()} ${request.postData() || ""}`;
    if (seenRequestKeys.has(key)) return;
    seenRequestKeys.add(key);

    const entry = {
      capturedAt: new Date().toISOString(),
      stage: "request",
      url,
      host: normalizeHost(url),
      method,
      resourceType: request.resourceType(),
      headers: sanitizeHeaders(request.headers()),
      postData: trimSnippet(request.postData() || ""),
    };
    entries.push(entry);
    entryByRequest.set(request, entry);
  });

  page.on("response", async (response) => {
    const request = response.request();
    const url = request.url();
    if (!url.includes("label.teksher.kg")) return;

    const entry = entryByRequest.get(request) || {
      capturedAt: new Date().toISOString(),
      stage: "response",
      url,
      host: normalizeHost(url),
      method: request.method(),
      resourceType: request.resourceType(),
      headers: sanitizeHeaders(request.headers()),
      postData: trimSnippet(request.postData() || ""),
    };

    entry.stage = "response";
    entry.status = response.status();
    entry.contentType = response.headers()["content-type"] || "";
    entry.contentDisposition = response.headers()["content-disposition"] || "";
    entry.responseHeaders = sanitizeHeaders(response.headers());

    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch (error) {
      bodyText = `[[response.text() failed: ${error?.message || String(error)}]]`;
    }

    if (looksLikeJson(entry.contentType, bodyText)) {
      entry.responseBodySnippet = trimSnippet(bodyText, 5000);
      entry.responseBodyIsJson = true;
      recordCandidate(entry, "json");
    } else {
      entry.responseBodySnippet = trimSnippet(bodyText, 1000);
      entry.responseBodyIsJson = false;
    }

    entries.push({
      capturedAt: new Date().toISOString(),
      stage: "response",
      url: entry.url,
      host: entry.host,
      method: entry.method,
      resourceType: entry.resourceType,
      status: entry.status,
      contentType: entry.contentType,
      contentDisposition: entry.contentDisposition,
      headers: entry.headers,
      responseHeaders: entry.responseHeaders,
      postData: entry.postData,
      responseBodySnippet: entry.responseBodySnippet,
      responseBodyIsJson: entry.responseBodyIsJson,
    });
  });

  page.on("requestfailed", (request) => {
    const url = request.url();
    if (!url.includes("label.teksher.kg")) return;
    entries.push({
      capturedAt: new Date().toISOString(),
      stage: "requestfailed",
      url,
      host: normalizeHost(url),
      method: request.method(),
      resourceType: request.resourceType(),
      headers: sanitizeHeaders(request.headers()),
      postData: trimSnippet(request.postData() || ""),
      failureText: request.failure()?.errorText || "",
    });
  });

  await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

  const authorized = await waitForAuthorizedOperations(page);
  if (!authorized) {
    const loginOk = await waitForManualLogin(page);
    if (!loginOk) {
      throw new Error("Manual login timed out");
    }
  }

  console.log("Manual filter the page now:");
  console.log('- click "Фильтры"');
  console.log('- choose "Заказ на эмиссию КМ"');
  console.log('- set date from 15.05.2026');
  console.log('- set date to 15.05.2026');
  console.log('- apply filter');
  console.log(`Capturing network for ${Math.round(DISCOVERY_WINDOW_MS / 1000)}s...`);

  const captureStart = Date.now();
  await page.waitForTimeout(DISCOVERY_WINDOW_MS);
  const captureEnd = Date.now();

  const topCandidates = Array.from(candidates.values())
    .filter((item) => item.hits.length > 0 || /operationId|gtin|createdAt|Заказ на эмиссию|page|total/i.test(item.url))
    .sort((a, b) => {
      const score = (item) => {
        let value = 0;
        if (item.hits.includes("operationId")) value += 5;
        if (item.hits.includes("gtin")) value += 5;
        if (item.hits.includes("createdAt")) value += 5;
        if (item.hits.includes("Заказ на эмиссию")) value += 5;
        if (item.hits.includes("page")) value += 2;
        if (item.hits.includes("total")) value += 2;
        return value;
      };
      return score(b) - score(a);
    });

  const output = {
    generatedAt: new Date().toISOString(),
    pageUrl: page.url(),
    captureWindowMs: captureEnd - captureStart,
    entries,
    topCandidates,
  };

  await fs.writeFile(LOG_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`saved: ${LOG_PATH}`);
  console.log("top candidate URLs:");
  console.table(topCandidates.map((item) => ({
    url: item.url,
    method: item.method,
    status: item.status,
    contentType: item.contentType,
    hits: item.hits.join(", "),
    reason: item.reason,
  })));
  await context.close().catch(() => {});
}

main().catch((error) => {
  console.error("FATAL_ERROR");
  console.error(`error.name: ${error?.name || "n/a"}`);
  console.error(`error.message: ${error?.message || "n/a"}`);
  console.error(`error.stack: ${error?.stack || "n/a"}`);
  console.error(`error.cause: ${safeJsonStringify(error?.cause)}`);
  process.exitCode = 1;
});
