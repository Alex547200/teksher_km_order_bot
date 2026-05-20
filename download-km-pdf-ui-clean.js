const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { chromium } = require("playwright");
const authHelper = require("./teksher-auth.js");

const PROJECT_DIR = __dirname;
const BASE_URL = "https://label.teksher.kg";
const OPERATIONS_URL = `${BASE_URL}/operations`;
const AUTH_REFRESH_TOKEN_URL = `${BASE_URL}/realms/mzkm_prod_realm/protocol/openid-connect/token`;
const AUTH_TOKENS_PATH = path.join(PROJECT_DIR, "auth_tokens.json");
const SESSION_PROFILE_DIR = path.resolve(PROJECT_DIR, "teksher-session-profile");
const REQUEST_TIMEOUT = 45_000;
const DOWNLOAD_TIMEOUT = 60_000;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3_000;
const LIST_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 12_000, 20_000];
const PAGE_SIZE = 15;
const FORMAT_MODAL_RETRY_ATTEMPTS = 3;
const FORMAT_MODAL_WAIT_MS = 15_000;
const TARGET_OPERATION_TYPE_CODE = "MARK_CODE_ORDER";
const TARGET_OPERATION_TYPE_TEXT = "Заказ на эмиссию КМ";
const BAD_STATUSES = new Set(["ERROR", "500", "502"]);
const PDF_DEBUG_ONE = String(process.env.PDF_DEBUG_ONE || "").trim() === "1";
const DEBUG_LIMIT = Number.parseInt(String(process.env.DEBUG_LIMIT || "").trim(), 10);
const LATEST_EMISSION_MODE = String(process.env.LATEST_EMISSION_MODE || "").trim() === "1";
const LIMIT = Number.parseInt(String(process.env.LIMIT || "100").trim(), 10);
const ONLY_DATE = String(process.env.ONLY_DATE || "").trim();
const ONLY_TIME_FROM = String(process.env.ONLY_TIME_FROM || "").trim();
const ONLY_TIME_TO = String(process.env.ONLY_TIME_TO || "").trim();
const FAILED_OPERATIONS_FILE = String(process.env.FAILED_OPERATIONS_FILE || "").trim();

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

function formatRunTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

const DEFAULT_DATE_FROM = formatIsoDateFromLocalDate();
const DEFAULT_DATE_TO = addDaysIso(DEFAULT_DATE_FROM, 1);
const DATE_FROM = getEnvDate("DATE_FROM", DEFAULT_DATE_FROM);
const DATE_TO = getEnvDate("DATE_TO", DEFAULT_DATE_TO);
const HAS_TIME_FILTER = Boolean(ONLY_TIME_FROM && ONLY_TIME_TO);
const SELECTED_DATE = ONLY_DATE || DATE_FROM;
const TIME_RANGE_DIR_SUFFIX = HAS_TIME_FILTER ? `_${ONLY_TIME_FROM.replace(":", "-")}_${ONLY_TIME_TO.replace(":", "-")}` : "";
const RUN_TIMESTAMP = formatRunTimestamp();
const LATEST_EMISSION_RETRY = /(?:^|[/\\])failed_latest_emission_pdf_operations\.json$/i.test(FAILED_OPERATIONS_FILE);
const USE_LATEST_EMISSION_OUTPUT = LATEST_EMISSION_MODE || LATEST_EMISSION_RETRY;
const OUTPUT_DIR = USE_LATEST_EMISSION_OUTPUT
  ? path.join(os.homedir(), "Desktop", "Текшер PDF", `LATEST_EMISSION_${Number.isFinite(LIMIT) && LIMIT > 0 ? LIMIT : "INVALID"}_${RUN_TIMESTAMP}`)
  : path.join(os.homedir(), "Desktop", "Текшер PDF", `${formatDateDot(SELECTED_DATE)}${TIME_RANGE_DIR_SUFFIX}`);
const LIST_ENDPOINT = `/facade/api/v1/operations/filter?size=${PAGE_SIZE}&page={page}&startDate=${DATE_FROM}&endDate=${DATE_TO}`;
const ONLY_TIME_FROM_MINUTES = HAS_TIME_FILTER ? parseTimeMinutes(ONLY_TIME_FROM, "ONLY_TIME_FROM") : null;
const ONLY_TIME_TO_MINUTES = HAS_TIME_FILTER ? parseTimeMinutes(ONLY_TIME_TO, "ONLY_TIME_TO") : null;
const TIME_RANGE_LABEL = HAS_TIME_FILTER ? `${ONLY_TIME_FROM}..${ONLY_TIME_TO}` : "disabled";
const RETRY_FAILED_ONLY = String(process.env.RETRY_FAILED_ONLY || "").trim() === "1" || Boolean(FAILED_OPERATIONS_FILE);
const FAILED_OPERATIONS_PATH = FAILED_OPERATIONS_FILE
  ? path.resolve(PROJECT_DIR, FAILED_OPERATIONS_FILE)
  : LATEST_EMISSION_MODE
    ? path.join(PROJECT_DIR, "tmp", "failed_latest_emission_pdf_operations.json")
    : path.join(PROJECT_DIR, "tmp", `failed_pdf_operations_${String(DATE_FROM).slice(8)}may.json`);

function parseTimeMinutes(value, name) {
  if (!value) return null;
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw new Error(`${name}_INVALID: expected HH:MM, got ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

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

function extractOperationTypeInfo(record) {
  const code = normalizeText(pickText(record, [
    "operationType",
    "operationTypeCode",
    "operationCode",
    "operation.type",
    "operation.code",
    "operation.operationType",
    "operation.operationTypeCode",
    "type",
    "code",
  ]));
  const name = normalizeText(pickText(record, [
    "operationName",
    "operationTypeName",
    "name",
    "title",
    "description",
    "operation.name",
    "operation.title",
    "operation.operationName",
    "operation.operationTypeName",
  ]));
  return {
    code,
    name,
    label: [code, name].filter(Boolean).join(" | ") || "UNKNOWN",
  };
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

function parseCreatedAtTimeMinutes(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const timeMatch = text.match(/(?:T|\s)([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?/);
  if (!timeMatch) return null;
  return Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
}

function isTargetDate(record) {
  const dateOnly = parseDateOnly(extractCreatedAt(record));
  if (ONLY_DATE) return dateOnly === ONLY_DATE;
  return Boolean(dateOnly && dateOnly >= DATE_FROM && dateOnly < DATE_TO);
}

function isTargetTime(record) {
  if (!HAS_TIME_FILTER) return true;
  const timeMinutes = parseCreatedAtTimeMinutes(extractCreatedAt(record));
  if (timeMinutes === null) return false;
  if (ONLY_TIME_FROM_MINUTES !== null && timeMinutes < ONLY_TIME_FROM_MINUTES) return false;
  if (ONLY_TIME_TO_MINUTES !== null && timeMinutes > ONLY_TIME_TO_MINUTES) return false;
  return true;
}

function matchesTargetOperationType(record) {
  const joined = `${extractOperationType(record)} ${extractOperationName(record)}`.toUpperCase();
  return joined.includes(TARGET_OPERATION_TYPE_CODE) || joined.includes(TARGET_OPERATION_TYPE_TEXT.toUpperCase());
}

function isLatestEmissionOperation(record) {
  const typeInfo = extractOperationTypeInfo(record);
  const operationType = normalizeStatus(typeInfo.code);
  return operationType === TARGET_OPERATION_TYPE_CODE && operationType !== "MARKING";
}

function buildOperationTypeHistogram(rows) {
  const histogram = new Map();
  for (const row of rows) {
    const label = row.operationTypeLabel || extractOperationTypeInfo(row.raw || row).label;
    histogram.set(label, (histogram.get(label) || 0) + 1);
  }
  return [...histogram.entries()]
    .map(([operationType, count]) => ({ operationType, count }))
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return left.operationType.localeCompare(right.operationType);
    });
}

async function writeSelectedPdfOperationsDebug(selectedOperations) {
  const jsonRows = selectedOperations.map((operation, index) => ({
    index: index + 1,
    operationId: operation.operationId,
    createdAt: operation.createdAt || "",
    status: operation.status || "",
    operationType: operation.operationType || "",
  }));
  await fs.writeFile(path.join(OUTPUT_DIR, "selected_pdf_operations.json"), `${JSON.stringify(jsonRows, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(OUTPUT_DIR, "selected_pdf_operations.txt"), [
    "index\toperationId\tcreatedAt\tstatus\toperationType",
    ...jsonRows.map((row) => [
      row.index,
      row.operationId,
      row.createdAt,
      row.status,
      row.operationType,
    ].join("\t")),
    "",
  ].join("\n"), "utf8");
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
    console.log("[HTTP_DEBUG]", options?.method || "GET", url);
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithRetry(url, options = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      console.log("[HTTP_DEBUG]", options?.method || "GET", url);
      return await fetchWithTimeout(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < RETRY_ATTEMPTS && isRetryableFetchError(error)) {
        console.warn(`FETCH_RETRY attempt=${attempt} url=${url}`);
        console.warn(`FETCH_RETRY reason=${error?.cause?.code || error?.message || error}`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function fetchPageWithRetry(pageNumber, headers) {
  const url = buildUrl(LIST_ENDPOINT.replace("{page}", String(pageNumber)));
  const method = "GET";
  console.log("LIST_METHOD:", method);
  console.log("LIST_URL:", url);
  let lastError = null;
  for (let attempt = 1; attempt <= LIST_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      console.log("[HTTP_DEBUG]", method, url);
      const response = await fetchWithRetry(url, { method, headers });
      if ([502, 503, 504].includes(response.status)) {
        if (attempt < LIST_RETRY_DELAYS_MS.length) {
          const delay = LIST_RETRY_DELAYS_MS[attempt - 1];
          console.warn(`LIST_RETRY attempt=${attempt}/${LIST_RETRY_DELAYS_MS.length} http=${response.status} page=${pageNumber} delay=${delay}ms`);
          await sleep(delay);
          continue;
        }

        const text = await response.text().catch(() => "");
        return {
          url,
          status: response.status,
          ok: false,
          json: null,
          text,
          retryableFailedPage: true,
        };
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
      if (attempt < LIST_RETRY_DELAYS_MS.length && isRetryableFetchError(error)) {
        const delay = LIST_RETRY_DELAYS_MS[attempt - 1];
        console.warn(`LIST_RETRY attempt=${attempt}/${LIST_RETRY_DELAYS_MS.length} network_error page=${pageNumber} delay=${delay}ms`);
        console.warn(`LIST_RETRY reason=${error?.cause?.code || error?.message || error}`);
        await sleep(delay);
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
    console.log("[EARLY_HTTP_DEBUG]", "POST", AUTH_REFRESH_TOKEN_URL);
    const refreshed = await authHelper.refreshAuthToken(refreshToken, {
      tokenUrl: AUTH_REFRESH_TOKEN_URL,
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
  let totalOperationsBeforeLocalFilters = 0;
  let totalOperationsAfterDateTimeFilters = 0;
  let totalOperationsAfterStatusFilter = 0;
  while (true) {
    const page = await fetchPageWithRetry(pageNumber, headers);
    if (!page.ok) {
      throw new Error(`List endpoint failed with HTTP ${page.status}`);
    }
    const items = extractCollection(page.json);
    totalOperationsBeforeLocalFilters += items.length;
    totalPages = extractTotalPages(page.json) ?? totalPages;
    for (const item of items) {
      const operationId = extractOperationId(item);
      const createdAt = extractCreatedAt(item);
      const status = normalizeStatus(pickText(item, ["status", "state", "operationStatus", "currentStatus", "documentStatus"]));
      const operationType = extractOperationType(item);
      const operationTypeInfo = extractOperationTypeInfo(item);
      if (!operationId) continue;
      if (!isTargetDate(item)) continue;
      if (!LATEST_EMISSION_MODE && !isTargetTime(item)) continue;
      totalOperationsAfterDateTimeFilters += 1;
      if (LATEST_EMISSION_MODE && status !== "ACCEPTED") continue;
      if (!LATEST_EMISSION_MODE && !matchesTargetOperationType(item)) continue;
      if (BAD_STATUSES.has(status)) continue;
      totalOperationsAfterStatusFilter += 1;
      rows.push({
        operationId,
        createdAt,
        status,
        operationType: operationTypeInfo.code || operationType,
        operationName: operationTypeInfo.name,
        operationTypeLabel: operationTypeInfo.label,
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
  return {
    rows,
    totalOperationsBeforeLocalFilters,
    totalOperationsAfterDateTimeFilters,
    totalOperationsAfterStatusFilter,
  };
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

async function collectVisibleFormatOptions(page) {
  const optionLocator = page.locator('[role="option"], [id*="option"], div[class*="option"], [class*="option"], [role="menuitem"]');
  const optionCount = await optionLocator.count().catch(() => 0);
  const visibleOptions = [];
  for (let index = 0; index < optionCount; index += 1) {
    const item = optionLocator.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const text = normalizeText(await item.innerText().catch(() => ""));
    if (!text) continue;
    visibleOptions.push(text);
  }
  return visibleOptions;
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

async function captureFormatNotFoundDebug(page, operationId, attempt, reason) {
  const safeOperationId = sanitizeFilePart(operationId || "unknown");
  const dir = path.join(PROJECT_DIR, "tmp", "pdf-ui-debug", safeOperationId);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prefix = `format-not-found-attempt-${attempt}-${timestamp}`;
  fsSync.mkdirSync(dir, { recursive: true });

  const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
  const visibleOptions = await collectVisibleFormatOptions(page).catch(() => []);
  const buttons = await page.evaluate(() => Array.from(document.querySelectorAll("button"))
    .filter((el) => el && el.getClientRects && el.getClientRects().length > 0)
    .map((el, index) => ({
      index,
      text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
      ariaLabel: el.getAttribute("aria-label") || "",
      title: el.getAttribute("title") || "",
      disabled: Boolean(el.disabled),
    }))
  ).catch(() => []);

  await page.screenshot({ path: path.join(dir, `${prefix}.png`), fullPage: true }).catch(() => {});
  await safeWriteDebug(dir, `${prefix}.html`, await page.content().catch(() => ""));
  await safeWriteDebug(dir, `${prefix}-texts.txt`, [
    `operationId=${operationId || ""}`,
    `attempt=${attempt}/${FORMAT_MODAL_RETRY_ATTEMPTS}`,
    `reason=${reason || ""}`,
    `url=${page.url()}`,
    `visibleFormatOptions=${visibleOptions.join(" | ")}`,
    "",
    bodyText,
  ].join("\n"));
  await safeWriteDebug(dir, `${prefix}-buttons.json`, `${JSON.stringify({ operationId, attempt, reason, buttons }, null, 2)}\n`);
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

  const optionLocator = page.locator('[role="option"], [id*="option"], div[class*="option"], [class*="option"], [role="menuitem"]');
  let visibleOptions = await collectVisibleFormatOptions(page);
  if (!visibleOptions.length) {
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ force: true });
    await sleep(400);
    visibleOptions = await collectVisibleFormatOptions(page);
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

  const optionCount = await optionLocator.count().catch(() => 0);
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

async function waitForPdfFormatOptions(page, operationId) {
  const deadline = Date.now() + FORMAT_MODAL_WAIT_MS;
  let lastReason = "format options were not visible";
  let modal = null;

  while (Date.now() < deadline) {
    modal = await waitForPrintModal(page);
    if (!modal) {
      lastReason = "print modal not visible";
      await sleep(500);
      continue;
    }

    const target = await findVisibleControlNearLabel(page, modal, "Формат файла");
    if (!target) {
      lastReason = "format control not visible";
      await sleep(500);
      continue;
    }

    const formatText = page.getByText(/CSV файл|PDF файл/i);
    const formatTextCount = await formatText.count().catch(() => 0);
    for (let index = 0; index < formatTextCount; index += 1) {
      if (await formatText.nth(index).isVisible().catch(() => false)) {
        return { modal, reason: "format text visible" };
      }
    }

    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ force: true }).catch(() => {});
    await sleep(400);

    const visibleOptions = await collectVisibleFormatOptions(page);
    if (visibleOptions.some((text) => /CSV файл|PDF файл/i.test(text))) {
      return { modal, reason: `format options visible: ${visibleOptions.join(" | ")}` };
    }

    lastReason = `format options missing: ${visibleOptions.join(" | ") || "no visible options"}`;
    await sleep(500);
  }

  return { modal: null, reason: lastReason };
}

async function closePrintModalAndReturnToTable(page) {
  const closeCandidates = [
    page.getByRole("button", { name: /отменить|закрыть|cancel|close/i }),
    page.locator('button[aria-label*="Закрыть"], button[aria-label*="Close"], button[title*="Закрыть"], button[title*="Close"]'),
  ];
  for (const candidate of closeCandidates) {
    if (await clickVisible(candidate).catch(() => false)) {
      await sleep(500);
      break;
    }
  }

  await page.keyboard.press("Escape").catch(() => {});
  await sleep(300);

  const backCandidates = [
    page.getByRole("button", { name: /назад к таблице/i }),
    page.getByRole("link", { name: /назад к таблице/i }),
    page.getByText(/назад к таблице/i),
  ];
  for (const candidate of backCandidates) {
    if (await clickVisible(candidate).catch(() => false)) {
      await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});
      return;
    }
  }

  await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});
}

async function openPrintModalWithFormatRetry(page, operation) {
  const operationId = operation.operationId;
  let lastReason = "format options were not visible";

  for (let attempt = 1; attempt <= FORMAT_MODAL_RETRY_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      await closePrintModalAndReturnToTable(page).catch(() => {});
    }

    await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT });
    await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});
    await openOperationFromList(page, operationId);
    await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});
    await dumpOperationPageUi(page, operationId).catch(() => {});

    await clickPrintEntry(page);
    const ready = await waitForPdfFormatOptions(page, operationId);
    if (ready.modal) return ready.modal;

    lastReason = ready.reason || lastReason;
    console.warn(`[FORMAT_RETRY] operationId=${operationId} attempt=${attempt}/${FORMAT_MODAL_RETRY_ATTEMPTS} reason=${lastReason}`);
    await captureFormatNotFoundDebug(page, operationId, attempt, lastReason).catch(() => {});
  }

  await closePrintModalAndReturnToTable(page).catch(() => {});
  throw new Error("KM_PDF_FORMAT_COMBOBOX_NOT_FOUND");
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
  const operationId = sanitizeFilePart(operation.operationId || "");
  const originalName = sanitizeFilePart(operation.productCode || operation.operationId || "operation");
  const targetBase = operationId || `unknown__${originalName}` || originalName || "operation";
  const targetPath = path.join(outputDir, `${targetBase}.pdf`);
  if (await fileExists(targetPath)) {
    return { filePath: targetPath, skipped: true };
  }

  const modal = await openPrintModalWithFormatRetry(page, operation);
  await selectPdfFormat(page, modal, operation.operationId);
  await sleep(3000);
  await page.getByText("Шаблон", { exact: false }).first().waitFor({ state: "visible", timeout: 10_000 });
  await selectTemplate(page);
  await sleep(500);

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

async function inspectAuthState(page) {
  const currentUrl = page.url();
  const currentTitle = await page.title().catch(() => "");
  const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
  const loginVisible = /(\b(login|sign[- ]?in|вход|авториз)\b)/i.test(`${currentTitle} ${bodyText}`);
  const operationsVisible = /(\b(operations|операции)\b)/i.test(`${currentTitle} ${bodyText}`);

  console.log(`PROFILE_DIR: ${SESSION_PROFILE_DIR}`);
  console.log(`CURRENT_URL: ${currentUrl}`);
  console.log(`CURRENT_TITLE: ${currentTitle}`);
  console.log(`LOGIN_VISIBLE: ${loginVisible ? "yes" : "no"}`);
  console.log(`OPERATIONS_VISIBLE: ${operationsVisible ? "yes" : "no"}`);

  return {
    currentUrl,
    currentTitle,
    loginVisible,
    operationsVisible,
  };
}

async function waitForManualLogin(page) {
  console.log("Войдите вручную и откройте операции, затем нажмите Enter");
  await new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.on("line", () => {
      rl.close();
      resolve();
    });
    process.stdin.resume();
  });

  const currentUrl = page.url();
  if (currentUrl.includes("/sign-in") || currentUrl.includes("/login")) {
    console.error("LOGIN_REQUIRED");
    throw new Error("LOGIN_REQUIRED");
  }
}

async function main() {
  if (LATEST_EMISSION_MODE && (!Number.isFinite(LIMIT) || LIMIT <= 0)) {
    throw new Error(`LIMIT_INVALID: ${process.env.LIMIT || "100"}`);
  }
  await ensureDir(OUTPUT_DIR);
  await ensureDir(path.dirname(FAILED_OPERATIONS_PATH));
  console.log(`DATE_FROM: ${DATE_FROM}`);
  console.log(`DATE_TO: ${DATE_TO}`);
  console.log(`ONLY_DATE: ${ONLY_DATE || "disabled"}`);
  console.log(`time range: ${TIME_RANGE_LABEL}`);
  console.log(`latest emission mode: ${LATEST_EMISSION_MODE ? "yes" : "no"}`);
  console.log(`latest emission retry: ${LATEST_EMISSION_RETRY ? "yes" : "no"}`);
  if (LATEST_EMISSION_MODE) console.log(`LIMIT: ${LIMIT}`);
  console.log(`output folder: ${OUTPUT_DIR}`);
  console.log(`retry failed only: ${RETRY_FAILED_ONLY ? "yes" : "no"}`);

  const authState = await readAuthHeaders();
  const loadedOperations = RETRY_FAILED_ONLY
    ? {
        rows: await loadFailedOperations(),
        totalOperationsBeforeLocalFilters: 0,
        totalOperationsAfterDateTimeFilters: 0,
        totalOperationsAfterStatusFilter: 0,
      }
    : await loadOperations(authState.headers);
  let operations = loadedOperations.rows;
  const operationTypeHistogramRows = operations;
  const limit = PDF_DEBUG_ONE
    ? 1
    : LATEST_EMISSION_MODE
      ? LIMIT
      : Number.isFinite(DEBUG_LIMIT) && DEBUG_LIMIT > 0
        ? DEBUG_LIMIT
        : operations.length;
  if (LATEST_EMISSION_MODE && !RETRY_FAILED_ONLY) {
    operations = operations
      .filter((operation) => isLatestEmissionOperation(operation.raw || operation))
      .sort((left, right) => {
        const leftTime = Date.parse(left.createdAt || "") || 0;
        const rightTime = Date.parse(right.createdAt || "") || 0;
        if (leftTime !== rightTime) return rightTime - leftTime;
        return String(left.operationId || "").localeCompare(String(right.operationId || ""));
      });
  }
  const selectedOperations = operations.slice(0, limit);
  const targets = selectedOperations;

  console.log(`total operations before local filters: ${loadedOperations.totalOperationsBeforeLocalFilters}`);
  console.log(`total operations after date/time filters: ${loadedOperations.totalOperationsAfterDateTimeFilters}`);
  if (LATEST_EMISSION_MODE && !RETRY_FAILED_ONLY) {
    console.log(`operations after status filter: ${loadedOperations.totalOperationsAfterStatusFilter}`);
    console.log("operation type histogram:");
    console.table(buildOperationTypeHistogram(operationTypeHistogramRows));
    console.log(`selected emission pdf operations: ${selectedOperations.length}`);
    console.log(`first selected operationId: ${selectedOperations[0]?.operationId || ""}`);
    console.log(`last selected operationId: ${selectedOperations[selectedOperations.length - 1]?.operationId || ""}`);
    console.table(selectedOperations.map((operation, index) => ({
      index: index + 1,
      operationId: operation.operationId,
      createdAt: operation.createdAt,
      status: operation.status,
      operationType: operation.operationType,
    })));
    await writeSelectedPdfOperationsDebug(selectedOperations);
  }
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

    const authStateView = await inspectAuthState(page);
    if ((authStateView.currentUrl.includes("/login") || authStateView.currentUrl.includes("/sign-in")) && !authStateView.operationsVisible) {
      await waitForManualLogin(page);
      const refreshedAuthState = await inspectAuthState(page);
      if ((refreshedAuthState.currentUrl.includes("/login") || refreshedAuthState.currentUrl.includes("/sign-in")) && !refreshedAuthState.operationsVisible) {
        throw new Error("LOGIN_REQUIRED");
      }
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
