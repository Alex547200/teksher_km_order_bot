const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const authHelper = require("./teksher-auth");

const PROJECT_DIR = __dirname;
const BASE_URL = "https://label.teksher.kg";
const TEKSHER_HOST = "label.teksher.kg";
const TEKSHER_IP = process.env.TEKSHER_API_IP || "109.71.231.11";
const AUTH_TOKENS_PATH = path.join(PROJECT_DIR, "auth_tokens.json");
const NETWORK_DISCOVERY_PATH = path.join(PROJECT_DIR, "operations_network_discovery.json");
const SESSION_PROFILE_DIR = path.join(PROJECT_DIR, "teksher-session-profile");
const TMP_DIR = path.join(PROJECT_DIR, "tmp");
const DEFAULT_DATE_FROM = todayLocalDate();
const DEFAULT_DATE_TO = nextDateIso(DEFAULT_DATE_FROM);
const DATE_FROM = getEnvDate("DATE_FROM", DEFAULT_DATE_FROM);
const DATE_TO = getEnvDate("DATE_TO", DEFAULT_DATE_TO);
const LIST_ENDPOINT = `/facade/api/v1/operations/filter?size=15&page={page}&startDate=${DATE_FROM}&endDate=${DATE_TO}`;
const TARGET_OPERATION_TYPE = "MARK_CODE_ORDER";
const OUTPUT_DIR = path.join(os.homedir(), "Desktop", "Текшер PDF", formatDateDot(DATE_FROM));
const API_OUTPUT_DIR = OUTPUT_DIR;
const UI_OUTPUT_DIR = OUTPUT_DIR;
const LOG_PATH = path.join(PROJECT_DIR, `download_${DATE_FROM.replace(/-/g, "")}_km_pdf_log.json`);
const REQUEST_TIMEOUT = 45_000;
const DOWNLOAD_TIMEOUT = 60_000;
const PRINT_TEMPLATE_VARIANTS = [
  "Data matrix код - горизонтальный с описанием товара",
  "Data Matrix код - горизонтальный с описанием товара",
  "Data Matrix код — горизонтальный с описанием товара",
  "Data Matrix код горизонтальный с описанием товара",
];

const PDF_ENDPOINT_CANDIDATES = [
  "/facade/api/v1/marking_codes/pdf?operationId={operationId}",
  "/facade/api/v1/marking_codes/print?operationId={operationId}",
  "/facade/api/v1/operations/{operationId}/pdf",
  "/facade/api/v1/operations/{operationId}/print",
  "/facade/order/api/v1/operations/{operationId}/pdf",
  "/facade/order/api/v1/operations/{operationId}/print",
  "/facade/api/v1/print_forms?operationId={operationId}",
  "/facade/api/v1/templates?operationId={operationId}",
  "/facade/api/v1/report?operationId={operationId}",
  "/facade/api/v1/document?operationId={operationId}",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getEnvDate(name, fallback) {
  const value = String(process.env[name] || "").trim();
  return value || fallback;
}

function todayLocalDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function nextDateIso(dateIso) {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
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

function startsWithPdfMagic(buffer) {
  return Buffer.isBuffer(buffer) && buffer.slice(0, 5).toString("utf8") === "%PDF-";
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

function formatDateDot(dateIso) {
  const text = String(dateIso || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return text.replace(/-/g, ".");
  return `${match[3]}.${match[2]}.${match[1]}`;
}

function buildUrl(endpointPath, useIp = false) {
  const base = useIp ? `https://${TEKSHER_IP}` : BASE_URL;
  return new URL(endpointPath, base).toString();
}

function withHostHeader(headers = {}, url = "") {
  const next = { ...headers };
  if (String(url).includes(TEKSHER_IP) && !next.Host && !next.host) {
    next.Host = TEKSHER_HOST;
  }
  return next;
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

async function writeText(filePath, text) {
  await fs.writeFile(filePath, text, "utf8");
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function isTargetDate(record) {
  const value = String(extractCreatedAt(record) || "").trim();
  const dateOnly = normalizeDateOnly(value);
  if (!dateOnly) return false;
  return dateOnly >= DATE_FROM && dateOnly < DATE_TO;
}

function extractProductCode(value) {
  const seen = new Set();
  const queue = [value];
  while (queue.length) {
    const current = queue.shift();
    if (current == null) continue;
    if (typeof current === "string") {
      const text = current.trim();
      if (/^\d{14,20}$/.test(text)) return text;
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
          return nested.trim();
        }
      }
      if (nested && typeof nested === "object") queue.push(nested);
    }
  }
  return "";
}

function extractPdfUrlFromJson(value) {
  const queue = [{ value, keyPath: "" }];
  const seen = new Set();
  while (queue.length) {
    const { value: current, keyPath } = queue.shift();
    if (current == null) continue;
    if (typeof current === "string") {
      const text = current.trim();
      if (!text) continue;
      if (/(file|url|download|link|pdf)/i.test(keyPath) || /\.pdf(\?|$)/i.test(text) || /^https?:\/\//i.test(text) || text.startsWith("/")) {
        return text;
      }
      continue;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => queue.push({ value: item, keyPath: `${keyPath}[${index}]` }));
      continue;
    }
    if (typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const [key, nested] of Object.entries(current)) {
      queue.push({ value: nested, keyPath: keyPath ? `${keyPath}.${key}` : key });
    }
  }
  return "";
}

async function readResponsePayload(response) {
  const contentType = response.headers.get("content-type") || "";
  const contentDisposition = response.headers.get("content-disposition") || "";
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = buffer.toString("utf8");
  let json = null;
  const trimmed = text.trim();
  if (contentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { buffer, text, json, contentType, contentDisposition };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Request timeout")), REQUEST_TIMEOUT);
  const headers = withHostHeader(options.headers, url);
  try {
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

async function fetchApi(endpointPath, options = {}) {
  const primaryUrl = buildUrl(endpointPath, false);
  try {
    return { response: await fetchWithTimeout(primaryUrl, options), url: primaryUrl };
  } catch (error) {
    if (!isNetworkFetchError(error)) throw error;
    const fallbackUrl = buildUrl(endpointPath, true);
    console.log(`FETCH_RETRY_IP: ${fallbackUrl}`);
    return { response: await fetchWithTimeout(fallbackUrl, options), url: fallbackUrl };
  }
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

  if (!accessToken) throw new Error("TOKEN_MISSING: auth_tokens.json access_token not found");

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

function looksLikeRefreshEndpointFailure(error) {
  const text = `${error?.message || ""}\n${error?.responseText || ""}\n${error?.stack || ""}`.toLowerCase();
  return text.includes("405") || text.includes("not allowed") || text.includes("nginx") || text.includes("<html") || text.includes("text/html");
}

async function fetchOperationListPage(pageNumber, headers) {
  const endpoint = LIST_ENDPOINT.replace("{page}", String(pageNumber));
  const { response, url } = await fetchApi(endpoint, { method: "GET", headers });
  console.log(`LIST URL: ${url}`);
  const payload = await readResponsePayload(response);
  return { url, status: response.status, ok: response.ok, ...payload };
}

function summarizeDiscoveryFile() {
  try {
    if (!fsSync.existsSync(NETWORK_DISCOVERY_PATH)) return [];
    const text = fsSync.readFileSync(NETWORK_DISCOVERY_PATH, "utf8");
    const candidates = [];
    for (const match of text.matchAll(/https:\/\/label\.teksher\.kg\/[^\s"'\\]+/g)) {
      const url = match[0];
      if (/pdf|print|document|report|template|marking_codes/i.test(url)) candidates.push(url);
    }
    return [...new Set(candidates)];
  } catch {
    return [];
  }
}

async function loadOperations(headers, refreshToken) {
  const pages = [];
  let pageNumber = 0;
  let totalPages = null;
  const seenIds = new Set();
  const rows = [];
  const requestHeaders = { ...headers };
  let refreshedOnce = false;

  async function fetchPageWithRefresh(pageNum) {
    const retryStatuses = new Set([502, 503, 504]);
    const maxAttempts = 5;

    async function fetchWithRetry(currentHeaders) {
      let lastPage = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const page = await fetchOperationListPage(pageNum, currentHeaders);
        lastPage = page;
        if (!retryStatuses.has(page.status)) return page;
        console.log(`LIST_RETRY attempt ${attempt}/${maxAttempts} HTTP ${page.status} page=${pageNum}`);
        if (attempt < maxAttempts) {
          await sleep(3000);
        }
      }
      return lastPage;
    }

    const firstAttempt = await fetchWithRetry(requestHeaders);
    if (firstAttempt.status !== 401) return firstAttempt;
    if (refreshedOnce) return firstAttempt;
    refreshedOnce = true;
    if (!refreshToken) {
      throw new Error("TOKEN_REFRESH_FAILED_RUN_MANUAL_TOKEN: refresh_token missing");
    }
    try {
      const refreshed = await authHelper.refreshAuthToken(refreshToken, {
        authTokensPath: AUTH_TOKENS_PATH,
        source: "download-16may-km-pdf-api-or-ui",
      });
      requestHeaders.Authorization = `Bearer ${refreshed.accessToken}`;
      console.log("ACCESS_TOKEN_REFRESHED");
      console.log(`NEW_EXP ${refreshed.tokenExpiresAt || "n/a"}`);
      return await fetchWithRetry(requestHeaders);
    } catch (refreshError) {
      if (looksLikeRefreshEndpointFailure(refreshError)) {
        console.error("TOKEN_REFRESH_FAILED_RUN_MANUAL_TOKEN");
        console.error(`error.name: ${refreshError?.name || "n/a"}`);
        console.error(`error.message: ${refreshError?.message || "n/a"}`);
        console.error(`error.stack: ${refreshError?.stack || "n/a"}`);
        console.error(`error.cause: ${JSON.stringify(refreshError?.cause, null, 2)}`);
        throw new Error("TOKEN_REFRESH_FAILED_RUN_MANUAL_TOKEN");
      }
      throw refreshError;
    }
  }

  while (true) {
    const page = await fetchPageWithRefresh(pageNumber);
    if (!page.ok) {
      throw new Error(`List endpoint failed with HTTP ${page.status}`);
    }
    pages.push(page);
    const items = extractCollection(page.json);
    totalPages = extractTotalPages(page.json) ?? totalPages;
    for (const item of items) {
      const operationId = extractOperationId(item);
      if (!operationId || seenIds.has(operationId)) continue;
      seenIds.add(operationId);
      const createdAt = extractCreatedAt(item);
      const status = extractStatus(item);
      const operationType = extractOperationType(item);
      if (!isTargetDate(item)) continue;
      if (operationType !== TARGET_OPERATION_TYPE) continue;
      if (status && status !== "ACCEPTED") continue;
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

  rows.sort((a, b) => {
    const left = Date.parse(a.createdAt || "") || 0;
    const right = Date.parse(b.createdAt || "") || 0;
    if (left !== right) return left - right;
    return String(a.operationId || "").localeCompare(String(b.operationId || ""));
  });
  return { pages, rows };
}

async function fetchOperationDetail(operationId, headers) {
  const endpoint = `/facade/api/v1/operations/${encodeURIComponent(operationId)}`;
  try {
    const { response, url } = await fetchApi(endpoint, { method: "GET", headers });
    const payload = await readResponsePayload(response);
    return { url, status: response.status, ok: response.ok, ...payload };
  } catch (error) {
    const url = buildUrl(endpoint);
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

async function probePdfApi(operation, headers, sampleUrls = []) {
  const templates = [...PDF_ENDPOINT_CANDIDATES];
  for (const template of sampleUrls) {
    if (typeof template === "string" && template.includes("{operationId}") && !templates.includes(template)) {
      templates.push(template);
    }
  }

  for (const template of templates) {
    const url = buildUrl(template.replace("{operationId}", encodeURIComponent(operation.operationId)));
    console.log(`PDF PROBE URL: ${url}`);
    try {
      const response = await fetchWithTimeout(url, { method: "GET", headers });
      const payload = await readResponsePayload(response);
      const directPdf = response.ok && (payload.contentType.includes("pdf") || startsWithPdfMagic(payload.buffer));
      if (directPdf) {
        return {
          template,
          mode: "direct",
          probeUrl: url,
          status: response.status,
          contentType: payload.contentType,
          contentDisposition: payload.contentDisposition,
        };
      }

      const jsonUrl = extractPdfUrlFromJson(payload.json);
      if (response.ok && jsonUrl) {
        const resolvedUrl = jsonUrl.startsWith("http")
          ? jsonUrl
          : jsonUrl.startsWith("/")
            ? buildUrl(jsonUrl)
            : buildUrl(`/${jsonUrl}`);
        console.log(`PDF FOLLOW URL: ${resolvedUrl}`);
        const followResponse = await fetchWithTimeout(resolvedUrl, { method: "GET", headers });
        const followPayload = await readResponsePayload(followResponse);
        const followPdf = followResponse.ok && (followPayload.contentType.includes("pdf") || startsWithPdfMagic(followPayload.buffer));
        if (followPdf) {
          return {
            template,
            mode: "json-follow",
            probeUrl: url,
            followUrl: resolvedUrl,
            status: followResponse.status,
            contentType: followPayload.contentType,
            contentDisposition: followPayload.contentDisposition,
          };
        }
      }
    } catch (error) {
      console.error("PDF_PROBE_ERROR");
      console.error(`operationId: ${operation.operationId}`);
      console.error(`template: ${template}`);
      console.error(`error.name: ${error?.name || "n/a"}`);
      console.error(`error.message: ${error?.message || "n/a"}`);
      console.error(`error.stack: ${error?.stack || "n/a"}`);
      console.error(`error.cause: ${JSON.stringify(error?.cause, null, 2)}`);
    }
  }

  return null;
}

async function downloadPdfViaApi(operation, headers, fileBase, pdfStrategy) {
  const url = buildUrl(pdfStrategy.template.replace("{operationId}", encodeURIComponent(operation.operationId)));
  const targetPath = path.join(API_OUTPUT_DIR, `${fileBase}.pdf`);
  console.log(`PDF URL: ${url}`);

  if (await fileExists(targetPath)) {
    return { status: "skipped_existing", targetPath, httpStatus: 0, contentType: "", contentDisposition: "", mode: "api" };
  }

  const response = await fetchWithTimeout(url, { method: "GET", headers });
  const payload = await readResponsePayload(response);

  if (response.status === 404 || response.status === 409 || !payload.buffer.length) {
    return {
      status: "skipped_not_ready",
      reason: "not ready",
      httpStatus: response.status,
      contentType: payload.contentType,
      contentDisposition: payload.contentDisposition,
      mode: "api",
    };
  }

  if (!response.ok && !payload.json) {
    throw new Error(`HTTP ${response.status} for ${url}: ${payload.text.slice(0, 500)}`);
  }

  let finalBuffer = payload.buffer;
  let finalContentType = payload.contentType;
  let finalContentDisposition = payload.contentDisposition;
  let finalUrl = url;

  if (!(payload.contentType.includes("pdf") || startsWithPdfMagic(payload.buffer))) {
    const candidateUrl = extractPdfUrlFromJson(payload.json);
    if (candidateUrl) {
      const resolvedUrl = candidateUrl.startsWith("http")
        ? candidateUrl
        : candidateUrl.startsWith("/")
          ? buildUrl(candidateUrl)
          : buildUrl(`/${candidateUrl}`);
      console.log(`PDF FOLLOW URL: ${resolvedUrl}`);
      const followResponse = await fetchWithTimeout(resolvedUrl, { method: "GET", headers });
      const followPayload = await readResponsePayload(followResponse);
      if (!followResponse.ok) {
        throw new Error(`HTTP ${followResponse.status} for ${resolvedUrl}: ${followPayload.text.slice(0, 500)}`);
      }
      finalBuffer = followPayload.buffer;
      finalContentType = followPayload.contentType;
      finalContentDisposition = followPayload.contentDisposition;
      finalUrl = resolvedUrl;
    }
  }

  if (!startsWithPdfMagic(finalBuffer)) {
    throw new Error(`PDF magic not found for ${finalUrl}; content-type=${finalContentType}`);
  }

  await fs.writeFile(targetPath, finalBuffer);
  const stat = await fs.stat(targetPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Downloaded PDF is empty: ${targetPath}`);
  }

  const prefix = await fs.readFile(targetPath);
  if (!startsWithPdfMagic(prefix)) {
    throw new Error(`Downloaded file is not a PDF: ${targetPath}`);
  }

  return {
    status: "downloaded",
    targetPath,
    httpStatus: response.status,
    contentType: finalContentType,
    contentDisposition: finalContentDisposition,
    mode: "api",
  };
}

async function launchUiBrowser() {
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
      "--disable-crash-reporter",
      "--no-first-run",
      "--disable-dev-shm-usage",
      "--disable-popup-blocking",
      "--host-resolver-rules=MAP label.teksher.kg 109.71.231.11",
    ],
  });
  return context;
}

async function waitUntilAuthenticated(page) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const currentUrl = page.url();
    if (!/\/login|\/sign-in/i.test(currentUrl)) return true;
    await sleep(10_000);
  }
  return false;
}

async function clickVisible(locator) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) {
      await item.click({ timeout: REQUEST_TIMEOUT }).catch(() => item.click({ timeout: REQUEST_TIMEOUT, force: true }));
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

function templateComboboxLocator(modal) {
  return modal.locator(
    '#react-select-printForm-template-input, [id*="printForm-template-input"], [id*="printForm-template"] input[role="combobox"]',
  ).first();
}

async function findAndOpenOperation(page, operationId, productCode) {
  const candidates = [
    page.getByText(operationId, { exact: false }),
    page.getByText(productCode, { exact: false }),
    page.locator(`text=${operationId}`),
    page.locator(`text=${productCode}`),
  ];

  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = candidate.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      await item.click({ timeout: REQUEST_TIMEOUT }).catch(async () => {
        const row = item.locator("xpath=ancestor::tr[1]");
        if (await row.isVisible().catch(() => false)) {
          await row.click({ timeout: REQUEST_TIMEOUT });
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
    if (!text.includes(operationId) && !text.includes(productCode)) continue;
    const clickable = row.locator("a,button,[role='button']").first();
    if (await clickable.isVisible().catch(() => false)) {
      await clickable.click({ timeout: REQUEST_TIMEOUT });
    } else {
      await row.click({ timeout: REQUEST_TIMEOUT });
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

async function openOperationDetailCandidate(page, operationId) {
  const candidates = [
    `${BASE_URL}/operations/${encodeURIComponent(operationId)}`,
    `${BASE_URL}/operations?operationId=${encodeURIComponent(operationId)}`,
    `${BASE_URL}/operations/${encodeURIComponent(operationId)}/details`,
  ];
  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT });
      await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});
      const bodyText = await page.locator("body").innerText().catch(() => "");
      if (bodyText.includes(operationId)) return true;
    } catch {}
  }
  return false;
}

async function resolveVisibleModalRoot(page) {
  const candidates = [
    page.locator('[role="dialog"]'),
    page.locator('[aria-modal="true"]'),
    page.locator('[class*="modal"]'),
    page.locator('[class*="drawer"]'),
    page.locator('[class*="popup"]'),
    page.locator('[class*="dialog"]'),
  ];
  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (await item.isVisible().catch(() => false)) return item;
    }
  }
  return null;
}

async function dumpUiDebug(page, name, extraText = "") {
  const debugDir = path.join(PROJECT_DIR, "debug", "download-16may-km-pdf-ui");
  await ensureDir(debugDir);
  const pngPath = path.join(debugDir, `${name}.png`);
  const htmlPath = path.join(debugDir, `${name}.html`);
  const controlsPath = path.join(debugDir, `${name}.controls.json`);
  const textPath = path.join(debugDir, `${name}.txt`);
  await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
  await fs.writeFile(htmlPath, await page.content(), "utf8").catch(() => {});
  const controls = await page.evaluate(() => {
    const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll("button, input, select, textarea, [role='button'], [role='option'], [role='dialog'], [class*='modal'], [class*='drawer']"))
      .slice(0, 250)
      .map((el, index) => ({
        index,
        tag: el.tagName,
        role: el.getAttribute("role") || "",
        text: norm(el.innerText || el.textContent || ""),
        value: "value" in el ? norm(el.value) : "",
        placeholder: el.getAttribute("placeholder") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        ariaExpanded: el.getAttribute("aria-expanded") || "",
        ariaHaspopup: el.getAttribute("aria-haspopup") || "",
        className: el.className || "",
      }));
  }).catch(() => []);
  await fs.writeFile(controlsPath, `${JSON.stringify(controls, null, 2)}\n`, "utf8").catch(() => {});
  await fs.writeFile(textPath, `${extraText || ""}\n`, "utf8").catch(() => {});
  console.log(`UI_DEBUG ${name}: ${pngPath}`);
  console.table(controls.slice(0, 40));
  return { pngPath, htmlPath, controlsPath, textPath, controls };
}

async function dumpClickableTexts(page, name) {
  const debugDir = path.join(PROJECT_DIR, "debug", "download-16may-km-pdf-ui");
  await ensureDir(debugDir);
  const outPath = path.join(debugDir, `${name}.clickable-texts.txt`);
  const texts = await page.evaluate(() => {
    const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll("button, a, [role='menuitem'], [role='button'], svg"))
      .map((el) => norm(el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || ""))
      .filter(Boolean);
  }).catch(() => []);
  await fs.writeFile(outPath, `${texts.join("\n")}\n`, "utf8").catch(() => {});
  console.log(`CLICKABLE_TEXTS ${name}: ${outPath}`);
  return texts;
}

async function clickExactButtonWhenReady(page, text, scope = null) {
  const exactButton = scope
    ? scope.getByRole("button", { name: text, exact: true })
    : page.getByRole("button", { name: text, exact: true });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await exactButton.isVisible().catch(() => false)) {
      const enabled = await exactButton.isEnabled().catch(() => false);
      if (enabled) {
        try {
          await exactButton.click({ timeout: REQUEST_TIMEOUT });
        } catch {
          await exactButton.click({ timeout: REQUEST_TIMEOUT, force: true });
        }
        return true;
      }
    }
    await sleep(250);
  }
  return false;
}

async function findOperationScope(page, operationId, productCode) {
  const containers = page.locator("tr, [role='row'], .operation, .operations-row, li, article, section, div");
  const count = await containers.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = containers.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const text = await item.innerText().catch(() => "");
    if (text.includes(operationId) || (productCode && text.includes(productCode))) return item;
  }
  return null;
}

function slugify(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isPdfDebugOne() {
  return String(process.env.PDF_DEBUG_ONE || "").trim() === "1";
}

async function ensurePdfModalOptionsDir() {
  const debugDir = path.join(PROJECT_DIR, "debug", "pdf_modal_options");
  await ensureDir(debugDir);
  return debugDir;
}

async function collectVisibleOptionTexts(page) {
  return page.evaluate(() => {
    const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const selectors = ["div", "li", "[role='option']", "[role='menuitem']"];
    const items = [];
    const seen = new Set();
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((el) => {
        if (!el) return;
        const text = norm(el.innerText || el.textContent || "");
        if (!text) return;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const visible = style && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        if (!visible) return;
        if (seen.has(text)) return;
        seen.add(text);
        items.push(text);
      });
    }
    return items;
  }).catch(() => []);
}

async function dumpPdfModalComboboxOptions(page, comboboxIndex, debugDir) {
  const combobox = page.locator('input[role="combobox"]').nth(comboboxIndex);
  await combobox.scrollIntoViewIfNeeded().catch(() => {});
  await combobox.click({ timeout: REQUEST_TIMEOUT, force: true });
  await sleep(1000);
  const options = await collectVisibleOptionTexts(page);
  const base = `combobox_${comboboxIndex}_open`;
  const txtPath = path.join(debugDir, `combobox_${comboboxIndex}_options.txt`);
  const pngPath = path.join(debugDir, `${base}.png`);
  await fs.writeFile(txtPath, `${options.join("\n")}\n`, "utf8");
  await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
  console.log(`PDF_DEBUG_ONE combobox ${comboboxIndex} options: ${txtPath}`);
  console.log(`PDF_DEBUG_ONE combobox ${comboboxIndex} screenshot: ${pngPath}`);
  console.table(options.map((text, index) => ({ index, text })));
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(300);
  return { txtPath, pngPath, options };
}

async function debugPdfModalOptions(page) {
  const debugDir = await ensurePdfModalOptionsDir();
  const htmlPath = path.join(debugDir, "modal.html");
  const pngPath = path.join(debugDir, "modal.png");
  await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
  await fs.writeFile(htmlPath, await page.content(), "utf8");
  const first = await dumpPdfModalComboboxOptions(page, 0, debugDir);
  await page.keyboard.press("Escape").catch(() => {});
  console.log(`PDF_DEBUG_ONE html: ${htmlPath}`);
  console.log(`PDF_DEBUG_ONE screenshot: ${pngPath}`);
  console.log(`PDF_DEBUG_ONE files: ${first.txtPath}`);
  return { debugDir, htmlPath, pngPath, first };
}

function isNetworkFetchError(error) {
  const text = `${error?.message || ""} ${error?.stack || ""} ${JSON.stringify(error?.cause || {})}`.toLowerCase();
  return text.includes("fetch failed") || text.includes("enotfound") || text.includes("networkerror") || text.includes("name resolution") || text.includes("getaddrinfo");
}

async function resolvePrintModal(page) {
  const byTitle = page.locator("div").filter({
    has: page.getByRole("heading", { name: /Печать кодов маркировки/i }),
  });
  const count = await byTitle.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = byTitle.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return resolveVisibleModalRoot(page);
}

async function waitForPrintModal(page) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const modal = await resolvePrintModal(page);
    if (modal) {
      const hasFormat = await modal.getByText("Формат файла", { exact: false }).isVisible().catch(() => false);
      const hasCancel = await modal.getByRole("button", { name: "Отменить", exact: false }).isVisible().catch(() => false);
      if (hasFormat && hasCancel) return modal;
    }
    await sleep(500);
  }
  throw new Error("PRINT_MODAL_NOT_OPENED");
}

async function clickOpenPrintButton(page) {
  const candidates = [
    page.getByRole("button", { name: /Печать и нанесение/i }),
    page.locator('button').filter({ hasText: /^Печать и нанесение$/ }),
    page.getByRole("button", { name: /^Печать$/ }),
    page.locator('button').filter({ hasText: /^Печать$/ }),
  ];
  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      await item.scrollIntoViewIfNeeded().catch(() => {});
      await item.click({ timeout: REQUEST_TIMEOUT, force: true });
      return true;
    }
  }
  return false;
}

async function selectPdfFileFormatInModal(page, modal) {
  const formatInput = modal.locator(
    '#react-select-printForm-fileTipe-input, [id*="printForm-fileTipe-input"], [id*="printForm-fileTipe"] input[role="combobox"]',
  ).first();
  const combobox = (await formatInput.count().catch(() => 0))
    ? formatInput
    : modal.locator('input[role="combobox"]').first();

  if (!(await combobox.count().catch(() => 0))) {
    throw new Error("FORMAT_COMBOBOX_NOT_FOUND");
  }

  await combobox.scrollIntoViewIfNeeded().catch(() => {});
  await combobox.click({ timeout: REQUEST_TIMEOUT, force: true });
  await sleep(500);

  const optionLocators = [
    page.locator('[id*="printForm-fileTipe-option"]').filter({ hasText: /^PDF файл$/ }),
    page.getByRole("option", { name: "PDF файл", exact: true }),
    page.locator('[role="option"]').filter({ hasText: /^PDF файл$/ }),
    page.locator('motion div, div[id*="option"]').filter({ hasText: /^PDF файл$/ }),
  ];

  for (const option of optionLocators) {
    const count = await option.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = option.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      await item.click({ timeout: REQUEST_TIMEOUT, force: true });
      await sleep(400);
      return;
    }
  }

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await sleep(400);
}

async function waitForTemplateFieldReady(page) {
  await page.waitForFunction(
    () => {
      const input = document.querySelector("#react-select-printForm-template-input");
      if (!input) return false;
      const control = input.closest(".react-select__control");
      if (!control) return false;
      return !control.classList.contains("react-select__control--is-disabled");
    },
    { timeout: REQUEST_TIMEOUT },
  ).catch(() => {});
  await sleep(400);
}

async function collectTemplateNearbyElements(page) {
  return page.evaluate(() => {
    const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const label = Array.from(document.querySelectorAll("span._label_1s02k_4, span")).find(
      (el) => norm(el.textContent) === "Шаблон",
    );
    if (!label) return [{ error: "label Шаблон not found" }];
    const block =
      label.closest("div.template_select, div._form_element_template_1s02k_1, motion.div, form") ||
      label.parentElement;
    const out = [];
    const seen = new Set();
    block.querySelectorAll("input, button, select, label, span, div, motion, [role='combobox'], [role='option']").forEach((el) => {
      const text = norm(el.innerText || el.textContent || "");
      const key = `${el.tagName}|${el.id || ""}|${text.slice(0, 80)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      out.push({
        tag: el.tagName,
        id: el.id || "",
        role: el.getAttribute("role") || "",
        className: String(el.className || "").slice(0, 120),
        text: text.slice(0, 200),
        value: "value" in el ? String(el.value || "") : "",
        visible,
      });
    });
    return out;
  }).catch(() => []);
}

async function dumpAfterPdfSelectedTemplate(page, modal) {
  const debugDir = path.join(PROJECT_DIR, "debug", "download-16may-km-pdf-ui");
  await ensureDir(debugDir);
  await dumpUiDebug(page, "after_pdf_selected_template_required", "PDF selected; template field required");

  const templateInput = templateComboboxLocator(modal);
  await templateInput.scrollIntoViewIfNeeded().catch(() => {});
  await templateInput.click({ timeout: REQUEST_TIMEOUT, force: true });
  await sleep(800);

  const options = await collectVisibleOptionTexts(page);
  const optionsPath = path.join(debugDir, "template_options_after_pdf.txt");
  await fs.writeFile(optionsPath, `${options.join("\n")}\n`, "utf8");

  const nearby = await collectTemplateNearbyElements(page);
  const nearbyPath = path.join(debugDir, "after_pdf_selected_template_required_nearby_shablon.json");
  await fs.writeFile(nearbyPath, `${JSON.stringify(nearby, null, 2)}\n`, "utf8");

  console.log(`TEMPLATE_DEBUG options: ${optionsPath}`);
  console.log(`TEMPLATE_DEBUG nearby: ${nearbyPath}`);
  console.table(options.slice(0, 20).map((text, index) => ({ index, text: text.slice(0, 100) })));

  await page.keyboard.press("Escape").catch(() => {});
  await sleep(300);
}

async function dumpFullAfterPdfDebug(page) {
  const debugDir = path.join(PROJECT_DIR, "debug", "download-16may-km-pdf-ui");
  await ensureDir(debugDir);
  const htmlPath = path.join(debugDir, "full_after_pdf.html");
  const pngPath = path.join(debugDir, "full_after_pdf.png");
  const jsonPath = path.join(debugDir, "full_after_pdf_elements.json");

  await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
  await fs.writeFile(htmlPath, await page.content(), "utf8");

  const elements = await page.evaluate(() => {
    const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const attrsToObject = (el) => {
      const attrs = {};
      for (const attr of Array.from(el.attributes || [])) {
        attrs[attr.name] = attr.value;
      }
      return attrs;
    };
    return Array.from(document.querySelectorAll("input, button, div, label, select"))
      .slice(0, 1200)
      .map((el, index) => ({
        index,
        tagName: el.tagName,
        id: el.id || "",
        className: String(el.className || ""),
        textContent: norm(el.textContent || ""),
        value: "value" in el ? String(el.value || "") : "",
        role: el.getAttribute("role") || "",
        "aria-label": el.getAttribute("aria-label") || "",
        "aria-expanded": el.getAttribute("aria-expanded") || "",
        "aria-haspopup": el.getAttribute("aria-haspopup") || "",
        disabled: Boolean(el.disabled),
        hidden: Boolean(el.hidden),
        dataAttributes: Object.fromEntries(
          Array.from(el.attributes || [])
            .filter((attr) => attr.name.startsWith("data-"))
            .map((attr) => [attr.name, attr.value]),
        ),
        attrs: attrsToObject(el),
      }));
  }).catch(() => []);
  await fs.writeFile(jsonPath, `${JSON.stringify(elements, null, 2)}\n`, "utf8");
  console.log(`TEMPLATE_MANUAL_DEBUG html: ${htmlPath}`);
  console.log(`TEMPLATE_MANUAL_DEBUG png: ${pngPath}`);
  console.log(`TEMPLATE_MANUAL_DEBUG elements: ${jsonPath}`);
  return { htmlPath, pngPath, jsonPath, elements };
}

async function dumpTemplateManualDebug(page) {
  const debugDir = path.join(PROJECT_DIR, "debug", "download-16may-km-pdf-ui");
  await ensureDir(debugDir);
  const htmlPath = path.join(debugDir, "full_after_pdf.html");
  const pngPath = path.join(debugDir, "full_after_pdf.png");
  const jsonPath = path.join(debugDir, "full_after_pdf_state.json");

  await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
  await fs.writeFile(htmlPath, await page.content(), "utf8");

  const state = await page.evaluate(() => {
    const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll("input, button, div, select"))
      .slice(0, 400)
      .map((el, index) => ({
        index,
        tag: el.tagName,
        id: el.id || "",
        role: el.getAttribute("role") || "",
        text: norm(el.innerText || el.textContent || "").slice(0, 200),
        value: "value" in el ? norm(el.value) : "",
        placeholder: el.getAttribute("placeholder") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        className: String(el.className || "").slice(0, 120),
      }));
  }).catch(() => []);
  await fs.writeFile(jsonPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  console.log(`TEMPLATE_MANUAL_DEBUG html: ${htmlPath}`);
  console.log(`TEMPLATE_MANUAL_DEBUG png: ${pngPath}`);
  console.log(`TEMPLATE_MANUAL_DEBUG state: ${jsonPath}`);
  return { htmlPath, pngPath, jsonPath, state };
}

async function getTemplateControlLocator(page) {
  const label = page.locator("span._label_1s02k_4").filter({ hasText: /^Шаблон$/ }).first();
  const labelContainer = label.locator("xpath=following::div[contains(@class,'app_select')][1]").first();
  const explicitInput = page.locator("#react-select-printForm-template-input").first();
  const inputControl = explicitInput.locator("xpath=ancestor::div[contains(@class,'react-select__control')][1]").first();
  const ariaInput = page.locator('input[role="combobox"]').filter({ has: page.getByText("Шаблон", { exact: true }) }).first();
  const fallbackInput = page.locator('input[role="combobox"]').nth(1);

  const locators = [labelContainer, inputControl, explicitInput, ariaInput, fallbackInput].filter(Boolean);
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    if (count) return locator;
  }
  return null;
}

async function clickReactSelectOption(page, optionTexts, idFragment = "") {
  const partial = /горизонтальн/i;
  const locators = [];
  for (const text of optionTexts) {
    if (idFragment) {
      locators.push(page.locator(`[id*="${idFragment}-option"]`).filter({ hasText: text }));
    }
    locators.push(
      page.getByRole("option", { name: text, exact: false }),
      page.locator('[role="option"]').filter({ hasText: text }),
      page.locator('motion div, div[id*="option"]').filter({ hasText: text }),
    );
  }
  if (idFragment) {
    locators.push(page.locator(`[id*="${idFragment}-option"]`).filter({ hasText: partial }));
  }
  locators.push(
    page.locator('[role="option"]').filter({ hasText: partial }),
    page.locator('motion div, div[id*="option"]').filter({ hasText: partial }),
  );

  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      const text = normalizeText(await item.innerText().catch(() => ""));
      if (!partial.test(text) && !optionTexts.some((needle) => text.includes(normalizeText(needle)))) continue;
      await item.click({ timeout: REQUEST_TIMEOUT, force: true });
      await sleep(400);
      return text;
    }
  }
  return "";
}

async function waitForManualTemplateSelection(page, reason = "") {
  console.log("MANUAL_TEMPLATE_SELECT_REQUIRED");
  if (reason) console.log(`reason: ${reason}`);
  await page.waitForTimeout(60000).catch(() => {});
}

async function selectTemplateInModal(page, modal) {
  await waitForTemplateFieldReady(page);
  const combobox = templateComboboxLocator(modal);
  if (!(await combobox.count().catch(() => 0))) {
    console.log("ACTIVE_TEMPLATE_FAIL_BRANCH:", "selectTemplateInModal: combobox_not_found");
    const allComboboxes = page.locator('input[role="combobox"]');
    const allCount = await allComboboxes.count().catch(() => 0);
    const visible = [];
    for (let index = 0; index < allCount; index += 1) {
      const item = allComboboxes.nth(index);
      if (await item.isVisible().catch(() => false)) visible.push(item);
    }
    console.log(`ACTIVE_TEMPLATE_FAIL_BRANCH visible_combobox_count=${visible.length}`);
    const debugPath = await dumpUiDebug(page, "template_combobox_not_found", `visible_combobox_count=${visible.length}`);
    console.log(`ACTIVE_TEMPLATE_FAIL_BRANCH debug_png=${debugPath.pngPath}`);
    if (visible.length >= 2) {
      const templateInput = visible[1];
      await templateInput.scrollIntoViewIfNeeded().catch(() => {});
      await templateInput.click({ timeout: REQUEST_TIMEOUT, force: true }).catch(() => {});
      await sleep(600);
      const chosen = await clickReactSelectOption(page, PRINT_TEMPLATE_VARIANTS, "printForm-template");
      if (chosen) return chosen;
      await page.keyboard.type("горизонтальный", { delay: 25 }).catch(() => {});
      await sleep(400);
      const retry = await clickReactSelectOption(page, PRINT_TEMPLATE_VARIANTS, "printForm-template");
      if (retry) return retry;
    }
    await waitForManualTemplateSelection(page, "template combobox not found");
    return "MANUAL_TEMPLATE_SELECTION";
  }

  await combobox.scrollIntoViewIfNeeded().catch(() => {});
  await combobox.click({ timeout: REQUEST_TIMEOUT, force: true });
  await sleep(600);

  const chosen = await clickReactSelectOption(page, PRINT_TEMPLATE_VARIANTS, "printForm-template");
  if (!chosen) {
    await page.keyboard.type("горизонтальный", { delay: 25 });
    await sleep(400);
    const retry = await clickReactSelectOption(page, PRINT_TEMPLATE_VARIANTS, "printForm-template");
    if (!retry) {
      await waitForManualTemplateSelection(page, "template option not found");
      return "MANUAL_TEMPLATE_SELECTION";
    }
    return retry;
  }
  return chosen;
}

async function printPdfViaUi(page, outputDir, fileBase, operationId, productCode) {
  const targetPath = path.join(outputDir, `${fileBase}.pdf`);
  if (await fileExists(targetPath)) {
    return { filePath: targetPath, skipped: true, reason: "skipped_existing" };
  }

  if (!(await clickOpenPrintButton(page))) {
    await dumpUiDebug(page, `print_button_not_found_${sanitizeFilePart(operationId)}`, `operationId=${operationId}`);
    return { filePath: "", skipped: true, reason: "PRINT_BUTTON_NOT_FOUND" };
  }

  let modal;
  try {
    modal = await waitForPrintModal(page);
  } catch (error) {
    await dumpUiDebug(page, `print_modal_not_opened_${sanitizeFilePart(operationId)}`, error?.message || String(error));
    return { filePath: "", skipped: true, reason: "PRINT_MODAL_NOT_OPENED" };
  }

  await selectPdfFileFormatInModal(page, modal);
  await page.waitForTimeout(3000).catch(() => {});
  const templateLabel = page.getByText("Шаблон", { exact: false }).first();
  const templateLabelVisible = await templateLabel.isVisible().catch(() => false);
  if (!templateLabelVisible) {
    await dumpUiDebug(page, "template_label_not_found", "Шаблон did not appear after selecting PDF file");
    console.log("ACTIVE_TEMPLATE_FAIL_BRANCH printPdfViaUi: template_label_not_found");
    await waitForManualTemplateSelection(page, "template label not visible after PDF selection");
  }
  await dumpUiDebug(page, "after_pdf_template_label_visible", "Шаблон visible after PDF selection");
  await waitForTemplateFieldReady(page);
  if (isPdfDebugOne()) {
    await dumpAfterPdfSelectedTemplate(page, modal);
  }
  const templateChosen = await selectTemplateInModal(page, modal);
  console.log(`TEMPLATE_SELECTED: ${templateChosen}`);

  const modalPrint = modal
    .locator("form")
    .locator('button')
    .filter({ hasText: /^Печать$/ })
    .last();
  const fallbackPrint = modal.getByRole("button", { name: "Печать", exact: true }).last();
  const printButton = (await modalPrint.count().catch(() => 0)) ? modalPrint : fallbackPrint;

  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  if (await printButton.isVisible().catch(() => false)) {
    await printButton.click({ timeout: REQUEST_TIMEOUT, force: true });
  } else if (!(await clickVisible(modal.getByRole("button", { name: "Печать", exact: false })))) {
    throw new Error("MODAL_PRINT_BUTTON_NOT_FOUND");
  }

  let download;
  try {
    download = await downloadPromise;
  } catch (error) {
    const pageClosed = page.isClosed?.() || false;
    const contextClosed = page.context?.().isClosed?.() || false;
    if (pageClosed || contextClosed) {
      console.error("DOWNLOAD_PAGE_CLOSED_BEFORE_EVENT");
      throw new Error("DOWNLOAD_PAGE_CLOSED_BEFORE_EVENT");
    }
    throw error;
  }
  await download.saveAs(targetPath);
  await waitForNoTmpDownloads(outputDir);

  if (!(await fileExists(targetPath))) {
    throw new Error(`Downloaded PDF not found: ${targetPath}`);
  }
  const stat = await fs.stat(targetPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Downloaded PDF is empty: ${targetPath}`);
  }
  const header = await fs.readFile(targetPath);
  if (!startsWithPdfMagic(header)) {
    throw new Error(`Downloaded file is not a PDF: ${targetPath}`);
  }

  console.log(`PDF_SAVED ${targetPath} (${stat.size} bytes)`);
  return { filePath: targetPath, skipped: false };
}

async function downloadViaUi(records) {
  await ensureDir(UI_OUTPUT_DIR);
  const context = await launchUiBrowser();
  const results = [];
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`${BASE_URL}/operations`, { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT });
    await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});

    if (!await waitUntilAuthenticated(page)) {
      throw new Error("LOGIN_REQUIRED");
    }

    for (const record of records) {
      try {
        await page.goto(`${BASE_URL}/operations`, { waitUntil: "domcontentloaded", timeout: REQUEST_TIMEOUT });
        await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});

        await openOperationInUi(page, record);

        const productCode = sanitizeFilePart(record.productCode || record.operationId);
        const fileBase = `${productCode}_${sanitizeFilePart(record.operationId)}`;
        const result = await printPdfViaUi(
          page,
          UI_OUTPUT_DIR,
          fileBase,
          record.operationId,
          record.productCode || "",
        );
        if (result.skipped) {
          skipped += 1;
          results.push({
            operationId: record.operationId,
            productCode: record.productCode || "",
            createdAt: record.createdAt,
            status: record.status,
            mode: "ui",
            downloadStatus: result.reason === "PRINT_BUTTON_NOT_FOUND" ? "skipped_not_found" : result.reason === "PRINT_BUTTON_CLICK_DID_NOT_OPEN_MODAL" ? "skipped_modal_not_opened" : "skipped_existing",
            filePath: result.filePath,
            reason: result.reason || "",
          });
          continue;
        }

        downloaded += 1;
        results.push({
          operationId: record.operationId,
          productCode: record.productCode || "",
          createdAt: record.createdAt,
          status: record.status,
          mode: "ui",
          downloadStatus: "downloaded",
          filePath: result.filePath,
          reason: "",
        });
        console.log("ui_pdf_downloaded");
      } catch (error) {
        failed += 1;
        results.push({
          operationId: record.operationId,
          productCode: record.productCode || "",
          createdAt: record.createdAt,
          status: record.status,
          mode: "ui",
          downloadStatus: "failed",
          filePath: "",
          reason: error?.message || String(error),
        });
        console.log("ui_failed");
        console.log(`reason: ${error?.message || String(error)}`);
        console.error("UI_ERROR");
        console.error(`operationId: ${record.operationId}`);
        console.error(`error.name: ${error?.name || "n/a"}`);
        console.error(`error.message: ${error?.message || "n/a"}`);
        console.error(`error.stack: ${error?.stack || "n/a"}`);
        console.error(`error.cause: ${JSON.stringify(error?.cause, null, 2)}`);
        await dumpUiDebug(page, `${sanitizeFilePart(record.operationId)}_failed`, error?.message || String(error));
      }
    }

    return { results, downloaded, skipped, failed, outputDir: UI_OUTPUT_DIR, mode: "ui" };
  } finally {
    await context.close().catch(() => {});
  }
}

async function openOperationInUi(page, record) {
  const opened = await openOperationDetailCandidate(page, record.operationId);
  if (!opened) {
    await findAndOpenOperation(page, record.operationId, record.productCode || record.operationId);
  }
  await page.waitForLoadState("networkidle", { timeout: REQUEST_TIMEOUT }).catch(() => {});
}

async function downloadViaApi(records, headers, pdfStrategy) {
  await ensureDir(API_OUTPUT_DIR);
  const results = [];
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const record of records) {
    try {
      const detail = await fetchOperationDetail(record.operationId, headers);
      const detailValue = detail?.json || {};
      const productCode = sanitizeFilePart(
        extractProductCode(detailValue) ||
          extractProductCode(record.raw) ||
          record.operationId,
      );
      const fileBase = `${productCode || sanitizeFilePart(record.operationId)}_${sanitizeFilePart(record.operationId)}`;

      const result = await downloadPdfViaApi(record, headers, fileBase, pdfStrategy);
      if (result.status === "downloaded") downloaded += 1;
      else skipped += 1;

      results.push({
        operationId: record.operationId,
        productCode,
        createdAt: record.createdAt,
        status: record.status,
        mode: "api",
        downloadStatus: result.status,
        filePath: result.targetPath || "",
        reason: result.reason || "",
      });
    } catch (error) {
      failed += 1;
      results.push({
        operationId: record.operationId,
        productCode: sanitizeFilePart(record.productCode || record.operationId),
        createdAt: record.createdAt,
        status: record.status,
        mode: "api",
        downloadStatus: "failed",
        filePath: "",
        reason: error?.message || String(error),
      });
      console.error("API_ERROR");
      console.error(`operationId: ${record.operationId}`);
      console.error(`error.name: ${error?.name || "n/a"}`);
      console.error(`error.message: ${error?.message || "n/a"}`);
      console.error(`error.stack: ${error?.stack || "n/a"}`);
      console.error(`error.cause: ${JSON.stringify(error?.cause, null, 2)}`);
    }
  }

  return { results, downloaded, skipped, failed, outputDir: API_OUTPUT_DIR, mode: "api" };
}

async function main() {
  const discoveryHints = summarizeDiscoveryFile();
  let authState;
  try {
    authState = await readAuthHeaders();
  } catch (error) {
    if (isNetworkFetchError(error)) {
      console.error("NETWORK_ERROR_RETRY_WITH_VPN");
      console.error(`error.name: ${error?.name || "n/a"}`);
      console.error(`error.message: ${error?.message || "n/a"}`);
      console.error(`error.stack: ${error?.stack || "n/a"}`);
      console.error(`error.cause: ${JSON.stringify(error?.cause, null, 2)}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  console.log(`DATE_FROM: ${DATE_FROM}`);
  console.log(`DATE_TO: ${DATE_TO}`);
  console.log(`output folder: ${OUTPUT_DIR}`);

  let rows;
  try {
    const loaded = await loadOperations(authState.headers, authState.refreshToken);
    rows = loaded.rows;
  } catch (error) {
    if (isNetworkFetchError(error)) {
      console.error("NETWORK_ERROR_RETRY_WITH_VPN");
      console.error(`error.name: ${error?.name || "n/a"}`);
      console.error(`error.message: ${error?.message || "n/a"}`);
      console.error(`error.stack: ${error?.stack || "n/a"}`);
      console.error(`error.cause: ${JSON.stringify(error?.cause, null, 2)}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  console.log(`total operations found: ${rows.length}`);
  console.log(`output candidates from operations_network_discovery.json: ${discoveryHints.length}`);
  if (discoveryHints.length) console.table(discoveryHints.map((url) => ({ url })));
  console.log(`token exp: ${new Date(authState.tokenExpiresAtMs).toISOString()}`);

  const records = rows.map((row) => ({
    operationId: row.operationId,
    createdAt: row.createdAt,
    status: row.status,
    productCode: sanitizeFilePart(
      extractProductCode(row.raw) || row.operationId,
    ),
    raw: row.raw,
  }));

  const workRecords = isPdfDebugOne() ? records.slice(0, 1) : records;
  if (isPdfDebugOne() && !workRecords.length) {
    throw new Error("NO_OPERATION_FOUND_FOR_PDF_DEBUG_ONE");
  }
  if (isPdfDebugOne() && workRecords[0]) {
    console.log(`PDF_DEBUG_ONE operationId=${workRecords[0].operationId}`);
  }

  const first = workRecords[0] || null;
  let summary;
  if (isPdfDebugOne()) {
    console.log("PDF_DEBUG_ONE: UI download only (no API PDF probe)");
    summary = await downloadViaUi(workRecords);
    summary.mode = "ui-debug-one";
  } else {
    let pdfStrategy = null;
    if (first) {
      pdfStrategy = await probePdfApi(first, authState.headers, discoveryHints);
    }
    if (pdfStrategy) {
      console.log(`PDF API endpoint found: ${pdfStrategy.template}`);
      summary = await downloadViaApi(records, authState.headers, pdfStrategy);
    } else {
      console.log("PDF_API_NOT_FOUND_USING_UI_FALLBACK");
      summary = await downloadViaUi(records);
    }
  }

  await writeJson(LOG_PATH, {
    generatedAt: new Date().toISOString(),
    mode: summary.mode,
    outputDir: summary.outputDir,
    records: summary.results,
  });

  console.table(
    summary.results.map((row) => ({
      operationId: row.operationId,
      createdAt: row.createdAt,
      status: row.status,
      mode: row.mode,
      downloadStatus: row.downloadStatus || "",
      filePath: row.filePath,
      reason: row.reason || "",
    })),
  );

  console.log(`total operations: ${records.length}`);
  console.log(`api pdf downloaded: ${summary.mode === "api" ? summary.downloaded : 0}`);
  console.log(`ui pdf downloaded: ${summary.mode === "ui" || summary.mode === "ui-debug-one" ? summary.downloaded : 0}`);
  console.log(`skipped: ${summary.skipped}`);
  console.log(`failed: ${summary.failed}`);
  console.log(`output folder: ${summary.outputDir}`);
  const failedRows = summary.results.filter((row) => row.downloadStatus === "failed");
  if (failedRows.length) {
    console.log("failed list:");
    console.table(failedRows.map((row) => ({
      operationId: row.operationId,
      reason: row.reason,
    })));
  }
}

main().catch((error) => {
  console.error("FATAL_ERROR");
  console.error(`error.name: ${error?.name || "n/a"}`);
  console.error(`error.message: ${error?.message || "n/a"}`);
  console.error(`error.stack: ${error?.stack || "n/a"}`);
  console.error(`error.cause: ${JSON.stringify(error?.cause, null, 2)}`);
  process.exitCode = 1;
});
