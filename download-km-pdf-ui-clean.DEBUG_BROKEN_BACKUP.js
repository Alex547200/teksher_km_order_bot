const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const authHelper = require("./teksher-auth.js");

const PROJECT_DIR = __dirname;
const BASE_URL = "https://label.teksher.kg";
const TEKSHER_HOST = "label.teksher.kg";
const TEKSHER_IP = process.env.TEKSHER_API_IP || "109.71.231.11";
const OPERATIONS_URL = `${BASE_URL}/operations`;
const AUTH_TOKENS_PATH = path.join(PROJECT_DIR, "auth_tokens.json");
const SESSION_PROFILE_DIR = path.join(PROJECT_DIR, "teksher-session-profile");
const REQUEST_TIMEOUT = 45_000;
const DOWNLOAD_TIMEOUT = 60_000;
const LIST_RETRY_ATTEMPTS = 5;
const LIST_RETRY_DELAY_MS = 3_000;
const PAGE_SIZE = 15;
const TARGET_OPERATION_TYPE_CODE = "MARK_CODE_ORDER";
const TARGET_OPERATION_TYPE_TEXT = "Заказ на эмиссию КМ";
const BAD_STATUSES = new Set(["ERROR", "500", "502"]);
const PDF_DEBUG_ONE = String(process.env.PDF_DEBUG_ONE || "").trim() === "1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLocalDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function formatIsoDateFromLocalDate(date = new Date()) {
  const { year, month, day } = getLocalDateParts(date);
  return `${year}-${month}-${day}`;
}

function addDaysIso(dateIso, days) {
  const [year, month, day] = String(dateIso).split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return formatIsoDateFromLocalDate(date);
}

function getEnvDate(name, fallback) {
  const value = String(process.env[name] || "").trim();
  return value || fallback;
}

function formatDateDot(dateIso) {
  const match = String(dateIso || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(dateIso || "").replace(/-/g, ".");
  return `${match[3]}.${match[2]}.${match[1]}`;
}

const DEFAULT_DATE_FROM = formatIsoDateFromLocalDate();
const DEFAULT_DATE_TO = addDaysIso(DEFAULT_DATE_FROM, 1);
const DATE_FROM = getEnvDate("DATE_FROM", DEFAULT_DATE_FROM);
const DATE_TO = getEnvDate("DATE_TO", DEFAULT_DATE_TO);
const OUTPUT_DIR = path.join(os.homedir(), "Desktop", "Текшер PDF", formatDateDot(DATE_FROM));
const LIST_ENDPOINT = `/facade/api/v1/operations/filter?size=${PAGE_SIZE}&page={page}&startDate=${DATE_FROM}&endDate=${DATE_TO}`;

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStatus(value) {
  return normalizeText(value).toUpperCase();
}

function sanitizeFilePart(value) {
  return normalizeText(value)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeToken(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "").trim();
}

function pickPathValue(source, pathSpec) {
  const segments = String(pathSpec).split(".");
  let current = source;
  for (const segment of segments) {
    if (current == null) return undefined;
    current = current[segment];
  }
  return current;
}

function pickText(source, pathSpecs) {
  for (const pathSpec of pathSpecs) {
    const value = pickPathValue(source, pathSpec);
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function extractCollection(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const candidatePaths = [
    "content",
    "records",
    "items",
    "operations",
    "data.content",
    "data.records",
    "data.items",
    "data.operations",
    "response.content",
    "response.records",
    "response.items",
    "response.operations",
    "response.data.content",
    "response.data.records",
    "response.data.items",
    "response.data.operations",
    "result.content",
    "result.records",
    "result.items",
    "result.operations",
    "result.data.content",
    "result.data.records",
    "result.data.items",
    "result.data.operations",
  ];
  for (const pathSpec of candidatePaths) {
    const value = pickPathValue(payload, pathSpec);
    if (Array.isArray(value)) return value;
  }
  return [];
}

function extractTotalPages(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const candidates = [
    payload.totalPages,
    payload.page?.totalPages,
    payload.data?.totalPages,
    payload.data?.page?.totalPages,
    payload.response?.totalPages,
    payload.response?.page?.totalPages,
    payload.response?.data?.totalPages,
    payload.response?.data?.page?.totalPages,
    payload.result?.totalPages,
    payload.result?.page?.totalPages,
    payload.result?.data?.totalPages,
    payload.result?.data?.page?.totalPages,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function extractOperationId(record) {
  return pickText(record, ["operationId", "id", "operation_id", "operationID"]);
}

function extractOperationType(record) {
  return normalizeText(pickText(record, ["operationType", "type", "operation.type", "operationTypeCode"]));
}

function extractOperationName(record) {
  return normalizeText(pickText(record, ["operationTypeName", "name", "title", "description"]));
}

function extractCreatedAt(record) {
  return pickText(record, [
    "createdAt",
    "createdDate",
    "statusDate",
    "operationDate",
    "created",
    "operation.createdAt",
    "metadata.createdAt",
  ]);
}

function parseDateOnly(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const ddmmyyyy = text.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (ddmmyyyy) return `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  return "";
}

function isTargetDate(record) {
  const dateOnly = parseDateOnly(extractCreatedAt(record));
  return Boolean(dateOnly && dateOnly >= DATE_FROM && dateOnly < DATE_TO);
}

function matchesTargetOperationType(record) {
  const joined = `${extractOperationType(record)} ${extractOperationName(record)}`.toUpperCase();
  return joined.includes(TARGET_OPERATION_TYPE_CODE) || joined.includes(TARGET_OPERATION_TYPE_TEXT.toUpperCase());
}

function extractGtinLike(value) {
  const text = JSON.stringify(value || "");
  const match = text.match(/\b\d{14}\b/);
  return match ? match[0] : "";
}

function extractProductCode(value) {
  const seen = new Set();
  const queue = [value];
  while (queue.length) {
    const current = queue.shift();
    if (current == null) continue;
    if (typeof current === "string") {
      const text = current.trim();
      if (/^\d{8,20}$/.test(text)) return text;
      continue;
    }
    if (typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const [key, nested] of Object.entries(current)) {
      const lower = key.toLowerCase();
      if (typeof nested === "string" && nested.trim()) {
        if (
          lower.includes("productcode") ||
          lower.includes("product_code") ||
          lower === "gtin" ||
          lower.endsWith("gtin") ||
          lower.includes("article") ||
          lower.includes("code") ||
          lower.includes("sku")
        ) {
          const text = nested.trim();
          if (text) return text;
        }
      }
      if (nested && typeof nested === "object") queue.push(nested);
    }
  }
  return "";
}

async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (error) {
    if (error?.code === "EPERM") {
      const { execFileSync } = require("node:child_process");
      execFileSync("mkdir", ["-p", dir]);
      return;
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, value) {
  await fs.writeFile(filePath, String(value || ""), "utf8");
}

async function dumpComboboxSnapshot(page, operationId, suffix) {
  const safeOperationId = sanitizeFilePart(operationId || "unknown");
  const dir = path.join(PROJECT_DIR, "tmp", "debug-pdf", safeOperationId);
  await ensureDir(dir);
  const html = await page.content().catch(() => "");
  await fs.writeFile(path.join(dir, `${suffix}.html`), html, "utf8").catch(() => {});
  await page.screenshot({ path: path.join(dir, `${suffix}.png`), fullPage: true }).catch(() => {});
  const options = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[role="option"], [id*="option"], li, div'))
      .filter((el) => el && el.getClientRects && el.getClientRects().length > 0);
    return nodes.map((el, index) => ({
      index,
      tagName: el.tagName,
      id: el.id || "",
      className: el.className || "",
      textContent: String(el.textContent || "").replace(/\s+/g, " ").trim(),
      value: "value" in el ? String(el.value || "") : "",
      role: el.getAttribute("role") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      ariaExpanded: el.getAttribute("aria-expanded") || "",
      ariaHaspopup: el.getAttribute("aria-haspopup") || "",
      title: el.getAttribute("title") || "",
    }));
  }).catch(() => []);
  await writeJson(path.join(dir, `${suffix}-options.json`), { operationId, suffix, options });
  return { dir, optionsCount: Array.isArray(options) ? options.length : 0 };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildUrl(endpointPath) {
  return new URL(endpointPath, BASE_URL).toString();
}

function buildIpUrl(endpointPath) {
  return new URL(endpointPath, `https://${TEKSHER_IP}`).toString();
}

function withHostHeader(headers = {}, url = "") {
  const next = { ...headers };
  if (String(url).includes(TEKSHER_IP) && !next.Host && !next.host) {
    next.Host = TEKSHER_HOST;
  }
  return next;
}

function isRetryableFetchError(error) {
  const code = error?.cause?.code || error?.code || "";
  const message = String(error?.message || error || "");
  return (
    message.includes("fetch failed")
    || code === "UND_ERR_CONNECT_TIMEOUT"
    || code === "ECONNRESET"
    || code === "ETIMEDOUT"
    || code === "ENOTFOUND"
    || code === "EAI_AGAIN"
  );
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Request timeout")), REQUEST_TIMEOUT);
  try {
    const headers = withHostHeader(options.headers, url);
    const method = String(options.method || "GET").toUpperCase();
    const body = typeof options.body === "string" ? options.body : options.body ? "[non-string-body]" : null;
    console.log("[REQUEST]", method, url);
    console.log("[REQUEST] body=", body || "null");
    return await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timeout);
  }
}

function isNetworkFetchError(error) {
  const code = error?.cause?.code || error?.code || "";
  const message = String(error?.message || error || "");
  return (
    message.includes("fetch failed")
    || code === "UND_ERR_CONNECT_TIMEOUT"
    || code === "ECONNRESET"
    || code === "ETIMEDOUT"
    || code === "ENOTFOUND"
    || code === "EAI_AGAIN"
    || code === "EPERM"
  );
}

async function fetchApi(endpointPath, options = {}) {
  const primaryUrl = buildUrl(endpointPath);
  try {
    return { response: await fetchWithTimeout(primaryUrl, options), url: primaryUrl, usingIp: false };
  } catch (error) {
    if (!isNetworkFetchError(error)) throw error;
    const fallbackUrl = buildIpUrl(endpointPath);
    console.log(`FETCH_RETRY_IP: ${fallbackUrl}`);
    return { response: await fetchWithTimeout(fallbackUrl, options), url: fallbackUrl, usingIp: true };
  }
}

async function readResponseSnippet(response) {
  const contentType = response.headers.get("content-type") || "";
  const contentDisposition = response.headers.get("content-disposition") || "";
  const text = await response.text();
  const snippet = text.slice(0, 500);
  return { contentType, contentDisposition, text, snippet };
}

function logApiRequest({ method, url, body }) {
  console.log(`[API_REQUEST] method=${method} url=${url}`);
  console.log(`[API_REQUEST] body=${body ? body : "null"}`);
}

function logApiResponse({ status, contentType, snippet }) {
  console.log(`[API_RESPONSE] status=${status} contentType=${contentType || "n/a"}`);
  if (snippet) console.log(`[API_RESPONSE] snippet=${snippet}`);
}

async function refreshAuthHeaders(authState) {
  if (!authState?.refreshToken) {
    throw new Error("TOKEN_REFRESH_FAILED_RUN_MANUAL_TOKEN: refresh_token missing");
  }
  const refreshed = await authHelper.refreshAuthToken(authState.refreshToken, {
    authTokensPath: AUTH_TOKENS_PATH,
    source: "download-km-pdf-ui-clean",
  });
  authState.accessToken = normalizeToken(refreshed.accessToken || "");
  authState.refreshToken = normalizeToken(refreshed.refreshToken || authState.refreshToken);
  authState.tokenExpiresAtMs = authHelper.decodeJwtExpMs(authState.accessToken);
  authState.headers = {
    Authorization: `Bearer ${authState.accessToken}`,
    Accept: "application/json, text/plain, */*",
    Origin: BASE_URL,
    Referer: `${BASE_URL}/operations`,
  };
  console.log("ACCESS_TOKEN_REFRESHED");
  console.log(`NEW_EXP ${authState.tokenExpiresAtMs ? new Date(authState.tokenExpiresAtMs).toISOString() : "n/a"}`);
  return authState;
}

async function fetchPageWithRetry(pageNumber, authState) {
  const endpointPath = LIST_ENDPOINT.replace("{page}", String(pageNumber));
  const url = buildUrl(endpointPath);
  let lastError = null;
  for (let attempt = 1; attempt <= LIST_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const headers = authState?.headers || {};
      const response = await fetchWithTimeout(url, {
        method: "GET",
        headers,
        redirect: "follow",
      });
      if (response.status === 401 && attempt < LIST_RETRY_ATTEMPTS && authState?.refreshToken) {
        console.warn(`LIST_RETRY attempt ${attempt}/${LIST_RETRY_ATTEMPTS} HTTP 401 page=${pageNumber}`);
        await refreshAuthHeaders(authState);
        await sleep(LIST_RETRY_DELAY_MS);
        continue;
      }
      if ([502, 503, 504].includes(response.status) && attempt < LIST_RETRY_ATTEMPTS) {
        console.warn(`LIST_RETRY attempt ${attempt}/${LIST_RETRY_ATTEMPTS} HTTP ${response.status} page=${pageNumber}`);
        await sleep(LIST_RETRY_DELAY_MS);
        continue;
      }
      const { contentType, text, snippet } = await readResponseSnippet(response);
      console.log("[REQUEST] status", response.status);
      console.log("[REQUEST] content-type", contentType || "n/a");
      if (!response.ok && snippet) {
        console.log("[REQUEST] response snippet", snippet);
      }
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { url, status: response.status, ok: response.ok, json, text };
    } catch (error) {
      lastError = error;
      if (attempt < LIST_RETRY_ATTEMPTS && isRetryableFetchError(error)) {
        console.warn(`LIST_RETRY attempt ${attempt}/${LIST_RETRY_ATTEMPTS} NETWORK_ERROR page=${pageNumber}`);
        console.warn(`LIST_RETRY reason=${error?.cause?.code || error?.message || error}`);
        await sleep(LIST_RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error(`List endpoint failed for page ${pageNumber}`);
}

async function readAuthHeaders() {
  const candidates = await authHelper.readAuthCandidatesFromFiles([
    { path: AUTH_TOKENS_PATH, source: "auth_tokens.json" },
  ]);
  const accessCandidate = authHelper.chooseAccessToken(candidates);
  const refreshCandidate = authHelper.chooseRefreshToken(candidates);

  let accessToken = normalizeToken(accessCandidate?.token || "");
  let refreshToken = normalizeToken(refreshCandidate?.token || "");
  let tokenExpiresAtMs = authHelper.decodeJwtExpMs(accessToken);

  if (!accessToken) {
    throw new Error("TOKEN_MISSING: auth_tokens.json access_token not found");
  }

  return {
    accessToken,
    refreshToken,
    tokenExpiresAtMs,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json, text/plain, */*",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/operations`,
    },
  };
}

async function loadOperations(authState) {
  const rows = [];
  let pageNumber = 0;
  let totalPages = null;
  while (true) {
    const page = await fetchPageWithRetry(pageNumber, authState);
    if (!page.ok) {
      throw new Error(`List endpoint failed with HTTP ${page.status}`);
    }
    const items = extractCollection(page.json);
    totalPages = extractTotalPages(page.json) ?? totalPages;
    for (const item of items) {
      const operationId = extractOperationId(item);
      const createdAt = extractCreatedAt(item);
      const status = normalizeStatus(pickText(item, ["status", "state", "operationStatus", "currentStatus", "documentStatus"]));
      const operationType = extractOperationType(item);
      if (!operationId) continue;
      if (!isTargetDate(item)) continue;
      if (!matchesTargetOperationType(item)) continue;
      if (BAD_STATUSES.has(status)) continue;
      rows.push({
        operationId,
        createdAt,
        status,
        operationType,
        raw: item,
      });
    }
    pageNumber += 1;
    if (typeof totalPages === "number" && pageNumber >= totalPages) break;
    if (items.length < PAGE_SIZE) break;
  }
  rows.sort((left, right) => {
    const leftTime = Date.parse(left.createdAt || "") || 0;
    const rightTime = Date.parse(right.createdAt || "") || 0;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return String(left.operationId || "").localeCompare(String(right.operationId || ""));
  });
  return rows;
}

async function clickVisible(locator) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) {
      await item.click({ timeout: REQUEST_TIMEOUT, force: true });
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

async function openOperationFromList(page, operationId) {
  const directCandidates = [
    `${BASE_URL}/operations/${encodeURIComponent(operationId)}`,
    `${BASE_URL}/operations?operationId=${encodeURIComponent(operationId)}`,
    `${BASE_URL}/operations/${encodeURIComponent(operationId)}/details`,
  ];

  for (const url of directCandidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT });
      await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});
      const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
      if (bodyText.includes(operationId)) {
        return { opened: true, via: url };
      }
    } catch {
      continue;
    }
  }

  await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT });
  await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});

  const searchInputs = [
    page.locator('input[type="search"]'),
    page.locator('input[placeholder*="Поиск" i]'),
    page.locator('input[aria-label*="Поиск" i]'),
    page.locator('input[placeholder*="search" i]'),
    page.locator('input[aria-label*="search" i]'),
  ];
  for (const locator of searchInputs) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const input = locator.nth(index);
      if (!(await input.isVisible().catch(() => false))) continue;
      await input.fill(operationId).catch(() => {});
      await input.press("Enter").catch(() => {});
      await sleep(1500);
      const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
      if (bodyText.includes(operationId)) {
        return { opened: true, via: "search" };
      }
    }
  }

  const rows = page.locator("table tbody tr, [role='row'], .operation, .operations-row, li");
  let rowCount = await rows.count().catch(() => 0);
  for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
    rowCount = await rows.count().catch(() => 0);
    for (let index = 0; index < rowCount; index += 1) {
      const row = rows.nth(index);
      if (!(await row.isVisible().catch(() => false))) continue;
      const text = await row.innerText().catch(() => "");
      if (!text.includes(operationId)) continue;
      const clickable = row.locator("a,button,[role='button']").first();
      if (await clickable.isVisible().catch(() => false)) {
        await clickable.click({ timeout: REQUEST_TIMEOUT, force: true });
      } else {
        await row.click({ timeout: REQUEST_TIMEOUT, force: true });
      }
      return { opened: true, via: `table-page-${pageIndex}` };
    }

    const nextCandidates = [
      page.getByRole("button", { name: /next|следующ|вперёд|вперед/i }),
      page.locator('button[aria-label*="next" i]'),
      page.locator('button[title*="next" i]'),
      page.locator('button:has-text("Next")'),
      page.locator('button:has-text("След")'),
    ];
    let advanced = false;
    for (const locator of nextCandidates) {
      if (await clickVisible(locator)) {
        await sleep(1500);
        advanced = true;
        break;
      }
    }
    if (!advanced) break;
  }

  return { opened: false, via: "not-found" };
}

async function waitForPrintModal(page) {
  const modalCandidates = [
    page.locator('[role="dialog"]'),
    page.locator('[aria-modal="true"]'),
    page.locator('div:has-text("Печать и нанесение")'),
  ];
  for (const locator of modalCandidates) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return null;
}

async function detectPrintReadyPage(page) {
  const buttons = await collectVisibleButtons(page);
  const texts = buttons.map((item) => item.text);
  const hasPrint = texts.some((text) => /^печать$/i.test(text));
  const hasBack = texts.some((text) => /назад к таблице/i.test(text));
  const hasCancel = texts.some((text) => /отменить/i.test(text));
  const comboboxes = await getVisibleComboboxes(page);
  const hasCombobox = comboboxes.length >= 1;
  return Boolean(hasPrint && hasBack && !hasCancel && !hasCombobox);
}

async function waitOperationsList(page) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
    if (/operation|операц/i.test(bodyText) || await page.locator("table, [role='row']").count().catch(() => 0)) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

async function closeAllModalsAndResetPage(page) {
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(250);
  }

  const closeSelectors = [
    page.getByRole("button", { name: /закрыть/i }),
    page.getByRole("button", { name: /отменить/i }),
    page.getByRole("button", { name: /cancel/i }),
    page.getByRole("button", { name: /^×$/ }),
    page.getByText(/^×$/),
  ];
  for (const locator of closeSelectors) {
    await clickVisible(locator).catch(() => false);
  }

  await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});
  return await waitOperationsList(page);
}

async function assertPrintTemplateModal(page, operationId, debugState, modalLocator) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
    const comboboxes = await getVisibleComboboxes(page);
    const dialogs = await page.locator('[role="dialog"], [aria-modal="true"]').count().catch(() => 0);
    const hasPdf = /PDF файл/i.test(bodyText);
    const hasTemplate = /Шаблон/i.test(bodyText);
    const hasTemplateValue = /горизонтальный|описанием товара|Data matrix/i.test(bodyText);
    const hasAction = /Печать|Скачать/i.test(bodyText);
    const hasAnyValidState = Boolean(
      dialogs > 0 ||
      comboboxes.length > 0 ||
      hasPdf ||
      hasTemplate ||
      hasTemplateValue ||
      hasAction,
    );
    if (hasAnyValidState) return true;
    await sleep(250);
  }

  await dumpVisibleUi(page, operationId, "after-print-click-timeout").catch(() => {});
  await captureUiDebug(page, operationId, "PRINT_TEMPLATE_MODAL_NOT_READY", debugState, modalLocator).catch(() => {});
  throw new Error("PRINT_TEMPLATE_MODAL_NOT_READY");
}

async function selectPrintFormatPdf(page, modal, operationId, debugState = {}) {
  const modalRootCandidates = [
    page.locator('text=Печать кодов маркировки').locator('xpath=ancestor::*[contains(@class,"modal") or contains(@class,"dialog") or @role="dialog"][1]'),
    modal,
    page.locator('[role="dialog"]'),
    page.locator('[aria-modal="true"]'),
    page.locator("body"),
  ];

  let modalRoot = null;
  for (const candidate of modalRootCandidates) {
    const count = await candidate.count().catch(() => 0);
    if (!count) continue;
    const item = candidate.first();
    if (await item.isVisible().catch(() => false)) {
      modalRoot = item;
      break;
    }
  }
  if (!modalRoot) {
    await dumpVisibleUi(page, operationId, "format-control-not-found").catch(() => {});
    throw new Error("KM_PDF_FORMAT_SELECTION_FAILED");
  }

  await dumpVisibleUi(page, operationId, "before-format-select").catch(() => {});

  const rootText = normalizeText(await modalRoot.innerText().catch(() => ""));
  if (/PDF файл/i.test(rootText)) {
    console.log("[STEP] selected PDF format");
    await dumpVisibleUi(page, operationId, "after-format-pdf").catch(() => {});
    return true;
  }

  const strategies = [
    async () => {
      const csv = modalRoot.getByText(/CSV файл/i);
      const pdf = modalRoot.getByText(/PDF файл/i);
      if (await csv.count().catch(() => 0)) {
        await csv.first().click({ force: true }).catch(() => {});
        await page.waitForTimeout(500);
      }
      if (await pdf.count().catch(() => 0)) {
        await pdf.first().click({ force: true }).catch(() => {});
      }
    },
    async () => {
      const label = modalRoot.getByText(/Формат файла/i).first();
      if (await label.count().catch(() => 0)) {
        await label.click({ force: true }).catch(() => {});
        await page.waitForTimeout(250);
      }
      const pdf = modalRoot.getByText(/PDF файл/i).first();
      if (await pdf.count().catch(() => 0)) {
        await pdf.click({ force: true }).catch(() => {});
      }
    },
    async () => {
      await page.keyboard.press("Tab").catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
      await page.waitForTimeout(250);
      await page.keyboard.press("ArrowDown").catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
    },
    async () => {
      const combo = modalRoot.locator('[role="combobox"]').first();
      if (await combo.count().catch(() => 0)) {
        await combo.click({ force: true }).catch(() => {});
        await page.waitForTimeout(250);
        const pdf = page.getByText(/PDF файл/i).first();
        if (await pdf.count().catch(() => 0)) {
          await pdf.click({ force: true }).catch(() => {});
        }
      }
    },
    async () => {
      const input = modalRoot.locator("input").first();
      if (await input.count().catch(() => 0)) {
        await input.click({ force: true }).catch(() => {});
        await page.waitForTimeout(250);
        const pdf = page.getByText(/PDF файл/i).first();
        if (await pdf.count().catch(() => 0)) {
          await pdf.click({ force: true }).catch(() => {});
        }
      }
    },
  ];

  const strategyNames = ["A", "B", "C", "D", "E"];
  for (let index = 0; index < strategies.length; index += 1) {
    await strategies[index]().catch(() => {});
    await page.waitForTimeout(500);
    const modalText = normalizeText(await modalRoot.innerText().catch(() => ""));
    await dumpVisibleUi(page, operationId, `after-format-strategy-${strategyNames[index]}`).catch(() => {});
    if (/PDF файл/i.test(modalText)) {
      console.log("[STEP] selected PDF format");
      await dumpVisibleUi(page, operationId, "after-format-pdf").catch(() => {});
      return true;
    }
  }

  await dumpVisibleUi(page, operationId, "format-selection-failed").catch(() => {});
  await captureUiDebug(page, operationId, "KM_PDF_FORMAT_SELECTION_FAILED", debugState, modal).catch(() => {});
  throw new Error("KM_PDF_FORMAT_SELECTION_FAILED");
}

async function getVisibleComboboxes(page) {
  const comboboxes = page.locator('input[role="combobox"]');
  const count = await comboboxes.count().catch(() => 0);
  const visible = [];
  for (let index = 0; index < count; index += 1) {
    const item = comboboxes.nth(index);
    if (await item.isVisible().catch(() => false)) visible.push(item);
  }
  return visible;
}

async function collectVisibleOptions(page) {
  const locator = page.locator('[role="option"], [id*="option"]');
  const count = await locator.count().catch(() => 0);
  const items = [];
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const text = normalizeText(await item.innerText().catch(() => ""));
    if (!text) continue;
    items.push({
      index,
      text,
    });
  }
  return items;
}

async function collectVisibleButtons(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll("button"))
    .filter((el) => el && el.getClientRects && el.getClientRects().length > 0)
    .map((el, index) => ({
      index,
      text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
      ariaLabel: el.getAttribute("aria-label") || "",
      title: el.getAttribute("title") || "",
    }))
  ).catch(() => []);
}

function buttonTextMatches(text, patterns) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return patterns.some((pattern) => pattern.test(normalized));
}

async function clickPrintEntry(page, operationId, debugState) {
  const deadlineMs = 10_000;
  const startedAt = Date.now();
  const modalCancelVisible = async () => {
    const cancelButtons = page.getByRole("button", { name: /отменить/i });
    const count = await cancelButtons.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (await cancelButtons.nth(index).isVisible().catch(() => false)) return true;
    }
    return false;
  };

  while (Date.now() - startedAt < deadlineMs) {
    const visibleButtons = await collectVisibleButtons(page);
    console.log(`[STEP] visible buttons: ${visibleButtons.map((item) => item.text).join(" | ")}`);

    const cancelVisible = await modalCancelVisible();
    const candidateTexts = visibleButtons
      .map((item) => item.text)
      .filter((text) => /печать и нанесение/i.test(text) || (!cancelVisible && /^печать$/i.test(text)));

    for (const text of candidateTexts) {
      const exact = page.getByRole("button", { name: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
      const byRole = page.getByRole("button", { name: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") });
      const byText = page.getByText(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
      const candidates = [exact, byRole, byText];
      for (const candidate of candidates) {
        const count = await candidate.count().catch(() => 0);
        if (!count) continue;
        for (let index = 0; index < count; index += 1) {
          const item = candidate.nth(index);
          if (!(await item.isVisible().catch(() => false))) continue;
          console.log(`[STEP] click print entry: ${text}`);
          await item.scrollIntoViewIfNeeded().catch(() => {});
          await item.click({ force: true }).catch(() => {});
          return true;
        }
      }
    }

    const fallback = [
      page.getByRole("button", { name: /печать и нанесение/i }),
      page.getByText(/печать и нанесение/i),
      page.locator('button').filter({ hasText: /печать и нанесение/i }),
      ...(!cancelVisible ? [
        page.getByRole("button", { name: /^печать$/i }),
        page.getByText(/^печать$/i),
        page.locator('button').filter({ hasText: /^печать$/i }),
      ] : []),
    ];
    for (const candidate of fallback) {
      const count = await candidate.count().catch(() => 0);
      if (!count) continue;
      for (let index = 0; index < count; index += 1) {
        const item = candidate.nth(index);
        if (!(await item.isVisible().catch(() => false))) continue;
        const text = normalizeText(await item.innerText().catch(() => ""));
        console.log(`[STEP] click print entry: ${text || "Печать"}`);
        await item.scrollIntoViewIfNeeded().catch(() => {});
        await item.click({ force: true }).catch(() => {});
        return true;
      }
    }

    await sleep(500);
  }

  await captureUiDebug(page, operationId, "PRINT_ENTRY_NOT_FOUND", debugState, null).catch(() => {});
  throw new Error("PRINT_ENTRY_NOT_FOUND");
}

async function clickPrintSubmitButton(page, operationId, modal) {
  const buttons = await modal.locator("button").evaluateAll((nodes) =>
    nodes.map((b, i) => ({
      index: i,
      text: (b.innerText || b.textContent || "").trim(),
      disabled: Boolean(b.disabled),
      visible: !!(b.offsetWidth || b.offsetHeight || b.getClientRects().length),
    })),
  );

  console.log("[PRINT_BUTTONS_SUBMIT]", JSON.stringify(buttons, null, 2));

  const candidates = buttons.filter((b) => b.visible && !b.disabled && /^Печать$/i.test(b.text || ""));
  if (!candidates.length) {
    await dumpDebug(page, operationId, "NO_PRINT_SUBMIT_BUTTON_FOUND");
    throw new Error("NO_PRINT_SUBMIT_BUTTON_FOUND");
  }

  const target = candidates[candidates.length - 1];
  console.log("[STEP] click print submit inside modal:", target.index, target.text);

  await modal.locator("button").nth(target.index).click({ timeout: 10_000 });
}

async function clickPrintOnReadyPage(page, operationId) {
  const candidates = await page.locator("button").evaluateAll((nodes) =>
    nodes.map((b, i) => {
      const text = String(b.innerText || b.textContent || "").trim();
      const ariaHidden = String(b.getAttribute("aria-hidden") || "").toLowerCase();
      const tabindex = String(b.getAttribute("tabindex") || "");
      const className = String(b.className || "");
      const id = String(b.id || "");
      const visible = !!(b.offsetWidth || b.offsetHeight || b.getClientRects().length);
      const disabled = Boolean(b.disabled);
      return { index: i, text, ariaHidden, tabindex, className, id, visible, disabled };
    }).filter((item) =>
      item.visible &&
      !item.disabled &&
      item.ariaHidden !== "true" &&
      item.tabindex !== "-1" &&
      !/tabs-nav-more/i.test(item.className) &&
      !/more/i.test(item.text) &&
      !/more/i.test(item.id) &&
      /печать/i.test(item.text)
    ),
  );

  console.log("[PRINT_CANDIDATES]", JSON.stringify(candidates, null, 2));

  const target = candidates.find((item) => /^печать$/i.test(item.text));
  if (!target) {
    await dumpDebug(page, operationId, "REAL_PRINT_BUTTON_NOT_FOUND");
    throw new Error("REAL_PRINT_BUTTON_NOT_FOUND");
  }

  console.log("[STEP] click print entry:", target.text);
  await page.locator("button").nth(target.index).scrollIntoViewIfNeeded().catch(() => {});
  await page.locator("button").nth(target.index).click({ force: true });
}

async function validatePrintPageHasKmLabels(page) {
  const metrics = await page.evaluate(() => {
    const text = String(document.body?.innerText || document.body?.textContent || "");
    const texts = Array.from(new Set(Array.from(document.querySelectorAll("body *"))
      .filter((el) => el && el.getClientRects && el.getClientRects().length > 0)
      .map((el) => String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)));
    const candidates = Array.from(document.querySelectorAll("canvas, svg, img, [data:image], [style*='base64'], [style*='data:image'], [src*='data:image']"));
    const longStrings = text.match(/\b(?:\d{14,}|[A-Z0-9]{16,}|01\d{14,})\b/g) || [];
    const hasCanvas = document.querySelectorAll("canvas").length > 0;
    const hasSvg = document.querySelectorAll("svg").length > 0;
    const hasDataImage = Array.from(document.querySelectorAll("img, source, video, canvas"))
      .some((el) => String(el.getAttribute?.("src") || el.getAttribute?.("data") || el.getAttribute?.("style") || "").includes("data:image"));
    const hasGtin = /\bGTIN\b/i.test(text);
    const hasKmLabel = /Код маркировки|маркировк/i.test(text);
    const hasDataMatrix = /DataMatrix|Data matrix/i.test(text);
    const hasKmLikeLabel = /Код маркировки|DataMatrix|Data matrix|этикетк|горизонтал/i.test(text);
    const frameSummaries = [];
    for (let index = 0; index < window.frames.length; index += 1) {
      try {
        const frame = window.frames[index];
        const doc = frame.document;
        const frameText = String(doc?.body?.innerText || doc?.body?.textContent || "");
        frameSummaries.push({
          index,
          url: frame.location?.href || "",
          sameOrigin: true,
          hasCanvas: doc.querySelectorAll("canvas").length > 0,
          hasSvg: doc.querySelectorAll("svg").length > 0,
          hasDataImage: Array.from(doc.querySelectorAll("img, source, video, canvas"))
            .some((el) => String(el.getAttribute?.("src") || el.getAttribute?.("data") || el.getAttribute?.("style") || "").includes("data:image")),
          hasGtin: /\bGTIN\b/i.test(frameText),
          hasKmLabel: /Код маркировки|маркировк/i.test(frameText),
          hasDataMatrix: /DataMatrix|Data matrix/i.test(frameText),
          longStrings: frameText.match(/\b(?:\d{14,}|[A-Z0-9]{16,}|01\d{14,})\b/g) || [],
          textSnippet: frameText.slice(0, 1000),
        });
      } catch (error) {
        frameSummaries.push({
          index,
          sameOrigin: false,
          error: String(error?.message || error),
        });
      }
    }
    return {
      url: location.href,
      text,
      texts,
      hasCanvas,
      hasSvg,
      hasDataImage,
      hasGtin,
      hasKmLabel,
      hasDataMatrix,
      hasKmLikeLabel,
      longStrings,
      candidateCount: candidates.length,
      frameSummaries,
    };
  }).catch(() => ({
    url: page.url(),
    text: "",
    texts: [],
    hasCanvas: false,
    hasSvg: false,
    hasDataImage: false,
    hasGtin: false,
    hasKmLabel: false,
    hasDataMatrix: false,
    hasKmLikeLabel: false,
    longStrings: [],
    candidateCount: 0,
    frameSummaries: [],
  }));

  const labelSignals = [
    metrics.hasCanvas,
    metrics.hasSvg,
    metrics.hasDataImage,
    metrics.hasKmLabel,
    metrics.hasDataMatrix,
    metrics.hasKmLikeLabel,
    metrics.longStrings.length > 0 && (metrics.hasKmLabel || metrics.hasDataMatrix || metrics.hasKmLikeLabel),
  ].filter(Boolean).length;

  const valid = Boolean(labelSignals > 0);
  const reasons = [];
  if (!metrics.hasCanvas) reasons.push("no-canvas");
  if (!metrics.hasSvg) reasons.push("no-svg");
  if (!metrics.hasDataImage) reasons.push("no-data-image");
  if (!metrics.hasKmLabel) reasons.push("no-km-label");
  if (!metrics.hasDataMatrix) reasons.push("no-datamatrix");
  if (!metrics.hasKmLikeLabel) reasons.push("no-km-like-text");
  if (!metrics.longStrings.length) reasons.push("no-long-strings");

  return { valid, reasons: valid ? [] : reasons, labelSignals, ...metrics };
}

async function savePrintTargetArtifacts(page, operationId, targetPath, validation, stage = "print-target", meta = {}) {
  const safeOperationId = sanitizeFilePart(operationId || "unknown");
  const dir = path.join(PROJECT_DIR, "tmp", "pdf-ui-debug", safeOperationId);
  await ensureDir(dir);

  await fs.writeFile(path.join(dir, `${stage}.html`), await page.content().catch(() => ""), "utf8").catch(() => {});
  await page.screenshot({ path: path.join(dir, `${stage}.png`), fullPage: true }).catch(() => {});
  await writeJson(path.join(dir, `${stage}-meta.json`), {
    stage,
    url: page.url(),
    targetPath,
    validation,
    ...meta,
  }).catch(() => {});
  await writeJson(path.join(dir, `${stage}.json`), {
    stage,
    url: page.url(),
    targetPath,
    validation,
    ...meta,
  }).catch(() => {});
}

async function saveFinalPrintSnapshot(operationId, snapshot, finalNetwork = []) {
  const safeOperationId = sanitizeFilePart(operationId || "unknown");
  const dir = path.join(PROJECT_DIR, "tmp", "pdf-ui-debug", safeOperationId);
  await ensureDir(dir);
  const pdfResponseCount = finalNetwork.filter((item) => item.kind === "response" && /application\/pdf/i.test(String(item.contentType || ""))).length
    + finalNetwork.filter((item) => item.kind === "download" && /\.pdf(?:\?|$)/i.test(String(item.url || ""))).length;
  const blobResponseCount = finalNetwork.filter((item) => /blob:/i.test(String(item.url || ""))).length;
  await writeJson(path.join(dir, "final-print-pages.json"), snapshot.pageSummaries || []).catch(() => {});
  await writeJson(path.join(dir, "final-print-frames.json"), snapshot.frameSummaries || []).catch(() => {});
  await writeJson(path.join(dir, "print-target-meta.json"), {
    operationId,
    candidatesChecked: snapshot.candidatesChecked || [],
    rejections: snapshot.rejections || [],
    pagesCount: (snapshot.pageSummaries || []).length,
    framesCount: (snapshot.frameSummaries || []).length,
    pdfResponseCount,
    blobResponseCount,
    finalNetworkCount: finalNetwork.length,
  }).catch(() => {});
}

async function writePrintTargetMeta(operationId, meta) {
  const safeOperationId = sanitizeFilePart(operationId || "unknown");
  const dir = path.join(PROJECT_DIR, "tmp", "pdf-ui-debug", safeOperationId);
  await ensureDir(dir);
  await writeJson(path.join(dir, "print-target-meta.json"), meta).catch(() => {});
}

async function waitWithLog(label, promiseFactory, timeoutMs = 5_000) {
  console.log(`[WAIT] ${label} start`);
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      clearTimeout(timer);
      reject(new Error(`${label} timeout`));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([promiseFactory(), timeout]);
    console.log(`[WAIT] ${label} resolved`);
    return result;
  } catch (error) {
    console.log(`[WAIT] ${label} timeout`);
    throw error;
  }
}

async function withTimeout(label, promise, timeoutMs = 5_000) {
  console.log(`[WAIT] ${label} start`);
  let timer = null;
  try {
    const result = await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
      }),
    ]);
    console.log(`[WAIT] ${label} resolved`);
    return result;
  } catch (error) {
    console.log(`[WAIT] ${label} timeout`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function dumpPrintPageValidation(page, operationId, stage, validation, extra = {}) {
  const safeOperationId = sanitizeFilePart(operationId || "unknown");
  const dir = path.join(PROJECT_DIR, "tmp", "pdf-ui-debug", safeOperationId);
  await ensureDir(dir);
  await writeJson(path.join(dir, `${sanitizeFilePart(stage || "print-validation")}.json`), {
    stage,
    url: page.url(),
    validation,
    ...extra,
  }).catch(() => {});
}

async function collectPrintPagesAndFrames(context, mainPage, finalNetwork = []) {
  const pages = context.pages().filter((item) => !item.isClosed());
  const pageSummaries = [];
  const frameSummaries = [];
  const pdfResponseCount = finalNetwork.filter((item) => item.kind === "response" && /application\/pdf/i.test(String(item.contentType || ""))).length
    + finalNetwork.filter((item) => item.kind === "download" && /\.pdf(?:\?|$)/i.test(String(item.url || ""))).length;
  const blobResponseCount = finalNetwork.filter((item) => /blob:/i.test(String(item.url || ""))).length;

  for (const currentPage of pages) {
    pageSummaries.push({
      url: currentPage.url(),
      isMain: currentPage === mainPage,
      title: await currentPage.title().catch(() => ""),
      dialogCount: await currentPage.locator('[role="dialog"], [aria-modal="true"]').count().catch(() => 0),
    });

    const frames = currentPage.frames ? currentPage.frames() : [];
    for (const frame of frames) {
      let text = "";
      let url = "";
      let sameOrigin = true;
      let hasCanvas = false;
      let hasSvg = false;
      let hasDataImage = false;
      let hasGtin = false;
      let hasKmLabel = false;
      let hasDataMatrix = false;
      let longStrings = [];
      try {
        url = frame.url() || "";
        const frameLoc = frame.locator ? frame.locator("body") : null;
        text = frameLoc ? String(await frameLoc.innerText().catch(() => "")) : "";
        hasCanvas = await frame.locator("canvas").count().catch(() => 0) > 0;
        hasSvg = await frame.locator("svg").count().catch(() => 0) > 0;
        hasDataImage = await frame.locator('img[src^="data:image"], [style*="data:image"], [style*="base64"]').count().catch(() => 0) > 0;
        hasGtin = /\bGTIN\b/i.test(text);
        hasKmLabel = /Код маркировки|маркировк/i.test(text);
        hasDataMatrix = /DataMatrix|Data matrix/i.test(text);
        longStrings = text.match(/\b(?:\d{14,}|[A-Z0-9]{16,}|01\d{14,})\b/g) || [];
      } catch (error) {
        sameOrigin = false;
      }
      frameSummaries.push({
        pageUrl: currentPage.url(),
        frameUrl: url,
        sameOrigin,
        hasCanvas,
        hasSvg,
        hasDataImage,
        hasGtin,
        hasKmLabel,
        hasDataMatrix,
        longStrings,
        textSnippet: text.slice(0, 500),
      });
    }
  }

  return { pageSummaries, frameSummaries, pdfResponseCount, blobResponseCount };
}

async function saveValidatedPrintPagePdf(page, targetPath, operationId, stage = "validated-print-page") {
  const validation = await validatePrintPageHasKmLabels(page);
  await dumpPrintPageValidation(page, operationId, stage, validation).catch(() => {});
  if (!validation.valid) {
    return { saved: false, validation };
  }

  if (typeof page.pdf !== "function") {
    await dumpDebug(page, operationId, "PRINT_PAGE_TO_PDF_FALLBACK_UNAVAILABLE").catch(() => {});
    throw new Error("PRINT_PAGE_TO_PDF_FALLBACK_UNAVAILABLE");
  }

  await page.emulateMedia({ media: "print" }).catch(() => {});
  await page.pdf({
    path: targetPath,
    width: "58mm",
    height: "40mm",
    printBackground: true,
    margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
  });

  const stat = await fs.stat(targetPath).catch(() => null);
  if (!stat || !stat.isFile() || stat.size <= 0) {
    await dumpDebug(page, operationId, "PRINT_PAGE_TO_PDF_FALLBACK_EMPTY").catch(() => {});
    throw new Error("PRINT_PAGE_TO_PDF_FALLBACK_EMPTY");
  }

  const handle = await fs.open(targetPath, "r");
  try {
    const buffer = Buffer.alloc(4);
    await handle.read(buffer, 0, 4, 0);
    if (buffer.toString("utf8") !== "%PDF") {
      const bytes = await fs.readFile(targetPath);
      const preview = bytes.toString("utf8").slice(0, 5000);
      await fs.writeFile(path.join(path.dirname(targetPath), "downloaded-not-pdf.txt"), preview, "utf8").catch(() => {});
      await dumpDebug(page, operationId, "PRINT_PAGE_TO_PDF_FALLBACK_NOT_PDF").catch(() => {});
      throw new Error("PRINT_PAGE_TO_PDF_FALLBACK_NOT_PDF");
    }
  } finally {
    await handle.close().catch(() => {});
  }

  console.log("[PRINT_RESULT] saved_validated_print_pdf");
  return { saved: true, validation };
}

async function inspectPrintTargets(context, mainPage, operationId, targetPath, stage = "after-print", finalNetwork = []) {
  const snapshot = await collectPrintPagesAndFrames(context, mainPage, finalNetwork).catch(() => ({
    pageSummaries: [],
    frameSummaries: [],
    pdfResponseCount: 0,
    blobResponseCount: 0,
  }));
  const pages = context.pages().filter((item) => !item.isClosed());
  const candidatesChecked = [];
  const rejections = [];
  let savedResult = null;
  for (const currentPage of pages) {
    const isMain = currentPage === mainPage;
    if (!isMain) {
      console.log("[PRINT_RESULT] popup");
      console.log("[PRINT_RESULT] popup url:", currentPage.url() || "(empty)");
      await waitWithLog("popup.domcontentloaded", () => currentPage.waitForLoadState("domcontentloaded", { timeout: 4_000 }), 4_000).catch(() => {});
      await waitWithLog("popup.networkidle", () => currentPage.waitForLoadState("networkidle", { timeout: 4_000 }), 4_000).catch(() => {});
      await dumpVisibleUi(currentPage, operationId, `popup-${stage}`).catch(() => {});
    }

    const validation = await validatePrintPageHasKmLabels(currentPage);
    candidatesChecked.push({
      url: currentPage.url(),
      isMain,
      valid: validation.valid,
      reasons: validation.reasons || [],
      labelSignals: validation.labelSignals || 0,
      hasCanvas: Boolean(validation.hasCanvas),
      hasSvg: Boolean(validation.hasSvg),
      hasDataImage: Boolean(validation.hasDataImage),
      hasGtin: Boolean(validation.hasGtin),
      hasKmLabel: Boolean(validation.hasKmLabel),
      hasDataMatrix: Boolean(validation.hasDataMatrix),
      longStrings: validation.longStrings || [],
    });
    await dumpPrintPageValidation(currentPage, operationId, `${stage}${isMain ? "-main" : "-popup"}`, validation, {
      isMain,
      url: currentPage.url(),
    }).catch(() => {});

    if (!validation.valid) {
      rejections.push({
        url: currentPage.url(),
        isMain,
        reasons: validation.reasons || ["invalid"],
      });
      if (!isMain) {
        const clicked = await clickPdfActionFallback(currentPage).catch(() => false);
        if (clicked) {
          console.log("[PRINT_RESULT] popup-action-clicked");
        }
      }
      continue;
    }

    const metaBase = {
      operationId,
      stage,
      candidatesChecked,
      pagesCount: snapshot.pageSummaries.length,
      framesCount: snapshot.frameSummaries.length,
      pdfResponseCount: snapshot.pdfResponseCount,
      blobResponseCount: snapshot.blobResponseCount,
      finalNetworkCount: finalNetwork.length,
    };
    await savePrintTargetArtifacts(currentPage, operationId, targetPath, validation, "print-target", {
      candidatesChecked,
      rejections,
      pagesCount: snapshot.pageSummaries.length,
      framesCount: snapshot.frameSummaries.length,
      pdfResponseCount: snapshot.pdfResponseCount,
      blobResponseCount: snapshot.blobResponseCount,
    }).catch(() => {});
    const result = await saveValidatedPrintPagePdf(currentPage, targetPath, operationId, `${stage}${isMain ? "-main" : "-popup"}`);
    if (result?.saved) {
      savedResult = result;
      await saveFinalPrintSnapshot(operationId, {
        pageSummaries: snapshot.pageSummaries,
        frameSummaries: snapshot.frameSummaries,
        candidatesChecked,
        rejections,
      }, finalNetwork).catch(() => {});
      await writePrintTargetMeta(operationId, {
        ...metaBase,
        error: null,
        filesWritten: ["print-target.pdf", "print-target-meta.json", "final-print-pages.json", "final-print-frames.json"],
        validation: result.validation || null,
      }).catch(() => {});
      try {
        await fs.copyFile(targetPath, path.join(path.dirname(targetPath), "print-target.pdf"));
      } catch (error) {
        console.log(`[PRINT_RESULT] print-target-copy-failed: ${error?.message || error}`);
      }
      return result;
    }
  }

  await writePrintTargetMeta(operationId, {
    operationId,
    stage,
    error: {
      name: "PRINT_TARGET_NOT_FOUND",
      message: "No valid KM label target found after print click",
    },
    candidatesChecked,
    pagesCount: snapshot.pageSummaries.length,
    framesCount: snapshot.frameSummaries.length,
    pdfResponseCount: snapshot.pdfResponseCount,
    blobResponseCount: snapshot.blobResponseCount,
    finalNetworkCount: finalNetwork.length,
    filesWritten: ["final-print-network.json", "final-print-pages.json", "final-print-frames.json"],
    validation: null,
  }).catch(() => {});
  await saveFinalPrintSnapshot(operationId, {
    pageSummaries: snapshot.pageSummaries,
    frameSummaries: snapshot.frameSummaries,
    candidatesChecked,
    rejections,
  }, finalNetwork).catch(() => {});
  return { saved: false, validation: null };
}

function isForbiddenPdfDownloadUrl(url) {
  if (!url) return false;
  return /marking_codes|\/csv(?:\?|$)|\/txt(?:\?|$)|codes/i.test(String(url));
}

function isForbiddenPdfFilename(name) {
  if (!name) return false;
  return /marking_codes|codes|csv|txt/i.test(String(name));
}

function isPdfContentType(contentType) {
  return /application\/pdf/i.test(String(contentType || ""));
}

function isPdfUrl(url) {
  return /\.pdf(?:\?|$)/i.test(String(url || "")) || /^blob:/i.test(String(url || ""));
}

async function armPrintHook(page) {
  await page.addInitScript(() => {
    window.__PRINT_CALLED__ = false;
    const oldPrint = window.print;
    window.print = function patchedPrint(...args) {
      window.__PRINT_CALLED__ = true;
      return oldPrint.apply(window, args);
    };
  }).catch(() => {});

  await page.evaluate(() => {
    window.__PRINT_CALLED__ = false;
    const oldPrint = window.print;
    window.print = function patchedPrint(...args) {
      window.__PRINT_CALLED__ = true;
      return oldPrint.apply(window, args);
    };
  }).catch(() => {});
}

async function clickPdfActionFallback(page) {
  const candidates = [
    page.getByRole("button", { name: /скачать.*pdf/i }),
    page.getByRole("button", { name: /pdf/i }),
    page.getByRole("link", { name: /скачать.*pdf/i }),
    page.getByRole("link", { name: /pdf/i }),
    page.getByText(/скачать.*pdf/i),
    page.getByText(/\bpdf\b/i),
    page.locator('a,button,[role="button"],[role="link"]').filter({ hasText: /pdf|скачать|download/i }),
  ];

  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = candidate.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      await item.scrollIntoViewIfNeeded().catch(() => {});
      await item.click({ force: true }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function clickPdfActionAcrossPages(context) {
  const pages = context.pages().filter((page) => !page.isClosed());
  for (const page of pages) {
    const clicked = await clickPdfActionFallback(page).catch(() => false);
    if (clicked) return true;
  }
  return false;
}

function createDebugCollector(page) {
  const consoleLogs = [];
  const networkLogs = [];

  const onConsole = (message) => {
    consoleLogs.push({
      type: "console",
      text: message.text(),
      location: message.location(),
      args: message.args().map((arg) => arg.toString()),
    });
  };

  const onRequest = (request) => {
    const url = request.url();
    if (!url.includes(BASE_URL)) return;
    networkLogs.push({
      kind: "request",
      method: request.method(),
      url,
      resourceType: request.resourceType(),
      postData: request.postData() || "",
    });
  };

  const onResponse = async (response) => {
    const url = response.url();
    if (!url.includes(BASE_URL)) return;
    networkLogs.push({
      kind: "response",
      status: response.status(),
      url,
      contentType: response.headers()["content-type"] || "",
    });
  };

  page.on("console", onConsole);
  page.on("request", onRequest);
  page.on("response", onResponse);

  return {
    consoleLogs,
    networkLogs,
    detach() {
      page.off("console", onConsole);
      page.off("request", onRequest);
      page.off("response", onResponse);
    },
  };
}

async function savePdfBuffer(buffer, targetPath) {
  if (!buffer || !buffer.length) {
    throw new Error(`Downloaded PDF is empty: ${targetPath}`);
  }

  const prefix = buffer.subarray(0, 4).toString("utf8");
  const preview = buffer.toString("utf8").slice(0, 5000);
  if (prefix === "%PDF") {
    await fs.writeFile(targetPath, buffer);
    return { isPdf: true, path: targetPath, preview, prefix };
  }

  const notPdfPath = path.join(path.dirname(targetPath), "downloaded-not-pdf.txt");
  await fs.writeFile(notPdfPath, preview, "utf8").catch(() => {});
  return { isPdf: false, path: notPdfPath, preview, prefix };
}

async function savePdfDownload(download, targetPath) {
  const tempPath = `${targetPath}.download.tmp`;
  await download.saveAs(tempPath);
  const stat = await fs.stat(tempPath);
  if (!stat.isFile() || stat.size <= 0) {
    await fs.unlink(tempPath).catch(() => {});
    throw new Error(`Downloaded PDF is empty: ${targetPath}`);
  }

  const buffer = await fs.readFile(tempPath);
  await fs.unlink(tempPath).catch(() => {});
  return savePdfBuffer(buffer, targetPath);
}

async function captureDownloadDetails(download) {
  const suggestedFilename = typeof download.suggestedFilename === "function"
    ? download.suggestedFilename()
    : "";
  const downloadUrl = typeof download.url === "function"
    ? download.url()
    : "";
  return { suggestedFilename, downloadUrl };
}

async function captureUiDebug(page, operationId, reason, debugState = {}, modalLocator = null) {
  const safeOperationId = sanitizeFilePart(operationId || "unknown");
  const dir = path.join(PROJECT_DIR, "tmp", "debug-pdf", safeOperationId);
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, "page.html"), await page.content(), "utf8");
  await page.screenshot({ path: path.join(dir, "page.png"), fullPage: true }).catch(() => {});
  if (modalLocator && await modalLocator.count().catch(() => 0)) {
    const first = modalLocator.first();
    if (await first.isVisible().catch(() => false)) {
      const modalHtml = await first.evaluate((el) => el.outerHTML).catch(() => "");
      if (modalHtml) {
        await fs.writeFile(path.join(dir, "modal.html"), modalHtml, "utf8").catch(() => {});
      }
    }
  }

  const controls = await page.evaluate(() => {
    const serialize = (el, index) => {
      const dataAttributes = {};
      for (const attr of Array.from(el.attributes || [])) {
        if (attr.name.startsWith("data-")) dataAttributes[attr.name] = attr.value;
      }
      const style = window.getComputedStyle(el);
      const visible = style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
      return {
        index,
        tagName: el.tagName,
        id: el.id || "",
        className: el.className || "",
        textContent: String(el.textContent || "").replace(/\s+/g, " ").trim(),
        value: "value" in el ? String(el.value || "") : "",
        role: el.getAttribute("role") || "",
        "aria-label": el.getAttribute("aria-label") || "",
        "aria-expanded": el.getAttribute("aria-expanded") || "",
        "aria-haspopup": el.getAttribute("aria-haspopup") || "",
        title: el.getAttribute("title") || "",
        disabled: Boolean(el.disabled),
        hidden: Boolean(el.hidden),
        visible,
        dataAttributes,
      };
    };
    return Array.from(document.querySelectorAll("input,button,div,label,select"))
      .filter((el) => el && el.getClientRects && el.getClientRects().length > 0)
      .map(serialize);
  }).catch(() => []);

  const options = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll('[role="option"], [id*="option"]'));
    return elements
      .filter((el) => el && el.getClientRects && el.getClientRects().length > 0)
      .map((el, index) => {
        const dataAttributes = {};
        for (const attr of Array.from(el.attributes || [])) {
          if (attr.name.startsWith("data-")) dataAttributes[attr.name] = attr.value;
        }
        const style = window.getComputedStyle(el);
        return {
          index,
          tagName: el.tagName,
          id: el.id || "",
          className: el.className || "",
          textContent: String(el.textContent || "").replace(/\s+/g, " ").trim(),
          value: "value" in el ? String(el.value || "") : "",
          role: el.getAttribute("role") || "",
          "aria-label": el.getAttribute("aria-label") || "",
          "aria-expanded": el.getAttribute("aria-expanded") || "",
          "aria-haspopup": el.getAttribute("aria-haspopup") || "",
          title: el.getAttribute("title") || "",
          disabled: Boolean(el.disabled),
          hidden: Boolean(el.hidden),
          visible: style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0",
          dataAttributes,
        };
      });
  }).catch(() => []);

  const visibleButtons = await page.evaluate(() => Array.from(document.querySelectorAll("button"))
    .filter((el) => el && el.getClientRects && el.getClientRects().length > 0)
    .map((el, index) => ({
      index,
      text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
      ariaLabel: el.getAttribute("aria-label") || "",
      title: el.getAttribute("title") || "",
    }))
  ).catch(() => []);
  const visibleComboboxes = await page.evaluate(() => Array.from(document.querySelectorAll('input[role="combobox"], select, [role="combobox"]'))
    .filter((el) => el && el.getClientRects && el.getClientRects().length > 0)
    .map((el, index) => ({
      index,
      tagName: el.tagName,
      text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
      value: "value" in el ? String(el.value || "") : "",
      ariaLabel: el.getAttribute("aria-label") || "",
      title: el.getAttribute("title") || "",
      role: el.getAttribute("role") || "",
    }))
  ).catch(() => []);

  await writeJson(path.join(dir, "controls.json"), { reason, controls });
  await writeJson(path.join(dir, "options.json"), { reason, options });
  await writeText(path.join(dir, "visible_buttons.txt"), visibleButtons.map((item) => `${item.index}\t${item.text}\t${item.ariaLabel}\t${item.title}`).join("\n"));
  await writeText(path.join(dir, "visible_comboboxes.txt"), visibleComboboxes.map((item) => `${item.index}\t${item.tagName}\t${item.text}\t${item.value}\t${item.ariaLabel}\t${item.title}\t${item.role}`).join("\n"));
  if (debugState.consoleLogs) {
    await writeJson(path.join(dir, "console.json"), { reason, consoleLogs: debugState.consoleLogs });
  }
  if (debugState.networkLogs) {
    await writeJson(path.join(dir, "network.json"), { reason, networkLogs: debugState.networkLogs });
  }
}

async function dumpDebug(page, operationId, reason) {
  await captureUiDebug(page, operationId, reason, createDebugCollector(page), null).catch(() => {});
}

async function dumpVisibleUi(page, operationId, stage) {
  const safeOperationId = sanitizeFilePart(operationId || "unknown");
  const dir = path.join(PROJECT_DIR, "tmp", "pdf-ui-debug", safeOperationId);
  await ensureDir(dir);

  const fileStage = sanitizeFilePart(stage || "stage");
  await fs.writeFile(path.join(dir, `${fileStage}.html`), await page.content(), "utf8").catch(() => {});
  await page.screenshot({ path: path.join(dir, `${fileStage}.png`), fullPage: true }).catch(() => {});

  const visibleButtons = await page.evaluate(() => Array.from(document.querySelectorAll("button"))
    .filter((el) => el && el.getClientRects && el.getClientRects().length > 0)
    .map((el, index) => ({
      index,
      text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
      ariaLabel: el.getAttribute("aria-label") || "",
      title: el.getAttribute("title") || "",
      id: el.id || "",
      className: el.className || "",
    }))
  ).catch(() => []);
  await writeText(
    path.join(dir, `${fileStage}.buttons.txt`),
    visibleButtons.map((item) => `${item.index}\t${item.text}\t${item.ariaLabel}\t${item.title}\t${item.id}\t${item.className}`).join("\n"),
  );

  const visibleTexts = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll("body *"))
      .filter((el) => el && el.getClientRects && el.getClientRects().length > 0)
      .map((el) => String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    return Array.from(new Set(nodes));
  }).catch(() => []);
  await writeText(path.join(dir, `${fileStage}.texts.txt`), visibleTexts.join("\n"));

  const controls = await page.evaluate(() => Array.from(document.querySelectorAll("input,select,button,[role='option'],[role='combobox']"))
    .filter((el) => el && el.getClientRects && el.getClientRects().length > 0)
    .map((el, index) => ({
      index,
      tagName: el.tagName,
      text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
      value: "value" in el ? String(el.value || "") : "",
      role: el.getAttribute("role") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      title: el.getAttribute("title") || "",
      disabled: Boolean(el.disabled),
      hidden: Boolean(el.hidden),
      className: el.className || "",
      id: el.id || "",
    }))
  ).catch(() => []);
  await writeJson(path.join(dir, `${fileStage}.controls.json`), controls);

  const options = await page.evaluate(() => Array.from(document.querySelectorAll('[role="option"], [id*="option"], select option'))
    .filter((el) => el && el.getClientRects && el.getClientRects().length > 0)
    .map((el, index) => ({
      index,
      tagName: el.tagName,
      text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
      value: "value" in el ? String(el.value || "") : "",
      role: el.getAttribute("role") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      title: el.getAttribute("title") || "",
      disabled: Boolean(el.disabled),
      hidden: Boolean(el.hidden),
      className: el.className || "",
      id: el.id || "",
    }))
  ).catch(() => []);
  await writeJson(path.join(dir, `${fileStage}.options.json`), options);

  const meta = {
    stage,
    url: page.url(),
    dialogCount: await page.locator('[role="dialog"], [aria-modal="true"]').count().catch(() => 0),
    buttons: visibleButtons.length,
    controls: controls.length,
    options: options.length,
  };
  await writeJson(path.join(dir, `${fileStage}.meta.json`), meta);
  console.log(`[DEBUG_UI] saved ${fileStage} -> ${dir}`);
}

async function dumpFinalPrintButtons(page, operationId, modalLocator = null, stage = "final-print") {
  const safeOperationId = sanitizeFilePart(operationId || "unknown");
  const dir = path.join(PROJECT_DIR, "tmp", "pdf-ui-debug", safeOperationId);
  await ensureDir(dir);

  const scope = modalLocator && await modalLocator.count().catch(() => 0) ? modalLocator.first() : page;
  const buttons = await scope.locator("button").evaluateAll((nodes) =>
    nodes.map((b, index) => {
      const style = window.getComputedStyle(b);
      return {
        index,
        text: String(b.innerText || b.textContent || "").replace(/\s+/g, " ").trim(),
        role: b.getAttribute("role") || "",
        ariaLabel: b.getAttribute("aria-label") || "",
        title: b.getAttribute("title") || "",
        disabled: Boolean(b.disabled),
        hidden: Boolean(b.hidden),
        visible: style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && !!(b.offsetWidth || b.offsetHeight || b.getClientRects().length),
        outerHTML: b.outerHTML,
      };
    }),
  ).catch(() => []);

  await writeText(
    path.join(dir, "final-print-buttons.txt"),
    buttons.map((item) => `${item.index}\t${item.text}\t${item.role}\t${item.ariaLabel}\t${item.title}\t${item.disabled}\t${item.hidden}\t${item.visible}`).join("\n"),
  );
  await writeJson(path.join(dir, "final-print-buttons.json"), { stage, buttons });
}

async function captureOperationNotFoundDebug(page, operationId, reason, debugState = {}) {
  const safeOperationId = sanitizeFilePart(operationId || "unknown");
  const dir = path.join(PROJECT_DIR, "tmp", "debug-pdf", safeOperationId);
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, "operation_not_found.html"), await page.content(), "utf8");
  await page.screenshot({ path: path.join(dir, "operation_not_found.png"), fullPage: true }).catch(() => {});
  const controls = await page.evaluate(() => {
    const serialize = (el, index) => {
      const dataAttributes = {};
      for (const attr of Array.from(el.attributes || [])) {
        if (attr.name.startsWith("data-")) dataAttributes[attr.name] = attr.value;
      }
      return {
        index,
        tagName: el.tagName,
        id: el.id || "",
        className: el.className || "",
        textContent: String(el.textContent || "").replace(/\s+/g, " ").trim(),
        value: "value" in el ? String(el.value || "") : "",
        role: el.getAttribute("role") || "",
        "aria-label": el.getAttribute("aria-label") || "",
        "aria-expanded": el.getAttribute("aria-expanded") || "",
        "aria-haspopup": el.getAttribute("aria-haspopup") || "",
        disabled: Boolean(el.disabled),
        hidden: Boolean(el.hidden),
        dataAttributes,
      };
    };
    return Array.from(document.querySelectorAll("input,button,div,label,select"))
      .filter((el) => el && el.getClientRects && el.getClientRects().length > 0)
      .map(serialize);
  }).catch(() => []);
  await writeJson(path.join(dir, "operation_not_found.controls.json"), { reason, controls });
  if (debugState.consoleLogs) {
    await writeJson(path.join(dir, "console.json"), { reason, consoleLogs: debugState.consoleLogs });
  }
  if (debugState.networkLogs) {
    await writeJson(path.join(dir, "network.json"), { reason, networkLogs: debugState.networkLogs });
  }
}

async function resolveTemplateControl(page) {
  const candidates = [
    page.locator('#react-select-printForm-template-input'),
    page.locator('input[id*="printForm-template"][role="combobox"]'),
    page.locator('input[role="combobox"]').nth(1),
    page.locator('input[role="combobox"]').last(),
    page.getByText("Шаблон", { exact: false }).locator('xpath=following::input[role="combobox"][1]'),
    page.locator('[id*="printForm-template"]').locator('input[role="combobox"]').first(),
    page.locator('[aria-label*="Шаблон" i]'),
    page.locator('div.template_select').filter({ hasText: /Шаблон/i }).locator('.react-select__control').first(),
    page.locator('div.template_select .react-select__control').nth(1),
    page.locator('div.react-select--is-disabled + .react-select__control'),
    page.getByText("Шаблон", { exact: false }).locator('xpath=following::div[contains(@class,"react-select__control")][1]'),
  ];

  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    if (!count) continue;
    const item = candidate.first();
    if (await item.isVisible().catch(() => false)) return item;
  }

  const visibleComboboxes = await getVisibleComboboxes(page);
  if (visibleComboboxes.length >= 2) return visibleComboboxes[1];
  return visibleComboboxes.at(-1) || null;
}

function isMeaningfulTemplateValue(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  if (/^шаблон$/i.test(normalized)) return false;
  if (/^формат файла$/i.test(normalized)) return false;
  if (/^количество$/i.test(normalized)) return false;
  if (/^печать$/i.test(normalized)) return false;
  if (/^отменить$/i.test(normalized)) return false;
  if (/^csv файл$/i.test(normalized)) return false;
  return true;
}

async function getTemplateSelectedValue(page) {
  const selectors = [
    'div.template_select .react-select__single-value',
    '[id*="printForm-template"] .react-select__single-value',
    'div.template_select .react-select__control',
    '[id*="printForm-template"] .react-select__control',
    'div.template_select',
    '[id*="printForm-template"]',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      const text = normalizeText(await item.innerText().catch(() => ""));
      if (isMeaningfulTemplateValue(text)) {
        return text;
      }
    }
  }

  const visibleComboboxes = await getVisibleComboboxes(page);
  for (const combobox of visibleComboboxes) {
    const value = normalizeText(await combobox.inputValue().catch(() => ""));
    if (isMeaningfulTemplateValue(value)) return value;
  }

  return null;
}

async function templateIsSelected(page) {
  return Boolean(await getTemplateSelectedValue(page));
}

async function selectTemplate(page, operationId = "unknown") {
  await page.waitForTimeout(3000);
  await page.getByText("Шаблон", { exact: false }).first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  await page.waitForSelector(
    '#react-select-printForm-template-input, input[id*="printForm-template"][role="combobox"], input[role="combobox"]',
    { state: "attached", timeout: 10_000 },
  ).catch(() => {});
  await page.waitForFunction(() => {
    const text = document.body?.innerText || "";
    const label = /Шаблон/i.test(text);
    const input = document.querySelector('#react-select-printForm-template-input');
    const control = document.querySelector('div.template_select .react-select__control') || document.querySelector('[id*="printForm-template"] .react-select__control');
    const enabled = control && !String(control.className || "").includes("react-select__control--is-disabled");
    return label && (enabled || (input && !input.disabled));
  }, { timeout: 15_000 }).catch(() => {});

  const alreadySelectedValue = await getTemplateSelectedValue(page);
  if (alreadySelectedValue) {
    console.log(`[TEMPLATE] already selected: ${alreadySelectedValue}`);
    return true;
  }

  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const selectedBeforeAttempt = await getTemplateSelectedValue(page);
    if (selectedBeforeAttempt) {
      console.log(`[TEMPLATE] already selected: ${selectedBeforeAttempt}`);
      return true;
    }

    const templateControl = await resolveTemplateControl(page);
    if (!templateControl) {
      await sleep(1000);
      continue;
    }

    await templateControl.scrollIntoViewIfNeeded().catch(() => {});
    await templateControl.click({ force: true }).catch(() => {});
    if (await templateControl.evaluate((el) => el.tagName === "INPUT").catch(() => false)) {
      await templateControl.fill("Data matrix").catch(() => {});
    } else {
      await page.keyboard.type("Data matrix", { delay: 20 }).catch(() => {});
    }
    await sleep(1000);

    let options = await collectVisibleOptions(page);
    const patterns = [/Data matrix.*горизонтальный.*описанием/i, /горизонтальный.*описанием/i];
    const optionTexts = options.map((option) => option.text);
    const match = optionTexts.find((text) => patterns.some((regex) => regex.test(text)));
    if (match) {
      const option = page.getByText(match, { exact: false }).last();
      if (await option.count().catch(() => 0)) {
        await option.click({ force: true }).catch(() => {});
        await sleep(500);
      }
    } else {
      const pageText = normalizeText(await page.locator("body").innerText().catch(() => ""));
      const pageMatch = [
        /горизонтальный.*описанием товара/i,
        /горизонтальный/i,
        /описанием товара/i,
      ].some((regex) => regex.test(pageText));
      if (pageMatch) {
        return true;
      }
      await page.keyboard.press("ArrowDown").catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
      await sleep(500);
    }

    if (await templateIsSelected(page)) {
      return true;
    }

    options = await collectVisibleOptions(page);
    if (options.some((option) => patterns.some((regex) => regex.test(option.text)))) {
      return true;
    }

    await sleep(1000);
  }

  await dumpComboboxSnapshot(page, operationId, "combo-0").catch(() => {});
  await dumpComboboxSnapshot(page, operationId, "combo-1").catch(() => {});
  throw new Error("KM_PDF_TEMPLATE_SELECTION_FAILED");
}

async function clickPrintAndSave(page, targetPath, operationId = "unknown", triggerFn = null) {
  const context = page.context();
  const events = [];
  const attached = new Map();
  let printedLogged = false;
  const finalNetwork = [];

  const pushEvent = (type, payload = {}) => {
    events.push({ type, ...payload });
  };

  const attachWatchers = (targetPage, label) => {
    if (!targetPage || attached.has(targetPage)) return;
    const requestHandler = (request) => {
      finalNetwork.push({
        kind: "request",
        label,
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        postData: request.postData() || "",
      });
    };
    const downloadHandler = (download) => pushEvent("download", { download, label });
    const responseHandler = (response) => {
      const request = response.request?.();
      finalNetwork.push({
        kind: "response",
        label,
        method: request?.method?.() || "GET",
        url: response.url(),
        status: response.status(),
        contentType: response.headers()["content-type"] || "",
        contentDisposition: response.headers()["content-disposition"] || "",
      });
      pushEvent("response", { response, label });
    };
    targetPage.on("request", requestHandler);
    targetPage.on("download", downloadHandler);
    targetPage.on("response", responseHandler);
    attached.set(targetPage, { requestHandler, downloadHandler, responseHandler, label });
  };

  const detachWatchers = () => {
    for (const [targetPage, handlers] of attached.entries()) {
      targetPage.off("request", handlers.requestHandler);
      targetPage.off("download", handlers.downloadHandler);
      targetPage.off("response", handlers.responseHandler);
    }
    attached.clear();
  };

  const onPopup = (popup) => {
    attachWatchers(popup, "popup");
    pushEvent("popup", { page: popup });
  };
  const onContextResponse = (response) => {
    const url = response.url();
    if (!url || !url.includes(BASE_URL)) return;
    finalNetwork.push({
      kind: "context-response",
      method: response.request?.().method?.() || "GET",
      url,
      status: response.status(),
      contentType: response.headers()["content-type"] || "",
      contentDisposition: response.headers()["content-disposition"] || "",
    });
  };

  attachWatchers(page, "main");
  context.on("page", onPopup);
  context.on("response", onContextResponse);
  page.on("popup", onPopup);
  await armPrintHook(page);
  const printStartedAt = Date.now();
  let inspectedPrintTargets = false;

  try {
    if (typeof triggerFn === "function") {
      await triggerFn();
    }

    console.log("[AFTER_WINDOW_PRINT_CONTINUE]");
    console.log("[WAIT] dump after-final-print-click start");
    await waitWithLog("dump.after-final-print-click.visible-ui", () => dumpVisibleUi(page, operationId, "after-final-print-click"), 4_000).catch(() => {});
    console.log("[WAIT] dump after-final-print-click buttons start");
    await waitWithLog("dump.after-final-print-click.buttons", () => dumpFinalPrintButtons(page, operationId, null, "after-final-print-click"), 4_000).catch(() => {});
    console.log("[WAIT] dump after-window-print-called start");
    await waitWithLog("dump.after-window-print-called.visible-ui", () => dumpVisibleUi(page, operationId, "after-window-print-called"), 4_000).catch(() => {});
    console.log("[AFTER_DUMP_DEBUG_CONTINUE]");
    console.log("[BEFORE_INSPECT_PRINT_TARGETS]");

    let lastPrintSnapshot = null;
    try {
      lastPrintSnapshot = await withTimeout(
        "inspectPrintTargets",
        inspectPrintTargets(context, page, operationId, targetPath, "after-window-print-called", finalNetwork),
        8_000,
      );
    } catch (error) {
      console.log(`[WAIT] inspectPrintTargets error: ${error?.message || error}`);
    }

    if (!lastPrintSnapshot || !lastPrintSnapshot.saved) {
      const snapshot = await collectPrintPagesAndFrames(context, page, finalNetwork).catch(() => ({
        pageSummaries: [],
        frameSummaries: [],
        pdfResponseCount: 0,
        blobResponseCount: 0,
      }));
      await writeJson(path.join(path.dirname(targetPath), "final-print-network.json"), finalNetwork).catch(() => {});
      await writeJson(path.join(path.dirname(targetPath), "final-print-pages.json"), snapshot.pageSummaries || []).catch(() => {});
      await writeJson(path.join(path.dirname(targetPath), "final-print-frames.json"), snapshot.frameSummaries || []).catch(() => {});
      await writePrintTargetMeta(operationId, {
        operationId,
        stage: "post-inspect",
        error: {
          name: "PRINT_TARGET_NOT_FOUND",
          message: "inspectPrintTargets did not find a valid KM label target",
        },
        candidatesChecked: [],
        pagesCount: snapshot.pageSummaries.length,
        framesCount: snapshot.frameSummaries.length,
        pdfResponseCount: snapshot.pdfResponseCount,
        blobResponseCount: snapshot.blobResponseCount,
        finalNetworkCount: finalNetwork.length,
        filesWritten: ["final-print-network.json", "final-print-pages.json", "final-print-frames.json"],
        validation: null,
      }).catch(() => {});
      await dumpDebug(page, operationId, "PRINT_TARGET_NOT_FOUND").catch(() => {});
      throw new Error("PRINT_TARGET_NOT_FOUND");
    }

    const deadline = Date.now() + DOWNLOAD_TIMEOUT;
    while (Date.now() < deadline) {
      if (!printedLogged) {
        const printed = await page.evaluate(() => Boolean(window.__PRINT_CALLED__)).catch(() => false);
        if (printed) {
          console.log("[PRINT_RESULT] window-print-called");
          printedLogged = true;
        }
      }

      if (printedLogged && !inspectedPrintTargets) inspectedPrintTargets = true;

      const event = events.shift();
      if (!event) {
        await sleep(250);
        continue;
      }

      if (event.type === "download") {
        console.log("[PRINT_RESULT] download");
        const { suggestedFilename, downloadUrl } = await captureDownloadDetails(event.download);
        console.log("[DOWNLOAD] suggestedFilename:", suggestedFilename || "(empty)");
        console.log("[DOWNLOAD] url:", downloadUrl || "(empty)");
        finalNetwork.push({
          kind: "download",
          suggestedFilename: suggestedFilename || "",
          url: downloadUrl || "",
        });
        const result = await savePdfDownload(event.download, targetPath);
        console.log("[DOWNLOAD] first bytes:", result.prefix || "(empty)");
        const rejected = isForbiddenPdfDownloadUrl(downloadUrl) || isForbiddenPdfFilename(suggestedFilename) || !result.isPdf;
        if (!rejected) {
          console.log(`[PDF] found real pdf: ${targetPath}`);
          return true;
        }
        console.log("[DOWNLOAD] rejected as not pdf");
        const previewLines = normalizeText(result.preview || "").split(/\r?\n/).filter(Boolean).slice(0, 5);
        const notPdfPath = result.path || path.join(path.dirname(targetPath), "downloaded-not-pdf.txt");
        await fs.writeFile(notPdfPath, previewLines.join("\n"), "utf8").catch(() => {});
        for (const line of previewLines) console.log(line);
        await sleep(1500);
        continue;
      }

      if (event.type === "response") {
        const contentType = event.response.headers()["content-type"] || "";
        const responseUrl = event.response.url();
        if (isPdfContentType(contentType) || isPdfUrl(responseUrl)) {
          console.log("[PRINT_RESULT] pdf-response");
          const body = await event.response.body().catch(() => Buffer.alloc(0));
          const result = await savePdfBuffer(body, targetPath);
          console.log("[DOWNLOAD] first bytes:", result.prefix || "(empty)");
          if (result.isPdf) {
            console.log(`[PDF] found real pdf: ${targetPath}`);
            return true;
          }
          console.log("[DOWNLOAD] rejected as not pdf");
          const previewLines = normalizeText(result.preview || "").split(/\r?\n/).filter(Boolean).slice(0, 5);
          const notPdfPath = result.path || path.join(path.dirname(targetPath), "downloaded-not-pdf.txt");
          await fs.writeFile(notPdfPath, previewLines.join("\n"), "utf8").catch(() => {});
          for (const line of previewLines) console.log(line);
        }
        continue;
      }

      if (event.type === "popup") {
        const popupPage = event.page;
        console.log("[PRINT_RESULT] popup");
        await popupPage.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
        await popupPage.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
        const popupUrl = popupPage.url();
        console.log("[PRINT_RESULT] popup url:", popupUrl || "(empty)");
        if (isPdfUrl(popupUrl)) {
          console.log("[PRINT_RESULT] pdf-response");
        }
        const validation = await validatePrintPageHasKmLabels(popupPage);
        await dumpPrintPageValidation(popupPage, operationId, "popup-event", validation, { url: popupUrl }).catch(() => {});
        if (validation.valid) {
          const result = await saveValidatedPrintPagePdf(popupPage, targetPath, operationId, "popup-event");
          if (result?.saved) return true;
        } else {
          const clicked = await clickPdfActionFallback(popupPage).catch(() => false);
          if (!clicked) {
            await clickPdfActionAcrossPages(context).catch(() => false);
          }
        }
        continue;
      }
    }
    console.log("[PRINT_RESULT] timeout");
    const snapshot = await collectPrintPagesAndFrames(context, page, finalNetwork).catch(() => ({
      pageSummaries: [],
      frameSummaries: [],
      pdfResponseCount: 0,
      blobResponseCount: 0,
    }));
    await writeJson(path.join(path.dirname(targetPath), "final-print-network.json"), finalNetwork).catch(() => {});
    await writeJson(path.join(path.dirname(targetPath), "final-print-pages.json"), snapshot.pageSummaries || []).catch(() => {});
    await writeJson(path.join(path.dirname(targetPath), "final-print-frames.json"), snapshot.frameSummaries || []).catch(() => {});
    await writePrintTargetMeta(operationId, {
      operationId,
      stage: "timeout",
      error: {
        name: "PRINT_TARGET_NOT_FOUND",
        message: "No valid KM label target found after print click",
      },
      candidatesChecked: [],
      pagesCount: snapshot.pageSummaries.length,
      framesCount: snapshot.frameSummaries.length,
      pdfResponseCount: snapshot.pdfResponseCount,
      blobResponseCount: snapshot.blobResponseCount,
      finalNetworkCount: finalNetwork.length,
      filesWritten: ["final-print-network.json", "final-print-pages.json", "final-print-frames.json"],
      validation: null,
    }).catch(() => {});
    await dumpDebug(page, operationId, "PRINT_TARGET_NOT_FOUND").catch(() => {});
    throw new Error("PRINT_TARGET_NOT_FOUND");
  } catch (error) {
    const snapshot = await collectPrintPagesAndFrames(context, page, finalNetwork).catch(() => ({
      pageSummaries: [],
      frameSummaries: [],
      pdfResponseCount: 0,
      blobResponseCount: 0,
    }));
    await writeJson(path.join(path.dirname(targetPath), "final-print-network.json"), finalNetwork).catch(() => {});
    await writeJson(path.join(path.dirname(targetPath), "final-print-pages.json"), snapshot.pageSummaries || []).catch(() => {});
    await writeJson(path.join(path.dirname(targetPath), "final-print-frames.json"), snapshot.frameSummaries || []).catch(() => {});
    await writePrintTargetMeta(operationId, {
      operationId,
      stage: "error",
      error: {
        name: error?.name || "PRINT_TARGET_NOT_FOUND",
        message: error?.message || String(error || "PRINT_TARGET_NOT_FOUND"),
      },
      candidatesChecked: [],
      pagesCount: snapshot.pageSummaries.length,
      framesCount: snapshot.frameSummaries.length,
      pdfResponseCount: snapshot.pdfResponseCount,
      blobResponseCount: snapshot.blobResponseCount,
      finalNetworkCount: finalNetwork.length,
      filesWritten: ["final-print-network.json", "final-print-pages.json", "final-print-frames.json"],
      validation: null,
    }).catch(() => {});
    if (!error || String(error.message || error) !== "PRINT_TARGET_NOT_FOUND") {
      await dumpDebug(page, operationId, "PRINT_TARGET_NOT_FOUND").catch(() => {});
    }
    throw error;
  } finally {
    await writeJson(path.join(path.dirname(targetPath), "final-print-network.json"), finalNetwork).catch(() => {});
    console.log("[PRINT_FLOW_COMPLETE]");
    context.off("page", onPopup);
    context.off("response", onContextResponse);
    page.off("popup", onPopup);
    detachWatchers();
  }
}

async function printPdfViaUi(page, operation, outputDir) {
  const debugState = createDebugCollector(page);
  console.log(`[STEP] start operation ${operation.operationId}`);
  await closeAllModalsAndResetPage(page);

  const opened = await openOperationFromList(page, operation.operationId);
  if (!opened.opened) {
    await captureOperationNotFoundDebug(page, operation.operationId, `operation_open_failed via=${opened.via}`, debugState);
    debugState.detach();
    throw new Error(`Could not locate operation ${operation.operationId}`);
  }
  await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});

  await waitOperationsList(page);
  await dumpVisibleUi(page, operation.operationId, "before-print-click").catch(() => {});

  let activeModal = await waitForPrintModal(page);
  if (!activeModal) {
    await clickPrintEntry(page, operation.operationId, debugState);
    await page.waitForTimeout(1000);
    await dumpVisibleUi(page, operation.operationId, "after-print-click").catch(() => {});
    activeModal = await waitForPrintModal(page);
  }

  if (!activeModal) {
    const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
    const comboboxes = await getVisibleComboboxes(page);
    const hasValidPostClickUi = /PDF файл|Шаблон|горизонтальный|описанием товара|Data matrix/i.test(bodyText) || comboboxes.length > 0;
    if (!hasValidPostClickUi) {
      await dumpVisibleUi(page, operation.operationId, "after-print-click-no-change").catch(() => {});
      await captureOperationNotFoundDebug(page, operation.operationId, "PRINT_TEMPLATE_MODAL_NOT_READY", debugState);
      debugState.detach();
      throw new Error("PRINT_TEMPLATE_MODAL_NOT_READY");
    }
  }

  if (activeModal) {
    try {
      await assertPrintTemplateModal(page, operation.operationId, debugState, activeModal);
      await selectPrintFormatPdf(page, activeModal, operation.operationId, debugState);
      await page.waitForTimeout(1000);
      await assertPrintTemplateModal(page, operation.operationId, debugState, activeModal);
      const templateSelectedValue = await getTemplateSelectedValue(page);
      if (templateSelectedValue) {
        console.log(`[TEMPLATE] already selected: ${templateSelectedValue}`);
      } else {
        await selectTemplate(page, operation.operationId);
        await page.waitForTimeout(500);
      }
      await dumpVisibleUi(page, operation.operationId, "after-template-selected").catch(() => {});
    } catch (error) {
      await dumpVisibleUi(page, operation.operationId, `error-${sanitizeFilePart(error?.message || String(error))}`).catch(() => {});
      await captureUiDebug(page, operation.operationId, error?.message || String(error), debugState, activeModal);
      debugState.detach();
      throw error;
    }
  }

  const targetBase = sanitizeFilePart(operation.productCode || operation.operationId || "operation");
  const targetPath = path.join(outputDir, `${targetBase}.pdf`);
  if (await fileExists(targetPath)) {
    debugState.detach();
    return { filePath: targetPath, skipped: true };
  }

  await dumpVisibleUi(page, operation.operationId, "before-final-print").catch(() => {});
  await dumpFinalPrintButtons(page, operation.operationId, activeModal, "before-final-print").catch(() => {});
  await clickPrintAndSave(page, targetPath, operation.operationId, async () => {
    if (activeModal) {
      await clickPrintSubmitButton(page, operation.operationId, activeModal);
      return;
    }
    await clickPrintOnReadyPage(page, operation.operationId);
  });
  await closeAllModalsAndResetPage(page);
  debugState.detach();
  return { filePath: targetPath, skipped: false };
}

async function main() {
  await ensureDir(OUTPUT_DIR);
  console.log(`DATE_FROM: ${DATE_FROM}`);
  console.log(`DATE_TO: ${DATE_TO}`);
  console.log(`output folder: ${OUTPUT_DIR}`);

  const authState = await readAuthHeaders();
  console.log(`AUTH_TOKEN_EXPIRES_AT: ${authState.tokenExpiresAtMs ? new Date(authState.tokenExpiresAtMs).toISOString() : "n/a"}`);
  const operations = await loadOperations(authState);
  const targets = PDF_DEBUG_ONE ? operations.slice(0, 1) : operations;

  console.log(`total operations found: ${operations.length}`);
  console.log(`target operations: ${targets.length}`);

  if (targets.length === 0) {
    console.log("NO_OPERATIONS_FOUND");
    return;
  }

  const browserContext = await chromium.launchPersistentContext(SESSION_PROFILE_DIR, {
    headless: false,
    acceptDownloads: true,
    viewport: { width: 1440, height: 1200 },
  });

  const results = [];
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const page = browserContext.pages()[0] || await browserContext.newPage();
    page.setDefaultTimeout(REQUEST_TIMEOUT);
    page.setDefaultNavigationTimeout(REQUEST_TIMEOUT);

    await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT });
    await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});

    if (page.url().includes("/login") || page.url().includes("/sign-in")) {
      throw new Error("LOGIN_REQUIRED");
    }

    for (const operation of targets) {
      try {
        const result = await printPdfViaUi(page, operation, OUTPUT_DIR);
        if (result.skipped) skipped += 1;
        else downloaded += 1;

        results.push({
          operationId: operation.operationId,
          createdAt: operation.createdAt,
          status: operation.status,
          filePath: result.filePath,
          result: result.skipped ? "skipped_existing" : "downloaded",
        });
      } catch (error) {
        failed += 1;
        await captureUiDebug(page, operation.operationId, error?.message || String(error)).catch(() => {});
        results.push({
          operationId: operation.operationId,
          createdAt: operation.createdAt,
          status: operation.status,
          filePath: `ERROR: ${error.message || String(error)}`,
          result: "failed",
        });
        console.error("OPERATION_ERROR");
        console.error(`operationId: ${operation.operationId}`);
        console.error(`error.name: ${error?.name || "n/a"}`);
        console.error(`error.message: ${error?.message || "n/a"}`);
      }

      if (PDF_DEBUG_ONE) break;
    }

    console.table(results.map((row) => ({
      operationId: row.operationId,
      createdAt: row.createdAt,
      status: row.status,
      result: row.result,
      filePath: row.filePath,
    })));

    console.log(`total operations: ${operations.length}`);
    console.log(`downloaded pdf: ${downloaded}`);
    console.log(`skipped: ${skipped}`);
    console.log(`failed: ${failed}`);
    console.log(`output folder: ${OUTPUT_DIR}`);
  } finally {
    await browserContext.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
