const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const authHelper = require("./teksher-auth");

const PROJECT_DIR = __dirname;
const BASE_URL = "https://label.teksher.kg";
const AUTH_TOKENS_PATH = path.join(PROJECT_DIR, "auth_tokens.json");
const CSV_ENDPOINT = "/facade/api/v1/marking_codes/csv?operationId={operationId}";
const REQUEST_TIMEOUT = 45000;
const TARGET_OPERATION_TYPE = "MARK_CODE_ORDER";
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;
const LIST_RETRY_DELAYS_MS = [2000, 4000, 8000, 12000, 20000];
const MAX_PAGE_SCAN = 500;
const DEFAULT_DATE_FROM = "2026-05-17";
const DEFAULT_DATE_TO = "2026-05-18";
const DEBUG_OPERATIONS = String(process.env.DEBUG_OPERATIONS || "").trim() === "1";
const BROWSER_FILTER_MODE = String(process.env.BROWSER_FILTER_MODE || "").trim() === "1";

function getEnvDate(name, fallback) {
  const value = String(process.env[name] || "").trim();
  return value || fallback;
}

function formatDateDot(dateIso) {
  const text = String(dateIso || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return text.replace(/-/g, ".");
  return `${match[3]}.${match[2]}.${match[1]}`;
}

const DATE_FROM = getEnvDate("DATE_FROM", DEFAULT_DATE_FROM);
const DATE_TO = getEnvDate("DATE_TO", DEFAULT_DATE_TO);
const ONLY_DATE = String(process.env.ONLY_DATE || "").trim();
const ONLY_TIME_FROM = String(process.env.ONLY_TIME_FROM || "").trim();
const ONLY_TIME_TO = String(process.env.ONLY_TIME_TO || "").trim();
const FILTER_DATE = ONLY_DATE || DATE_TO;
const HAS_DATE_TO = String(process.env.DATE_TO || "").trim() !== "";
const USE_BROWSER_FILTER_MODE = BROWSER_FILTER_MODE && HAS_DATE_TO;
const HAS_TIME_FILTER = Boolean(ONLY_TIME_FROM && ONLY_TIME_TO);
const SELECTED_DATE = ONLY_DATE || DATE_FROM;
const TIME_RANGE_DIR_SUFFIX = HAS_TIME_FILTER ? `_${ONLY_TIME_FROM.replace(":", "-")}_${ONLY_TIME_TO.replace(":", "-")}` : "";
const OUTPUT_DIR = path.join(os.homedir(), "Desktop", "Текшер CSV", `${formatDateDot(SELECTED_DATE)}${TIME_RANGE_DIR_SUFFIX}`);
const LOG_PATH = path.join(PROJECT_DIR, `download_${SELECTED_DATE.replace(/-/g, "")}_km_csv_api_log.json`);
const LIST_ENDPOINT = buildListEndpoint();
const ONLY_TIME_FROM_MINUTES = HAS_TIME_FILTER ? parseTimeMinutes(ONLY_TIME_FROM, "ONLY_TIME_FROM") : null;
const ONLY_TIME_TO_MINUTES = HAS_TIME_FILTER ? parseTimeMinutes(ONLY_TIME_TO, "ONLY_TIME_TO") : null;
const TIME_RANGE_LABEL = HAS_TIME_FILTER ? `${ONLY_TIME_FROM}..${ONLY_TIME_TO}` : "disabled";

function buildListEndpoint() {
  if (USE_BROWSER_FILTER_MODE) {
    return `/facade/api/v1/operations/filter?size=15&page={page}&endDate=${DATE_TO}`;
  }
  return `/facade/api/v1/operations/filter?size=15&page={page}&startDate=${DATE_FROM}&endDate=${DATE_TO}`;
}

function parseTimeMinutes(value, name) {
  if (!value) return null;
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw new Error(`${name}_INVALID: expected HH:MM, got ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
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

function normalizeStatus(value) {
  return normalizeText(value).toUpperCase();
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

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildUrl(endpointPath) {
  return new URL(endpointPath, BASE_URL).toString();
}

function minuteKey(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 16) : "";
}

function normalizeDateOnly(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const ddmmyyyy = text.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (ddmmyyyy) return `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  return text.slice(0, 10);
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
  return pickText(record, ["operationId", "id"]);
}

function listAvailableFields(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];
  return Object.keys(record).sort();
}

function describeOperation(record) {
  return {
    operationId: extractOperationId(record),
    createdAt: extractCreatedAt(record),
    status: extractStatus(record),
    operationType: extractOperationType(record),
    name: pickText(record, ["operationTypeName", "name", "title", "description"]),
    productGroup: pickText(record, ["productGroup", "productGroupMarkingDto.name", "productGroupName"]),
    fields: listAvailableFields(record),
  };
}

function filterReasons(record) {
  const reasons = [];
  const createdAt = extractCreatedAt(record);
  const status = extractStatus(record);
  const operationType = extractOperationType(record);
  const dateOnly = parseDateOnly(createdAt);

  if (!createdAt) reasons.push("missing createdAt");
  else if (!dateOnly) reasons.push(`date parse failed (${createdAt})`);
  else if (USE_BROWSER_FILTER_MODE && dateOnly !== FILTER_DATE) reasons.push(`date mismatch (${dateOnly} != ${FILTER_DATE})`);
  else if (!USE_BROWSER_FILTER_MODE && dateOnly < DATE_FROM) reasons.push(`date before range (${dateOnly} < ${DATE_FROM})`);
  else if (!USE_BROWSER_FILTER_MODE && dateOnly >= DATE_TO) reasons.push(`date after range (${dateOnly} >= ${DATE_TO})`);
  else if (!isTargetTime(record)) {
    const timeText = String(createdAt || "").match(/(?:T|\s)((?:[01]\d|2[0-3]):[0-5]\d)/)?.[1] || "missing";
    reasons.push(`time mismatch (${timeText} not in ${ONLY_TIME_FROM || "00:00"}..${ONLY_TIME_TO || "23:59"})`);
  }

  if (operationType !== TARGET_OPERATION_TYPE) {
    reasons.push(`operationType mismatch (${operationType || "EMPTY"} != ${TARGET_OPERATION_TYPE})`);
  }

  if (status && status !== "ACCEPTED") {
    reasons.push(`status mismatch (${status} != ACCEPTED)`);
  }

  if (!status) reasons.push("missing status");
  if (!extractOperationId(record)) reasons.push("missing operationId");
  return reasons;
}

function extractStatus(record) {
  return normalizeStatus(pickText(record, ["status", "state", "operationStatus", "currentStatus", "documentStatus"]));
}

function extractOperationType(record) {
  return normalizeText(pickText(record, ["operationType", "type", "operation.type", "operationTypeCode"]));
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
  const normalized = normalizeDateOnly(value);
  return normalized && /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : "";
}

function parseCreatedAtTimeMinutes(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const timeMatch = text.match(/(?:T|\s)([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?/);
  if (!timeMatch) return null;
  return Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
}

function isTargetDate(record) {
  const value = String(extractCreatedAt(record) || "").trim();
  const dateOnly = parseDateOnly(value);
  if (!dateOnly) return false;
  if (USE_BROWSER_FILTER_MODE) return dateOnly === FILTER_DATE;
  return dateOnly >= DATE_FROM && dateOnly < DATE_TO;
}

function isTargetTime(record) {
  if (!HAS_TIME_FILTER) return true;
  const value = String(extractCreatedAt(record) || "").trim();
  const timeMinutes = parseCreatedAtTimeMinutes(value);
  if (timeMinutes === null) return false;
  if (ONLY_TIME_FROM_MINUTES !== null && timeMinutes < ONLY_TIME_FROM_MINUTES) return false;
  if (ONLY_TIME_TO_MINUTES !== null && timeMinutes > ONLY_TIME_TO_MINUTES) return false;
  return true;
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
      if (/^\d{14}$/.test(text)) return text;
      continue;
    }
    if (typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    const keys = Object.keys(current);
    for (const key of keys) {
      const lower = key.toLowerCase();
      const value = current[key];
      if (typeof value === "string" && value.trim()) {
        if (
          lower.includes("productcode") ||
          lower.includes("product_code") ||
          lower === "gtin" ||
          lower.endsWith("gtin") ||
          lower.includes("article") ||
          lower.includes("code") ||
          lower.includes("sku")
        ) {
          const text = value.trim();
          if (text) return text;
        }
      }
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return "";
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

async function fetchWithRetry(url, options = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
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
      source: "download-16may-km-csv-api",
    });
    accessToken = normalizeToken(refreshed.accessToken || "");
    refreshToken = normalizeToken(refreshed.refreshToken || refreshToken);
    tokenExpiresAtMs = authHelper.decodeJwtExpMs(accessToken);
    console.log("ACCESS_TOKEN_REFRESHED");
    console.log(`NEW_EXP ${tokenExpiresAtMs ? new Date(tokenExpiresAtMs).toISOString() : "n/a"}`);
  }

  if (!accessToken) throw new Error("TOKEN_MISSING: auth_tokens.json access_token not found");
  if (!tokenExpiresAtMs || tokenExpiresAtMs <= Date.now()) throw new Error("TOKEN_EXPIRED: auth_tokens.json access_token is expired");

  return {
    accessToken,
    tokenExpiresAtMs,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json, text/plain, */*",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/operations`,
    },
  };
}

async function fetchOperationDetail(operationId, headers) {
  const url = buildUrl(`/facade/api/v1/operations/${encodeURIComponent(operationId)}`);
  try {
    const response = await fetchWithRetry(url, {
      method: "GET",
      headers,
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { url, status: response.status, ok: response.ok, json, text };
  } catch (error) {
    console.error("DETAIL_ERROR");
    console.error(`operationId: ${operationId}`);
    console.error(`url: ${url}`);
    console.error(`error.name: ${error?.name || "n/a"}`);
    console.error(`error.message: ${error?.message || "n/a"}`);
    console.error(`error.stack: ${error?.stack || "n/a"}`);
    console.error(`error.cause: ${JSON.stringify(error?.cause, null, 2)}`);
    return null;
  }
}

async function fetchOperationListPage(pageNumber, headers) {
  const url = buildUrl(LIST_ENDPOINT.replace("{page}", String(pageNumber)));
  console.log(`LIST URL: ${url}`);
  let lastError = null;
  for (let attempt = 1; attempt <= LIST_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetchWithRetry(url, { method: "GET", headers });
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

async function loadOperations(headers) {
  const pages = [];
  let pageNumber = 0;
  let totalPages = null;
  const seenIds = new Set();
  const rows = [];
  const debugRows = [];
  const failedPages = [];
  let apiOperationCount = 0;
  let pagesScanned = 0;
  let operationsAfterDateFilter = 0;
  let operationsAfterTimeFilter = 0;
  while (pageNumber < MAX_PAGE_SCAN) {
    const page = await fetchOperationListPage(pageNumber, headers);
    pagesScanned += 1;
    if (!page.ok) {
      failedPages.push({
        page: pageNumber,
        status: page.status,
        url: page.url,
        reason: page.retryableFailedPage ? `HTTP ${page.status}` : `HTTP ${page.status}`,
      });
      pages.push(page);
      pageNumber += 1;
      if (typeof totalPages === "number" && pageNumber >= totalPages) break;
      continue;
    }

    pages.push(page);
    const items = extractCollection(page.json);
    apiOperationCount += items.length;
    totalPages = extractTotalPages(page.json) ?? totalPages;
    for (const item of items) {
      const operationId = extractOperationId(item);
      if (!operationId || seenIds.has(operationId)) continue;
      seenIds.add(operationId);
      const createdAt = extractCreatedAt(item);
      const status = extractStatus(item);
      const operationType = extractOperationType(item);
      const debugRow = describeOperation(item);
      const reasons = filterReasons(item);
      debugRows.push({
        ...debugRow,
        reasons,
      });
      if (!isTargetDate(item)) continue;
      operationsAfterDateFilter += 1;
      if (!isTargetTime(item)) continue;
      operationsAfterTimeFilter += 1;
      if (operationType !== TARGET_OPERATION_TYPE) continue;
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
    if (items.length < 15) break;
  }
  return {
    pages,
    rows,
    debugRows,
    failedPages,
    pagesScanned,
    apiOperationCount,
    operationsAfterDateFilter,
    operationsAfterTimeFilter,
  };
}

async function downloadCsv(operationId, headers, fileBase) {
  const url = buildUrl(CSV_ENDPOINT.replace("{operationId}", encodeURIComponent(operationId)));
  console.log(`CSV URL: ${url}`);
  const response = await fetchWithRetry(url, { method: "GET", headers });
  const contentType = response.headers.get("content-type") || "";
  const contentDisposition = response.headers.get("content-disposition") || "";
  const buffer = Buffer.from(await response.arrayBuffer());
  if (response.status === 404 || response.status === 409 || !buffer.length) {
    return { status: "skipped_not_ready", reason: "not ready", httpStatus: response.status, contentType, contentDisposition };
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}: ${buffer.toString("utf8").slice(0, 500)}`);
  }
  const targetPath = path.join(OUTPUT_DIR, `${fileBase}.csv`);
  if (await fileExists(targetPath)) {
    return { status: "skipped_existing", targetPath, httpStatus: response.status, contentType, contentDisposition };
  }
  await fs.writeFile(targetPath, buffer);
  return { status: "downloaded", targetPath, httpStatus: response.status, contentType, contentDisposition };
}

async function main() {
  await ensureDir(OUTPUT_DIR);
  const authState = await readAuthHeaders();
  console.log(`final LIST URL: ${buildUrl(LIST_ENDPOINT.replace("{page}", "0"))}`);
  const {
    rows,
    debugRows,
    failedPages,
    pagesScanned,
    apiOperationCount,
    operationsAfterDateFilter,
    operationsAfterTimeFilter,
  } = await loadOperations(authState.headers);
  const accepted = rows
    .filter((row) => normalizeStatus(row.status) === "ACCEPTED" || normalizeStatus(row.operationType) === TARGET_OPERATION_TYPE)
    .sort((a, b) => {
      const left = Date.parse(a.createdAt || "") || 0;
      const right = Date.parse(b.createdAt || "") || 0;
      if (left !== right) return left - right;
      return String(a.operationId || "").localeCompare(String(b.operationId || ""));
    });

  const detailCache = new Map();
  const fileBaseCounts = new Map();
  const results = [];
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  console.log(`selected date: ${SELECTED_DATE}`);
  console.log(`time range: ${TIME_RANGE_LABEL}`);
  console.log(`operations after date filter: ${operationsAfterDateFilter}`);
  console.log(`operations after time filter: ${operationsAfterTimeFilter}`);
  console.log(`total operations found: ${accepted.length}`);
  console.log(`output folder: ${OUTPUT_DIR}`);
  console.log(`token exp: ${new Date(authState.tokenExpiresAtMs).toISOString()}`);
  console.log(`debug operations: ${DEBUG_OPERATIONS ? "on" : "off"}`);

  if (DEBUG_OPERATIONS) {
    const firstDebugRows = debugRows.slice(0, 30);
    const uniqueDates = [...new Set(debugRows
      .map((row) => String(row.createdAt || "").slice(0, 10))
      .filter(Boolean))]
      .sort();

    console.log(`debug rows total: ${debugRows.length}`);
    console.log(`debug rows shown: ${firstDebugRows.length}`);
    console.log(`unique createdAt dates: ${uniqueDates.join(" | ")}`);

    for (const row of firstDebugRows) {
      console.log("--- DEBUG_OPERATION ---");
      console.log(JSON.stringify({
        operationId: row.operationId || "",
        createdAt: row.createdAt || "",
        date: String(row.createdAt || "").slice(0, 10),
        status: row.status || "",
        type: row.operationType || "",
        name: row.name || "",
        productGroup: row.productGroup || "",
        fields: row.fields || [],
        reasons: row.reasons || [],
      }, null, 2));
    }

    if (debugRows.length > 0) {
      const firstOperation = debugRows[0];
      console.log(`first operation keys: ${Object.keys(firstOperation).join(" | ")}`);
    }

    console.log("DEBUG_OPERATIONS_ONLY");
    return;
  }

  for (const operation of accepted) {
    try {
      let detail = detailCache.get(operation.operationId) || null;
      if (!detail) {
        detail = await fetchOperationDetail(operation.operationId, authState.headers);
        detailCache.set(operation.operationId, detail);
      }

      const detailValue = detail?.json || {};
      const productCode = sanitizeFilePart(
        extractProductCode(detailValue) ||
          extractProductCode(operation.raw) ||
          extractGtinLike(detailValue) ||
          extractGtinLike(operation.raw) ||
          operation.operationId,
      );
      const key = productCode || sanitizeFilePart(operation.operationId) || "operation";
      const count = (fileBaseCounts.get(key) || 0) + 1;
      fileBaseCounts.set(key, count);
      const fileBase = count === 1 ? key : `${key}_${count}`;

      const csvResult = await downloadCsv(operation.operationId, authState.headers, fileBase);
      if (csvResult.status === "downloaded") {
        downloaded += 1;
      } else {
        skipped += 1;
      }

      results.push({
        operationId: operation.operationId,
        createdAt: operation.createdAt,
        status: operation.status,
        fileBase,
        csvStatus: csvResult.status,
        filePath: csvResult.targetPath || "",
        productCode: productCode || "",
      });
    } catch (error) {
      failed += 1;
      results.push({
        operationId: operation.operationId,
        createdAt: operation.createdAt,
        status: operation.status,
        fileBase: "",
        csvStatus: `ERROR: ${error.message || String(error)}`,
        filePath: "",
        productCode: "",
      });
      console.error("OPERATION_ERROR");
      console.error(`operationId: ${operation.operationId}`);
      console.error(`error.name: ${error?.name || "n/a"}`);
      console.error(`error.message: ${error?.message || "n/a"}`);
      console.error(`error.stack: ${error?.stack || "n/a"}`);
      console.error(`error.cause: ${JSON.stringify(error?.cause, null, 2)}`);
    }
  }

  await writeJson(LOG_PATH, {
    generatedAt: new Date().toISOString(),
    selectedDate: SELECTED_DATE,
    timeRange: {
      enabled: HAS_TIME_FILTER,
      from: ONLY_TIME_FROM || "",
      to: ONLY_TIME_TO || "",
    },
    outputDir: OUTPUT_DIR,
    rows: results,
    totalPagesScanned: pagesScanned,
    failedPages,
    totalOperationsFromApi: apiOperationCount,
    operationsAfterDateFilter,
    operationsAfterTimeFilter,
    filteredOperations: accepted.length,
    downloadedCsv: downloaded,
    failed,
  });

  console.table(
    results.map((row) => ({
      operationId: row.operationId,
      createdAt: row.createdAt,
      status: row.status,
      fileBase: row.fileBase,
      csvStatus: row.csvStatus,
      filePath: row.filePath,
      productCode: row.productCode,
    })),
  );
  console.log(`total operations: ${accepted.length}`);
  console.log(`total pages scanned: ${pagesScanned}`);
  console.log(`failed pages: ${failedPages.length}`);
  console.log(`total operations from API: ${apiOperationCount}`);
  console.log(`selected date: ${SELECTED_DATE}`);
  console.log(`time range: ${TIME_RANGE_LABEL}`);
  console.log(`operations after date filter: ${operationsAfterDateFilter}`);
  console.log(`operations after time filter: ${operationsAfterTimeFilter}`);
  console.log(`filtered operations: ${accepted.length}`);
  console.log(`downloaded CSV: ${downloaded}`);
  console.log(`skipped: ${skipped}`);
  console.log(`failed: ${failed}`);
  console.log(`output folder: ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error("FATAL_ERROR");
  console.error(`error.name: ${error?.name || "n/a"}`);
  console.error(`error.message: ${error?.message || "n/a"}`);
  console.error(`error.stack: ${error?.stack || "n/a"}`);
  console.error(`error.cause: ${JSON.stringify(error?.cause, null, 2)}`);
  process.exitCode = 1;
});
