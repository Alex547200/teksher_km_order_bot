const fs = require("node:fs/promises");
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
  const rows = page.locator("table tbody tr, [role='row'], .operation, .operations-row, li");
  const rowCount = await rows.count().catch(() => 0);
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

  throw new Error(`Could not locate operation ${operationId}`);
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

async function captureUiDebug(page, operationId, reason) {
  const safeOperationId = sanitizeFilePart(operationId || "unknown");
  const dir = path.join(PROJECT_DIR, "debug", "km-pdf-clean", safeOperationId);
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, "page.html"), await page.content(), "utf8");
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

  await writeJson(path.join(dir, "controls.json"), { reason, controls });
  await writeJson(path.join(dir, "options.json"), { reason, options });
}

async function selectPdfFormat(page, modal) {
  const comboboxes = await getVisibleComboboxes(page);
  const target = comboboxes[0] || modal.locator('input[role="combobox"]').first();
  if (!(await target.count().catch(() => 0))) {
    throw new Error("KM_PDF_FORMAT_COMBOBOX_NOT_FOUND");
  }

  await target.click({ force: true });
  await page.keyboard.type("PDF файл", { delay: 20 }).catch(() => {});
  await sleep(700);

  const options = page.locator('[role="option"], [id*="option"]');
  const count = await options.count().catch(() => 0);
  const preferred = [/^PDF файл$/i, /^PDF$/i, /PDF файл/i, /\bPDF\b/i];
  for (let index = 0; index < count; index += 1) {
    const item = options.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const text = normalizeText(await item.innerText().catch(() => ""));
    if (!text) continue;
    if (preferred.some((regex) => regex.test(text))) {
      await item.click({ force: true });
      await sleep(500);
      return text;
    }
  }

  await page.keyboard.press("ArrowDown").catch(() => {});
  await page.keyboard.press("Enter").catch(() => {});
  await sleep(500);

  const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
  if (/PDF файл/i.test(bodyText) || /\bPDF\b/i.test(bodyText)) {
    return "PDF файл";
  }
  throw new Error("KM_PDF_FORMAT_SELECTION_FAILED");
}

async function selectTemplate(page) {
  await sleep(3000);
  await page.getByText("Шаблон", { exact: false }).first().waitFor({ state: "visible", timeout: 10_000 });

  const visibleComboboxes = await getVisibleComboboxes(page);
  const templateCombobox = visibleComboboxes[1] || visibleComboboxes[visibleComboboxes.length - 1] || null;
  if (!templateCombobox) {
    throw new Error("KM_PDF_TEMPLATE_CONTROL_MISSING");
  }

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
    throw error;
  }

  await savePdfDownload(download, targetPath);
}

async function printPdfViaUi(page, operation, outputDir) {
  await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT });
  await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});

  await openOperationFromList(page, operation.operationId);
  await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});

  const printButton = page.getByRole("button", { name: "Печать и нанесение", exact: true }).last();
  await printButton.waitFor({ state: "visible", timeout: REQUEST_TIMEOUT });
  await printButton.click({ force: true });

  const modal = await waitForPrintModal(page);
  if (!modal) {
    throw new Error("KM_PDF_PRINT_MODAL_NOT_FOUND");
  }

  await selectPdfFormat(page, modal);
  await sleep(3000);
  await page.getByText("Шаблон", { exact: false }).first().waitFor({ state: "visible", timeout: 10_000 });
  await selectTemplate(page);
  await sleep(500);

  const targetBase = sanitizeFilePart(operation.productCode || operation.operationId || "operation");
  const targetPath = path.join(outputDir, `${targetBase}.pdf`);
  if (await fileExists(targetPath)) {
    return { filePath: targetPath, skipped: true };
  }

  await clickPrintAndSave(page, targetPath);
  return { filePath: targetPath, skipped: false };
}

async function main() {
  await ensureDir(OUTPUT_DIR);
  console.log(`DATE_FROM: ${DATE_FROM}`);
  console.log(`DATE_TO: ${DATE_TO}`);
  console.log(`output folder: ${OUTPUT_DIR}`);

  const authState = await readAuthHeaders();
  const operations = await loadOperations(authState.headers);
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
