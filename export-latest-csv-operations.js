const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const authHelper = require("./teksher-auth");

const PROJECT_DIR = __dirname;
const BASE_URL = "https://label.teksher.kg";
const OPERATIONS_URL = `${BASE_URL}/operations`;
const AUTH_TOKENS_PATH = path.join(PROJECT_DIR, "auth_tokens.json");
const SESSION_PROFILE_DIR = path.resolve(PROJECT_DIR, "teksher-session-profile");
const PLAYWRIGHT_HOME = path.join(PROJECT_DIR, ".playwright-home");
const PAGE_SIZE = 15;
const REQUEST_TIMEOUT = 45_000;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3_000;
const LIST_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 12_000, 20_000];
const MAX_PAGE_SCAN = 500;
const CSV_ENDPOINT = "/facade/api/v1/marking_codes/csv?operationId={operationId}";
const ONLY_DATE = String(process.env.ONLY_DATE || "2026-05-20").trim();
const DATE_FROM = String(process.env.DATE_FROM || ONLY_DATE).trim();
const DATE_TO = String(process.env.DATE_TO || "2026-05-21").trim();
const LIMIT = Number.parseInt(String(process.env.LIMIT || "100").trim(), 10);
const RUN_TIMESTAMP = formatRunTimestamp(new Date());
const OUTPUT_DIR = path.join(os.homedir(), "Desktop", `NEW_${Number.isFinite(LIMIT) && LIMIT > 0 ? LIMIT : "INVALID"}_LATEST_CSV_${RUN_TIMESTAMP}`);
const REPORT_PATH = path.join(OUTPUT_DIR, "latest_csv_report.txt");
const LIST_ENDPOINT = `/facade/api/v1/operations/filter?size=${PAGE_SIZE}&page={page}&startDate=${DATE_FROM}&endDate=${DATE_TO}`;
const TARGET_STATUS = "ACCEPTED";
const TARGET_OPERATION_TYPE_CODE = "MARK_CODE_ORDER";
const TARGET_OPERATION_TYPE_TEXT = "Заказ на эмиссию КМ";
const RETRYABLE_HTTP_STATUSES = new Set([502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatRunTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeToken(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "").trim();
}

function looksLikeJwt(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.trim());
}

function normalizeStatus(value) {
  return normalizeText(value).toUpperCase();
}

function buildUrl(endpointPath) {
  return new URL(endpointPath, BASE_URL).toString();
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function pickPathValue(source, pathSpec) {
  const segments = String(pathSpec).split(".");
  let current = source;
  for (const segment of segments) {
    if (current == null) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else {
      current = current[segment];
    }
  }
  return current;
}

function pickText(source, pathSpecs) {
  for (const pathSpec of pathSpecs) {
    const value = pickPathValue(source, pathSpec);
    if (value === null || value === undefined) continue;
    const text = normalizeText(value);
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

function extractStatus(record) {
  return normalizeStatus(pickText(record, ["status", "state", "operationStatus", "currentStatus", "documentStatus"]));
}

function extractOperationTypeInfo(record) {
  const code = normalizeText(pickText(record, [
    "operationType",
    "operationTypeCode",
    "type",
    "code",
    "operation.type",
    "operation.code",
    "operation.operationType",
    "operation.operationTypeCode",
    "operationCode",
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
  const label = [code, name].filter(Boolean).join(" | ") || "UNKNOWN";
  return { code, name, label };
}

function isEmissionOperation(record) {
  const typeInfo = extractOperationTypeInfo(record);
  const joined = `${typeInfo.code} ${typeInfo.name}`.toUpperCase();
  return (
    joined.includes(TARGET_OPERATION_TYPE_CODE)
    || joined.includes(TARGET_OPERATION_TYPE_TEXT.toUpperCase())
    || (/EMISS/i.test(joined) && /MARK|CODE|KM|КМ/i.test(joined))
  );
}

function buildOperationTypeHistogram(rows) {
  const histogram = new Map();
  for (const row of rows) {
    const label = row.operationTypeLabel || extractOperationTypeInfo(row.raw).label;
    histogram.set(label, (histogram.get(label) || 0) + 1);
  }
  return [...histogram.entries()]
    .map(([operationType, count]) => ({ operationType, count }))
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return left.operationType.localeCompare(right.operationType);
    });
}

function normalizeDateOnly(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const ddmmyyyy = text.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (ddmmyyyy) return `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  return text.slice(0, 10);
}

function isTargetDate(record) {
  return normalizeDateOnly(extractCreatedAt(record)) === ONLY_DATE;
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

async function fetchWithRetry(url, options = {}, retryDelays = null) {
  const delays = retryDelays || Array.from({ length: RETRY_ATTEMPTS - 1 }, () => RETRY_DELAY_MS);
  let lastError = null;
  for (let attempt = 1; attempt <= delays.length + 1; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options);
      if (RETRYABLE_HTTP_STATUSES.has(response.status) && attempt <= delays.length) {
        const body = await response.text().catch(() => "");
        const delay = delays[attempt - 1];
        console.warn(`HTTP_RETRY attempt=${attempt}/${delays.length + 1} http=${response.status} delay=${delay}ms url=${url}`);
        if (body) console.warn(`HTTP_RETRY body=${body.slice(0, 300)}`);
        await sleep(delay);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt <= delays.length && isRetryableFetchError(error)) {
        const delay = delays[attempt - 1];
        console.warn(`FETCH_RETRY attempt=${attempt}/${delays.length + 1} delay=${delay}ms url=${url}`);
        console.warn(`FETCH_RETRY reason=${error?.cause?.code || error?.message || error}`);
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error(`Request failed: ${url}`);
}

function collectTokenCandidates(value, source, out = []) {
  if (value == null) return out;
  if (typeof value === "string") {
    const trimmed = value.trim();
    const bearer = trimmed.match(/Bearer\s+([A-Za-z0-9_.-]+)/i);
    if (bearer) out.push({ token: bearer[1], source });
    if (looksLikeJwt(trimmed)) out.push({ token: trimmed, source });
    if (/(access|auth|authorization|jwt|token)/i.test(source) && !/refresh/i.test(source) && trimmed.length > 20 && !/\s/.test(trimmed)) {
      out.push({ token: trimmed.replace(/^Bearer\s+/i, ""), source });
    }
    try {
      collectTokenCandidates(JSON.parse(trimmed), source, out);
    } catch {}
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTokenCandidates(item, source, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      collectTokenCandidates(nested, `${source}.${key}`, out);
    }
  }
  return out;
}

function chooseValidAccessToken(candidates) {
  const unique = candidates
    .map((item) => ({
      source: item.source,
      token: normalizeToken(item.token),
      expMs: authHelper.decodeJwtExpMs(item.token),
    }))
    .filter((item, index, arr) => (
      item.token
      && item.expMs > Date.now() + 60_000
      && !/refresh/i.test(item.source)
      && arr.findIndex((candidate) => candidate.token === item.token) === index
    ));

  unique.sort((left, right) => {
    if (right.expMs !== left.expMs) return right.expMs - left.expMs;
    return String(left.source || "").localeCompare(String(right.source || ""));
  });
  return unique[0] || null;
}

async function extractSessionAccessToken() {
  await ensureDir(PLAYWRIGHT_HOME);
  const context = await chromium.launchPersistentContext(SESSION_PROFILE_DIR, {
    headless: false,
    acceptDownloads: false,
    viewport: { width: 1440, height: 1200 },
    args: ["--disable-crash-reporter", "--disable-crashpad"],
    env: {
      ...process.env,
      HOME: PLAYWRIGHT_HOME,
    },
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(REQUEST_TIMEOUT);
    page.setDefaultNavigationTimeout(REQUEST_TIMEOUT);
    await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT });
    await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});

    const storage = await page.evaluate(() => {
      const readStorage = (store) => {
        const values = {};
        for (let index = 0; index < store.length; index += 1) {
          const key = store.key(index);
          values[key] = store.getItem(key);
        }
        return values;
      };
      return {
        localStorage: readStorage(window.localStorage),
        sessionStorage: readStorage(window.sessionStorage),
      };
    });

    const cookies = await context.cookies(BASE_URL).catch(() => []);
    const candidates = [];
    collectTokenCandidates(storage.localStorage, "profile.localStorage", candidates);
    collectTokenCandidates(storage.sessionStorage, "profile.sessionStorage", candidates);
    for (const cookie of cookies) {
      collectTokenCandidates(cookie.value, `profile.cookie.${cookie.name}`, candidates);
    }

    return chooseValidAccessToken(candidates);
  } finally {
    await context.close().catch(() => {});
  }
}

async function readAuthHeaders() {
  const candidates = await authHelper.readAuthCandidatesFromFiles([
    { path: AUTH_TOKENS_PATH, source: "auth_tokens.json" },
  ]);
  const accessCandidate = authHelper.chooseAccessToken(candidates);

  let accessToken = normalizeToken(accessCandidate?.token || "");
  let tokenExpiresAtMs = authHelper.decodeJwtExpMs(accessToken);
  const isExpired = !accessToken || !tokenExpiresAtMs || tokenExpiresAtMs <= Date.now() + 60_000;

  console.log(`ACCESS_TOKEN_SOURCE: ${accessCandidate?.source || "missing"}`);
  console.log(`ACCESS_TOKEN_EXP: ${tokenExpiresAtMs ? new Date(tokenExpiresAtMs).toISOString() : "n/a"}`);
  console.log(`ACCESS_TOKEN_EXPIRED: ${isExpired ? "yes" : "no"}`);

  let authSource = accessCandidate?.source || "auth_tokens.json";
  if (isExpired) {
    console.log(`SESSION_PROFILE_DIR: ${SESSION_PROFILE_DIR}`);
    console.log("ACCESS_TOKEN_PROFILE_LOOKUP: start");
    const sessionCandidate = await extractSessionAccessToken();
    if (sessionCandidate) {
      accessToken = normalizeToken(sessionCandidate.token);
      tokenExpiresAtMs = sessionCandidate.expMs;
      authSource = sessionCandidate.source;
      const existingAuthRecord = await readJsonIfExists(AUTH_TOKENS_PATH, {});
      await writeJson(AUTH_TOKENS_PATH, {
        ...existingAuthRecord,
        access_token: accessToken,
        savedAt: new Date().toISOString(),
        source: "login-profile-session",
      });
      console.log(`ACCESS_TOKEN_PROFILE_SOURCE: ${sessionCandidate.source}`);
      console.log(`ACCESS_TOKEN_PROFILE_EXP: ${new Date(tokenExpiresAtMs).toISOString()}`);
    }
  }

  if (!accessToken) throw new Error("TOKEN_MISSING: Run npm run manual-token or npm run login-profile");
  if (!tokenExpiresAtMs || tokenExpiresAtMs <= Date.now()) {
    throw new Error("TOKEN_EXPIRED: Run npm run manual-token or npm run login-profile");
  }

  console.log(`AUTH_SOURCE: ${authSource}`);

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

async function fetchJson(url, headers, context) {
  const response = await fetchWithRetry(url, { method: "GET", headers }, LIST_RETRY_DELAYS_MS);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw new Error(`${context} HTTP ${response.status} for ${url}: ${text.slice(0, 500)}`);
  }
  if (!json) {
    throw new Error(`${context} JSON_PARSE_FAILED for ${url}: ${text.slice(0, 500)}`);
  }
  return json;
}

async function fetchOperationListPage(pageNumber, headers) {
  const url = buildUrl(LIST_ENDPOINT.replace("{page}", String(pageNumber)));
  console.log(`LIST URL: ${url}`);
  const json = await fetchJson(url, headers, `LIST page=${pageNumber}`);
  return { url, json };
}

async function loadOperations(headers) {
  const seenIds = new Set();
  const rows = [];
  let pageNumber = 0;
  let totalPages = null;
  let totalOperationsFromApi = 0;
  let operationsAfterDateFilter = 0;
  let operationsAfterStatusFilter = 0;

  while (pageNumber < MAX_PAGE_SCAN) {
    const page = await fetchOperationListPage(pageNumber, headers);
    const items = extractCollection(page.json);
    totalPages = extractTotalPages(page.json) ?? totalPages;
    totalOperationsFromApi += items.length;

    for (const item of items) {
      const operationId = extractOperationId(item);
      if (!operationId || seenIds.has(operationId)) continue;
      seenIds.add(operationId);
      if (!isTargetDate(item)) continue;
      operationsAfterDateFilter += 1;
      const status = extractStatus(item);
      if (status !== TARGET_STATUS) continue;
      operationsAfterStatusFilter += 1;
      const operationTypeInfo = extractOperationTypeInfo(item);
      rows.push({
        operationId,
        createdAt: extractCreatedAt(item),
        status,
        operationType: operationTypeInfo.code,
        operationName: operationTypeInfo.name,
        operationTypeLabel: operationTypeInfo.label,
        raw: item,
      });
    }

    pageNumber += 1;
    if (typeof totalPages === "number" && pageNumber >= totalPages) break;
    if (items.length < PAGE_SIZE) break;
  }

  return {
    rows,
    pagesScanned: pageNumber,
    totalOperationsFromApi,
    operationsAfterDateFilter,
    operationsAfterStatusFilter,
  };
}

function compareCreatedAtDesc(left, right) {
  const leftTime = Date.parse(left.createdAt || "") || 0;
  const rightTime = Date.parse(right.createdAt || "") || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return String(left.operationId || "").localeCompare(String(right.operationId || ""));
}

function buildCsvFileName(index, operationId) {
  return `${String(index).padStart(3, "0")}__${operationId}.csv`;
}

async function downloadCsv(operationId, headers, targetPath) {
  if (await fileExists(targetPath)) {
    return { status: "skipped_existing", filePath: targetPath };
  }

  const url = buildUrl(CSV_ENDPOINT.replace("{operationId}", encodeURIComponent(operationId)));
  console.log(`CSV URL: ${url}`);
  const response = await fetchWithRetry(url, { method: "GET", headers });
  const contentType = response.headers.get("content-type") || "";
  const contentDisposition = response.headers.get("content-disposition") || "";
  const buffer = Buffer.from(await response.arrayBuffer());

  if (response.status === 404 || response.status === 409 || !buffer.length) {
    return {
      status: "skipped_not_ready",
      filePath: "",
      httpStatus: response.status,
      contentType,
      contentDisposition,
    };
  }

  if (!response.ok) {
    throw new Error(`CSV HTTP ${response.status} for ${url}: ${buffer.toString("utf8").slice(0, 500)}`);
  }

  await fs.writeFile(targetPath, buffer);
  return {
    status: "downloaded",
    filePath: targetPath,
    httpStatus: response.status,
    contentType,
    contentDisposition,
  };
}

async function writeReport(rows) {
  const lines = [
    "index\toperationId\tcreatedAt\tstatus\tfileName",
    ...rows.map((row) => [
      row.index,
      row.operationId,
      row.createdAt || "",
      row.status || "",
      row.fileName || "",
    ].join("\t")),
    "",
  ];
  await fs.writeFile(REPORT_PATH, lines.join("\n"), "utf8");
}

async function main() {
  if (!Number.isFinite(LIMIT) || LIMIT <= 0) throw new Error(`LIMIT_INVALID: ${process.env.LIMIT || "100"}`);
  await ensureDir(OUTPUT_DIR);

  const authState = await readAuthHeaders();
  console.log(`ONLY_DATE: ${ONLY_DATE}`);
  console.log(`DATE_FROM: ${DATE_FROM}`);
  console.log(`DATE_TO: ${DATE_TO}`);
  console.log(`LIMIT: ${LIMIT}`);
  console.log(`target status: ${TARGET_STATUS}`);
  console.log(`output folder: ${OUTPUT_DIR}`);
  console.log(`report: ${REPORT_PATH}`);
  console.log(`final LIST URL: ${buildUrl(LIST_ENDPOINT.replace("{page}", "0"))}`);
  console.log(`token exp: ${new Date(authState.tokenExpiresAtMs).toISOString()}`);

  const loaded = await loadOperations(authState.headers);
  console.log(`total operations from API: ${loaded.totalOperationsFromApi}`);
  console.log(`operations after date filter: ${loaded.operationsAfterDateFilter}`);
  console.log(`operations after status filter: ${loaded.operationsAfterStatusFilter}`);
  console.log("operation type histogram:");
  console.table(buildOperationTypeHistogram(loaded.rows));

  const emissionOperations = loaded.rows.filter((operation) => isEmissionOperation(operation.raw));
  const operations = emissionOperations.sort(compareCreatedAtDesc);
  const selectedOperations = operations.slice(0, LIMIT);
  console.log("selected emission operations:", selectedOperations.length);

  const results = [];
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (let index = 0; index < selectedOperations.length; index += 1) {
    const operation = selectedOperations[index];
    const oneBasedIndex = index + 1;
    const fileName = buildCsvFileName(oneBasedIndex, operation.operationId);
    const targetPath = path.join(OUTPUT_DIR, fileName);

    try {
      const csvResult = await downloadCsv(operation.operationId, authState.headers, targetPath);
      if (csvResult.status === "downloaded") downloaded += 1;
      else skipped += 1;

      results.push({
        index: oneBasedIndex,
        operationId: operation.operationId,
        createdAt: operation.createdAt,
        status: operation.status,
        fileName,
        filePath: csvResult.filePath || "",
        csvStatus: csvResult.status,
      });
    } catch (error) {
      failed += 1;
      results.push({
        index: oneBasedIndex,
        operationId: operation.operationId,
        createdAt: operation.createdAt,
        status: operation.status,
        fileName,
        filePath: "",
        csvStatus: "failed",
        error: error?.message || String(error),
      });
      console.error("OPERATION_ERROR");
      console.error(`index: ${oneBasedIndex}`);
      console.error(`operationId: ${operation.operationId}`);
      console.error(`error.name: ${error?.name || "n/a"}`);
      console.error(`error.message: ${error?.message || "n/a"}`);
      console.error(`error.cause: ${JSON.stringify(error?.cause, null, 2)}`);
    }
  }

  await writeReport(results);

  console.table(results.map((row) => ({
    index: row.index,
    operationId: row.operationId,
    createdAt: row.createdAt,
    status: row.status,
    fileName: row.fileName,
    csvStatus: row.csvStatus,
  })));
  console.log(`downloaded CSV: ${downloaded}`);
  console.log(`skipped: ${skipped}`);
  console.log(`failed: ${failed}`);
  console.log(`output folder: ${OUTPUT_DIR}`);
  console.log(`report: ${REPORT_PATH}`);
}

main().catch((error) => {
  console.error("FATAL_ERROR");
  console.error(`error.name: ${error?.name || "n/a"}`);
  console.error(`error.message: ${error?.message || "n/a"}`);
  console.error(`error.stack: ${error?.stack || "n/a"}`);
  console.error(`error.cause: ${JSON.stringify(error?.cause, null, 2)}`);
  process.exitCode = 1;
});
