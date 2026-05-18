const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const authHelper = require("./teksher-auth.js");

const PROJECT_DIR = __dirname;
const BASE_URL = "https://label.teksher.kg";
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
const RETRY_FAILED_ONLY = String(process.env.RETRY_FAILED_ONLY || "").trim() === "1";
const FAILED_OPERATIONS_PATH = path.join(PROJECT_DIR, "tmp", `failed_pdf_operations_${String(DATE_FROM).slice(8)}may.json`);

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

function normalizeFailedOperationRecord(record) {
  if (!record || typeof record !== "object") return null;
  const operationId = extractOperationId(record) || normalizeText(record.operationId || "");
  if (!operationId) return null;
  return {
    operationId,
    createdAt: normalizeText(record.createdAt || record.created_at || ""),
    status: normalizeStatus(record.status || record.state || ""),
    productCode: normalizeText(record.productCode || record.product_code || extractProductCode(record.raw || record)),
    error: normalizeText(record.error || record.errorMessage || record.message || ""),
    result: normalizeText(record.result || ""),
    filePath: normalizeText(record.filePath || ""),
  };
}

async function loadFailedOperations() {
  const payload = await readJsonIfExists(FAILED_OPERATIONS_PATH);
  if (!payload) return [];
  const source = Array.isArray(payload) ? payload : Array.isArray(payload.failedOperations) ? payload.failedOperations : Array.isArray(payload.items) ? payload.items : [];
  const seen = new Set();
  const items = [];
  for (const entry of source) {
    const normalized = normalizeFailedOperationRecord(entry);
    if (!normalized) continue;
    if (seen.has(normalized.operationId)) continue;
    seen.add(normalized.operationId);
    items.push(normalized);
  }
  return items;
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

async function readJsonIfExists(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function safeWriteDebug(dir, fileName, value, encoding = "utf8") {
  try {
    fsSync.mkdirSync(dir, { recursive: true });
    await fs.writeFile(path.join(dir, fileName), value, encoding);
  } catch (error) {
    console.warn(`[DEBUG_WRITE_FAILED] ${path.join(dir, fileName)} ${error?.message || error}`);
  }
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
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPageWithRetry(pageNumber, headers) {
  const url = buildUrl(LIST_ENDPOINT.replace("{page}", String(pageNumber)));
  console.log(`LIST URL: ${url}`);
  let lastError = null;
  for (let attempt = 1; attempt <= LIST_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, {
        method: "GET",
        headers,
      });
      if ([502, 503, 504].includes(response.status) && attempt < LIST_RETRY_ATTEMPTS) {
        console.warn(`LIST_RETRY attempt ${attempt}/${LIST_RETRY_ATTEMPTS} HTTP ${response.status} page=${pageNumber}`);
        await sleep(LIST_RETRY_DELAY_MS);
        continue;
      }
      const text = await response.text();
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
  const isExpired = !accessToken || !tokenExpiresAtMs || tokenExpiresAtMs <= Date.now() + 60_000;

  if (isExpired && refreshToken) {
    const refreshed = await authHelper.refreshAuthToken(refreshToken, {
      authTokensPath: AUTH_TOKENS_PATH,
      source: "download-km-pdf-ui-clean",
    });
    accessToken = normalizeToken(refreshed.accessToken || "");
    refreshToken = normalizeToken(refreshed.refreshToken || refreshToken);
    tokenExpiresAtMs = authHelper.decodeJwtExpMs(accessToken);
    console.log("ACCESS_TOKEN_REFRESHED");
    console.log(`NEW_EXP ${tokenExpiresAtMs ? new Date(tokenExpiresAtMs).toISOString() : "n/a"}`);
  }

  if (!accessToken) {
    throw new Error("TOKEN_MISSING: auth_tokens.json access_token not found");
  }
  if (!tokenExpiresAtMs || tokenExpiresAtMs <= Date.now()) {
    throw new Error("TOKEN_EXPIRED: run npm run manual-token");
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

async function loadOperations(headers) {
  const rows = [];
  let pageNumber = 0;
  let totalPages = null;
  while (true) {
    const page = await fetchPageWithRetry(pageNumber, headers);
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
  const directUrls = [
    `${OPERATIONS_URL}/${operationId}`,
    `${OPERATIONS_URL}/${operationId}/details`,
    `${OPERATIONS_URL}?operationId=${operationId}`,
    `${OPERATIONS_URL}?id=${operationId}`,
  ];

  const findOperationOnCurrentPage = async () => {
    const rows = page.locator("table tbody tr, [role='row'], .operation, .operations-row, li");
    const rowCount = await rows.count().catch(() => 0);
    for (let index = 0; index < rowCount; index += 1) {
      const row = rows.nth(index);
      if (!(await row.isVisible().catch(() => false))) continue;
      const text = normalizeText(await row.innerText().catch(() => ""));
      if (!text.includes(operationId)) continue;
      const clickable = row.locator("a,button,[role='button']").first();
      if (await clickable.isVisible().catch(() => false)) {
        await clickable.click({ timeout: REQUEST_TIMEOUT, force: true });
      } else {
        await row.click({ timeout: REQUEST_TIMEOUT, force: true });
      }
      return true;
    }

    const byText = page.getByText(operationId, { exact: false });
    const textCount = await byText.count().catch(() => 0);
    for (let index = 0; index < textCount; index += 1) {
      const item = byText.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      await item.click({ timeout: REQUEST_TIMEOUT, force: true }).catch(async () => {
        const row = item.locator("xpath=ancestor::tr[1]");
        if (await row.isVisible().catch(() => false)) {
          await row.click({ timeout: REQUEST_TIMEOUT, force: true });
        }
      });
      return true;
    }

    return false;
  };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    for (const url of directUrls) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT });
        await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});
        const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
        if (bodyText.includes(operationId)) {
          return { opened: true, via: `direct:${url}`, attempt };
        }
      } catch (error) {
        console.warn(`DIRECT_OPERATION_URL_FAILED ${url} ${error?.message || error}`);
      }
    }

    await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});

    for (let pageNumber = 1; pageNumber <= 10; pageNumber += 1) {
      if (await findOperationOnCurrentPage()) {
        return { opened: true, via: `list-page-${pageNumber}`, attempt };
      }

      const nextCandidates = [
        page.getByRole("button", { name: /next|следующая|вперёд|вперед/i }),
        page.getByText(/next|следующая|вперёд|вперед/i),
        page.locator('button, a').filter({ hasText: /next|следующая|вперёд|вперед/i }),
      ];
      let clickedNext = false;
      for (const candidate of nextCandidates) {
        const count = await candidate.count().catch(() => 0);
        for (let index = 0; index < count; index += 1) {
          const item = candidate.nth(index);
          if (!(await item.isVisible().catch(() => false))) continue;
          const disabled = await item.isDisabled?.().catch(() => false);
          if (disabled) continue;
          await item.click({ timeout: REQUEST_TIMEOUT, force: true }).catch(() => {});
          clickedNext = true;
          break;
        }
        if (clickedNext) break;
      }
      if (!clickedNext) break;
      await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});
    }
  }

  throw new Error(`Could not locate operation ${operationId}`);
}

async function waitForPrintModal(page) {
  const modalCandidates = [
    page.locator('[role="dialog"]'),
    page.locator('[aria-modal="true"]'),
    page.getByText(/Печать кодов маркировки/i),
    page.getByText(/Формат файла/i),
    page.getByText(/Шаблон/i),
    page.getByText(/Количество/i),
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

async function findVisibleControlNearLabel(page, modal, labelText) {
  const locators = [
    modal.getByText(labelText, { exact: false }),
    page.getByText(labelText, { exact: false }),
  ];

  for (const labelLocator of locators) {
    const count = await labelLocator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = labelLocator.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;

      const candidates = [
        item.locator('xpath=ancestor::*[self::div or self::label or self::td or self::section][1]//*[self::div[@role="combobox"] or self::button or self::input[not(@type="hidden")] or contains(@class,"control") or contains(@class,"select")]'),
        item.locator('xpath=ancestor::*[self::div or self::label or self::td or self::section][2]//*[self::div[@role="combobox"] or self::button or self::input[not(@type="hidden")] or contains(@class,"control") or contains(@class,"select")]'),
        item.locator('xpath=following::*[self::div[@role="combobox"] or self::button or self::input[not(@type="hidden")] or contains(@class,"control") or contains(@class,"select")][1]'),
        item.locator('xpath=preceding::*[self::div[@role="combobox"] or self::button or self::input[not(@type="hidden")] or contains(@class,"control") or contains(@class,"select")][1]'),
      ];

      for (const candidate of candidates) {
        const candidateCount = await candidate.count().catch(() => 0);
        for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex += 1) {
          const control = candidate.nth(candidateIndex);
          if (!(await control.isVisible().catch(() => false))) continue;
          const tagName = await control.evaluate((node) => node.tagName).catch(() => "");
          const id = await control.getAttribute("id").catch(() => "");
          const role = await control.getAttribute("role").catch(() => "");
          const type = await control.getAttribute("type").catch(() => "");
          if (tagName === "INPUT" && type === "hidden") continue;
          if (id && /-input$/i.test(id) && tagName === "INPUT") continue;
          if (role === "button" || role === "combobox" || tagName === "BUTTON" || tagName === "DIV" || tagName === "INPUT") {
            return control;
          }
        }
      }
    }
  }

  return null;
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

async function savePdfDownload(download, targetPath) {
  await download.saveAs(targetPath);
  const stat = await fs.stat(targetPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Downloaded PDF is empty: ${targetPath}`);
  }

  const handle = await fs.open(targetPath, "r");
  try {
    const buffer = Buffer.alloc(4);
    await handle.read(buffer, 0, 4, 0);
    if (buffer.toString("utf8") !== "%PDF") {
      throw new Error(`Downloaded file is not a PDF: ${targetPath}`);
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

function isDownloadTimeoutError(error) {
  const message = String(error?.message || error || "");
  return /Timeout .* waiting for event "download"/i.test(message) || /DOWNLOAD_TIMEOUT/i.test(message);
}

async function captureUiDebug(page, operationId, reason) {
  const safeOperationId = sanitizeFilePart(operationId || "unknown");
  const dir = path.join(PROJECT_DIR, "debug", "km-pdf-clean", safeOperationId);
  fsSync.mkdirSync(dir, { recursive: true });
  await safeWriteDebug(dir, "page.html", await page.content().catch(() => ""));
  await page.screenshot({ path: path.join(dir, "page.png"), fullPage: true }).catch(() => {});

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
          disabled: Boolean(el.disabled),
          hidden: Boolean(el.hidden),
          visible: style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0",
          dataAttributes,
        };
      });
  }).catch(() => []);

  await safeWriteDebug(dir, "controls.json", `${JSON.stringify({ reason, controls }, null, 2)}\n`);
  await safeWriteDebug(dir, "options.json", `${JSON.stringify({ reason, options }, null, 2)}\n`);
}

async function dumpOperationPageUi(page, operationId) {
  const safeOperationId = sanitizeFilePart(operationId || "unknown");
  const dir = path.join(PROJECT_DIR, "debug", "km-pdf-clean", safeOperationId);
  fsSync.mkdirSync(dir, { recursive: true });

  const buttons = await page.evaluate(() => Array.from(document.querySelectorAll("button"))
    .filter((el) => el && el.getClientRects && el.getClientRects().length > 0)
    .map((el, index) => ({
      index,
      text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
      ariaLabel: el.getAttribute("aria-label") || "",
      title: el.getAttribute("title") || "",
      role: el.getAttribute("role") || "",
      id: el.id || "",
      className: el.className || "",
    }))
  ).catch(() => []);

  const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));

  await safeWriteDebug(dir, "operation-page-buttons.json", `${JSON.stringify({ operationId, buttons }, null, 2)}\n`);
  await safeWriteDebug(dir, "operation-page-texts.txt", `${bodyText}\n`);
}

async function selectPdfFormat(page, modal, operationId) {
  const safeDir = path.join(PROJECT_DIR, "debug", "km-pdf-clean", sanitizeFilePart(operationId || "unknown"));
  const target = await findVisibleControlNearLabel(page, modal, "Формат файла");
  if (!target) {
    throw new Error("KM_PDF_FORMAT_COMBOBOX_NOT_FOUND");
  }

  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.click({ force: true });
  await sleep(400);

  const dropdownTexts = [];
  const visibleOptions = [];
  const optionLocator = page.locator('[role="option"], [id*="option"], div[class*="option"], [class*="option"], [role="menuitem"]');
  const optionCount = await optionLocator.count().catch(() => 0);
  for (let index = 0; index < optionCount; index += 1) {
    const item = optionLocator.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const text = normalizeText(await item.innerText().catch(() => ""));
    if (!text) continue;
    visibleOptions.push(text);
    dropdownTexts.push(text);
  }

  console.log(`[PDF_FORMAT_OPTIONS] ${visibleOptions.join(" | ")}`);
  fsSync.mkdirSync(safeDir, { recursive: true });
  await safeWriteDebug(safeDir, "pdf-format-dropdown.html", await page.content().catch(() => ""));
  await page.screenshot({ path: path.join(safeDir, "pdf-format-dropdown.png"), fullPage: true }).catch(() => {});
  await safeWriteDebug(safeDir, "pdf-format-options.txt", `${visibleOptions.join("\n")}\n`);

  const preferred = [
    /PDF файл/i,
    /\bPDF\b/i,
    /pdf/i,
    /format.*pdf/i,
  ];

  for (let index = 0; index < optionCount; index += 1) {
    const item = optionLocator.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const text = normalizeText(await item.innerText().catch(() => ""));
    if (!text) continue;
    if (preferred.some((regex) => regex.test(text))) {
      await item.click({ force: true });
      await sleep(500);
      const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
      if (/PDF/i.test(bodyText)) {
        return text;
      }
    }
  }

  await page.keyboard.type("PDF файл", { delay: 20 }).catch(() => {});
  await sleep(400);
  await page.keyboard.press("ArrowDown").catch(() => {});
  await page.keyboard.press("Enter").catch(() => {});
  await sleep(500);

  const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
  if (/PDF/i.test(bodyText)) {
    return "PDF файл";
  }

  throw new Error(`KM_PDF_FORMAT_SELECTION_FAILED: ${visibleOptions.join(" | ")}`);
}

async function selectTemplate(page) {
  await sleep(3000);
  await page.getByText("Шаблон", { exact: false }).first().waitFor({ state: "visible", timeout: 10_000 });

  const templateCombobox = await findVisibleControlNearLabel(page, page, "Шаблон");
  if (!templateCombobox) {
    throw new Error("KM_PDF_TEMPLATE_CONTROL_MISSING");
  }

  await templateCombobox.scrollIntoViewIfNeeded().catch(() => {});
  await templateCombobox.click({ force: true });
  await templateCombobox.fill("Data matrix").catch(() => {});
  await sleep(700);

  let options = await collectVisibleOptions(page);
  let chosen = null;
  const patterns = [/Data matrix.*горизонтальный.*описанием/i, /горизонтальный.*описанием/i];
  for (const option of options) {
    if (patterns.some((regex) => regex.test(option.text))) {
      chosen = option.text;
      const locator = page.getByText(option.text, { exact: false }).first();
      if (await locator.count().catch(() => 0)) {
        await locator.click({ force: true });
        await sleep(500);
        break;
      }
    }
  }

  if (!chosen) {
    await page.keyboard.press("ArrowDown").catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    await sleep(500);
  }

  const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
  if (/горизонтальный/i.test(bodyText) && /описан/i.test(bodyText)) {
    return true;
  }

  options = await collectVisibleOptions(page);
  if (options.some((option) => /Data matrix.*горизонтальный.*описанием/i.test(option.text) || /горизонтальный.*описанием/i.test(option.text))) {
    return true;
  }

  throw new Error("KM_PDF_TEMPLATE_SELECTION_FAILED");
}

async function clickPrintEntry(page) {
  const deadlineMs = 10_000;
  const startedAt = Date.now();

  const collectVisibleButtons = async () => page.evaluate(() => Array.from(document.querySelectorAll("button"))
    .filter((el) => el && el.getClientRects && el.getClientRects().length > 0)
    .map((el, index) => ({
      index,
      text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
      ariaLabel: el.getAttribute("aria-label") || "",
      title: el.getAttribute("title") || "",
    }))
  ).catch(() => []);

  const modalCancelVisible = async () => {
    const cancelButtons = page.getByRole("button", { name: /отменить/i });
    const count = await cancelButtons.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (await cancelButtons.nth(index).isVisible().catch(() => false)) return true;
    }
    return false;
  };

  while (Date.now() - startedAt < deadlineMs) {
    const visibleButtons = await collectVisibleButtons();
    console.log(`[STEP] visible buttons: ${visibleButtons.map((item) => item.text).join(" | ")}`);

    const cancelVisible = await modalCancelVisible();
    const candidateTexts = visibleButtons
      .map((item) => item.text)
      .filter((text) => /печать и нанесение/i.test(text) || (!cancelVisible && /^печать$/i.test(text)));

    for (const text of candidateTexts) {
      const exact = page.getByRole("button", { name: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
      const byRole = page.getByRole("button", { name: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") });
      const byText = page.getByText(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
      for (const candidate of [exact, byRole, byText]) {
        const count = await candidate.count().catch(() => 0);
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

  throw new Error("PRINT_ENTRY_NOT_FOUND");
}

async function clickPrintAndSave(page, targetPath) {
  const downloadPromise = page.waitForEvent("download", { timeout: DOWNLOAD_TIMEOUT });
  const printButton = page.getByRole("button", { name: "Печать", exact: true }).last();
  await printButton.waitFor({ state: "visible", timeout: REQUEST_TIMEOUT });
  await printButton.click({ force: true });

  let download;
  try {
    download = await downloadPromise;
  } catch (error) {
    if (/Target page, context or browser has been closed/i.test(String(error?.message || error))) {
      throw new Error("DOWNLOAD_PAGE_CLOSED_BEFORE_EVENT");
    }
    if (/Timeout .* waiting for event "download"/i.test(String(error?.message || error))) {
      throw new Error("PRINT_DOWNLOAD_TIMEOUT");
    }
    throw error;
  }

  await savePdfDownload(download, targetPath);
}

async function printPdfViaUi(page, operation, outputDir) {
  await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT });
  await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});

  await openOperationFromList(page, operation.operationId);
  await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});
  await dumpOperationPageUi(page, operation.operationId).catch(() => {});

  await clickPrintEntry(page);

  const operationId = sanitizeFilePart(operation.operationId || "");
  const originalName = sanitizeFilePart(operation.productCode || operation.operationId || "operation");
  const targetBase = operationId || `unknown__${originalName}` || originalName || "operation";
  const targetPath = path.join(outputDir, `${targetBase}.pdf`);
  if (await fileExists(targetPath)) {
    return { filePath: targetPath, skipped: true };
  }

  let modal = null;
  const modalDeadline = Date.now() + 3_000;
  while (Date.now() < modalDeadline) {
    modal = await waitForPrintModal(page);
    if (modal) break;
    await sleep(250);
  }

  if (modal) {
    await selectPdfFormat(page, modal, operation.operationId);
    await sleep(3000);
    await page.getByText("Шаблон", { exact: false }).first().waitFor({ state: "visible", timeout: 10_000 });
    await selectTemplate(page);
    await sleep(500);
  } else {
    await captureUiDebug(page, operation.operationId, "KM_PDF_PRINT_MODAL_NOT_FOUND").catch(() => {});
    throw new Error("KM_PDF_PRINT_MODAL_NOT_FOUND");
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await clickPrintAndSave(page, targetPath);
      return { filePath: targetPath, skipped: false };
    } catch (error) {
      lastError = error;
      if (!isDownloadTimeoutError(error) && !/PRINT_DOWNLOAD_TIMEOUT/i.test(String(error?.message || ""))) {
        throw error;
      }
      console.warn(`[DOWNLOAD_RETRY] attempt ${attempt}/3 ${error?.message || error}`);
      await sleep(1_000);
    }
  }

  throw lastError || new Error("PRINT_DOWNLOAD_TIMEOUT");
}

async function main() {
  await ensureDir(OUTPUT_DIR);
  await ensureDir(path.dirname(FAILED_OPERATIONS_PATH));
  console.log(`DATE_FROM: ${DATE_FROM}`);
  console.log(`DATE_TO: ${DATE_TO}`);
  console.log(`output folder: ${OUTPUT_DIR}`);
  console.log(`retry failed only: ${RETRY_FAILED_ONLY ? "yes" : "no"}`);

  const authState = await readAuthHeaders();
  const operations = RETRY_FAILED_ONLY ? await loadFailedOperations() : await loadOperations(authState.headers);
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
  const failedRecords = [];
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
        failedRecords.push({
          operationId: operation.operationId,
          createdAt: operation.createdAt,
          status: operation.status,
          productCode: operation.productCode || extractProductCode(operation.raw || operation),
          error: error?.message || String(error),
          result: "failed",
        });
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

    await writeJson(FAILED_OPERATIONS_PATH, {
      failedOperations: failedRecords,
      updatedAt: new Date().toISOString(),
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
    }).catch(() => {});

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
    console.log(`failed operations file: ${FAILED_OPERATIONS_PATH}`);
  } finally {
    await browserContext.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
