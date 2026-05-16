const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const BASE_URL = "https://label.teksher.kg";
const OPERATIONS_URL = `${BASE_URL}/operations`;
const SESSION_PROFILE_DIR = path.join(__dirname, "teksher-session-profile");
const TMP_DIR = path.join(__dirname, "tmp");
const OUTPUT_DIR = path.join(os.homedir(), "Desktop", "заказ км", "электросталь печать кодов паркеровки");
const INDEX_PATH = path.join(OUTPUT_DIR, "index.json");
const RAW_OPERATIONS_PATH = path.join(OUTPUT_DIR, "operations_raw.json");
const PROBE_RESULTS_PATH = path.join(OUTPUT_DIR, "endpoint_probe_results.json");
const TARGET_DATE = "2026-05-15";
const TARGET_DATE_DOT = "15.05.2026";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LIST_PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = 45000;

const LIST_BASES = [
  "/facade/api/v1/operations",
  "/facade/order/api/v1/operations",
];

const LIST_URL_PATTERNS = [
  { createdAtFrom: `${TARGET_DATE}T00:00:00`, createdAtTo: `${TARGET_DATE}T23:59:59` },
  { createdFrom: `${TARGET_DATE}T00:00:00`, createdTo: `${TARGET_DATE}T23:59:59` },
  { dateFrom: TARGET_DATE, dateTo: TARGET_DATE },
  { from: TARGET_DATE_DOT, to: TARGET_DATE_DOT },
];

const PAGE_PATTERNS = [
  { page: "0", size: String(LIST_PAGE_SIZE) },
  { pageNumber: "0", pageSize: String(LIST_PAGE_SIZE) },
  { page: "1", limit: String(LIST_PAGE_SIZE) },
];

const PROBE_ENDPOINTS = [
  `${BASE_URL}/facade/api/v1/operations?page=0&size=100`,
  `${BASE_URL}/facade/order/api/v1/operations?page=0&size=100`,
  `${BASE_URL}/facade/order/api/v1/operations?createdFrom=${TARGET_DATE}&createdTo=2026-05-16`,
  `${BASE_URL}/facade/api/v1/operations?createdFrom=${TARGET_DATE}&createdTo=2026-05-16`,
];

const FILE_ENDPOINTS = [
  "/facade/api/v1/operations/{operationId}",
  "/facade/order/api/v1/operations/{operationId}",
  "/facade/api/v1/operations/{operationId}/print",
  "/facade/order/api/v1/operations/{operationId}/print",
  "/facade/api/v1/operations/{operationId}/download",
  "/facade/order/api/v1/operations/{operationId}/download",
  "/facade/api/v1/operations/{operationId}/pdf",
  "/facade/order/api/v1/operations/{operationId}/pdf",
  "/facade/api/v1/operations/{operationId}/csv",
  "/facade/order/api/v1/operations/{operationId}/csv",
];

const PDF_TYPES = [/application\/pdf/i, /application\/octet-stream/i];
const CSV_TYPES = [/text\/csv/i, /application\/csv/i, /application\/vnd\.ms-excel/i];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniq(values) {
  return Array.from(new Set(values.filter(Boolean)));
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

function datePart(value) {
  const text = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const dot = text.match(/\b(\d{2})\.(\d{2})\.(\d{4})\b/);
  if (dot) return `${dot[3]}-${dot[2]}-${dot[1]}`;
  return "";
}

function isTargetDate(value) {
  return datePart(value) === TARGET_DATE;
}

function isOperationId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function stringifyValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function findFirstField(value, keyPatterns, seen = new Set()) {
  if (value == null || typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstField(item, keyPatterns, seen);
      if (found !== "") return found;
    }
    return "";
  }

  for (const [key, nested] of Object.entries(value)) {
    if (keyPatterns.some((pattern) => pattern.test(key)) && nested != null) {
      const text = stringifyValue(nested);
      if (text !== "") return text;
    }
  }

  for (const nested of Object.values(value)) {
    const found = findFirstField(nested, keyPatterns, seen);
    if (found !== "") return found;
  }

  return "";
}

function findOwnField(value, keyPatterns) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return "";
  for (const [key, nested] of Object.entries(value)) {
    if (keyPatterns.some((pattern) => pattern.test(key)) && nested != null) {
      const text = stringifyValue(nested);
      if (text !== "") return text;
    }
  }
  return "";
}

function hasOwnField(value, keyPatterns) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).some((key) => keyPatterns.some((pattern) => pattern.test(key)));
}

function collectOperationObjects(value, out = [], seen = new Set()) {
  if (value == null || typeof value !== "object") return out;
  if (seen.has(value)) return out;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectOperationObjects(item, out, seen);
    return out;
  }

  if (hasOwnField(value, [/^id$/i, /^operationId$/i, /^operationID$/i, /^operation_id$/i])) {
    out.push(value);
  }

  for (const nested of Object.values(value)) collectOperationObjects(nested, out, seen);
  return out;
}

function findGtin(value) {
  const direct = findFirstField(value, [/^gtin$/i, /^productGtin$/i, /^product_gtin$/i]);
  if (/^\d{8,20}$/.test(direct)) return direct;

  const text = JSON.stringify(value || "");
  const match = text.match(/\b\d{14}\b/);
  return match ? match[0] : "";
}

function normalizeOperation(raw, sourceUrl = "") {
  const operationId =
    findOwnField(raw, [/^id$/i, /^operationId$/i, /^operationID$/i, /^operation_id$/i]) ||
    findFirstField(raw, [/^id$/i, /^operationId$/i, /^operationID$/i, /^operation_id$/i]);
  const gtin = findGtin(raw);
  const status = normalizeStatus(findFirstField(raw, [/^status$/i, /^state$/i]));
  const createdAt = findFirstField(raw, [/^createdAt$/i, /^created_at$/i, /^created$/i, /^date$/i]);
  const quantity = findFirstField(raw, [/^kmsCount$/i, /^quantity$/i, /^markingCodesAmount$/i, /^count$/i]);

  if (!operationId || !gtin) return null;

  return {
    operationId,
    gtin,
    status,
    createdAt,
    quantity: quantity === "" ? "" : Number.isFinite(Number(quantity)) ? Number(quantity) : quantity,
    sourceUrl,
  };
}

function firstJsonKeys(value) {
  if (Array.isArray(value)) {
    const firstObject = value.find((item) => item && typeof item === "object" && !Array.isArray(item));
    return firstObject ? Object.keys(firstObject).slice(0, 20) : [];
  }
  if (value && typeof value === "object") {
    return Object.keys(value).slice(0, 20);
  }
  return [];
}

function operationCreatedAtTime(operation) {
  const text = String(operation.createdAt || "");
  const normalized = /^\d{4}-\d{2}-\d{2}T/.test(text) ? text : text.replace(" ", "T");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickOperationDateField(raw) {
  const keys = ["createdAt", "createdDate", "statusDate", "operationDate", "created"];
  for (const key of keys) {
    const value = findFirstField(raw, [new RegExp(`^${key}$`, "i")]);
    if (value) {
      return { field: key, value };
    }
  }
  const fallback = findFirstField(raw, [/^date$/i, /^updatedAt$/i, /^updatedDate$/i]);
  return fallback ? { field: "date", value: fallback } : { field: "", value: "" };
}

function buildOperationSnapshot(raw, sourceUrl = "") {
  const normalized = normalizeOperation(raw, sourceUrl);
  const dateField = pickOperationDateField(raw);
  return {
    operationId: normalized?.operationId || findOwnField(raw, [/^id$/i, /^operationId$/i, /^operationID$/i, /^operation_id$/i]) || "",
    createdAt: normalized?.createdAt || dateField.value || "",
    status: normalized?.status || normalizeStatus(findFirstField(raw, [/^status$/i, /^state$/i])),
    gtin: normalized?.gtin || findGtin(raw),
    dateField: dateField.field,
    sourceUrl,
    raw,
  };
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function ensureDirs() {
  await ensureDir(TMP_DIR);
  await ensureDir(SESSION_PROFILE_DIR);
  await ensureDir(OUTPUT_DIR);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function uniquePath(filePath) {
  if (!(await fileExists(filePath))) return filePath;

  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);

  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(dir, `${base}_${index}${ext}`);
    if (!(await fileExists(candidate))) return candidate;
  }

  throw new Error(`Could not reserve unique file name for ${filePath}`);
}

async function readTextResponse(page, url) {
  return page.evaluate(async ({ requestUrl, timeoutMs }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Request timeout")), timeoutMs);
    try {
      const response = await fetch(requestUrl, {
        method: "GET",
        credentials: "include",
        redirect: "follow",
        headers: {
          Accept: "application/json, text/plain, */*",
        },
        signal: controller.signal,
      });
      const text = await response.text();
      let body = text;
      try {
        body = JSON.parse(text);
      } catch {}
      return {
        url: requestUrl,
        httpStatus: response.status,
        ok: response.ok,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body,
      };
    } finally {
      clearTimeout(timeout);
    }
  }, { requestUrl: url, timeoutMs: REQUEST_TIMEOUT_MS });
}

async function probeEndpoint(page, url) {
  const response = await readTextResponse(page, url);
  const body = response.body;
  const size = typeof body === "string"
    ? Buffer.byteLength(body, "utf8")
    : Buffer.byteLength(JSON.stringify(body ?? null), "utf8");
  const keys = firstJsonKeys(body);
  const objects = collectOperationObjects(body);
  const operations = objects
    .map((object) => normalizeOperation(object, url))
    .filter(Boolean);
  return {
    url,
    httpStatus: response.httpStatus,
    ok: response.ok,
    size,
    firstKeys: keys,
    operationCount: operations.length,
    body,
    headers: response.headers,
  };
}

async function readBinaryResponse(page, url) {
  return page.evaluate(async ({ requestUrl, timeoutMs }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Request timeout")), timeoutMs);
    try {
      const response = await fetch(requestUrl, {
        method: "GET",
        credentials: "include",
        redirect: "follow",
        headers: {
          Accept: "*/*",
        },
        signal: controller.signal,
      });
      const headers = Object.fromEntries(response.headers.entries());
      const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
      return {
        url: requestUrl,
        httpStatus: response.status,
        ok: response.ok,
        statusText: response.statusText,
        headers,
        bytes,
      };
    } finally {
      clearTimeout(timeout);
    }
  }, { requestUrl: url, timeoutMs: REQUEST_TIMEOUT_MS });
}

async function waitForManualLogin(page) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < LOGIN_TIMEOUT_MS) {
    const url = page.url();
    const inLogin = url.includes("/login") || url.includes("/sign-in");
    const hasOperations = await page.locator("text=Операции").first().isVisible().catch(() => false);
    if (!inLogin && hasOperations) return true;
    await sleep(2000);
  }
  throw new Error(`LOGIN_TIMEOUT: не дождался ручного логина за ${Math.round(LOGIN_TIMEOUT_MS / 60000)} минут`);
}

function buildListUrls() {
  const urls = [];
  for (const base of LIST_BASES) {
    for (const dates of LIST_URL_PATTERNS) {
      for (const paging of PAGE_PATTERNS) {
        const params = new URLSearchParams({ ...dates, ...paging });
        urls.push(`${BASE_URL}${base}?${params.toString()}`);
      }
    }
  }
  return uniq(urls);
}

async function collectOperations(page, preferredUrls = []) {
  const discovered = new Map();
  const responses = [];

  for (const url of uniq([...preferredUrls, ...buildListUrls()])) {
    try {
      const response = await readTextResponse(page, url);
      responses.push(response);
    } catch (error) {
      responses.push({ url, httpStatus: 0, ok: false, statusText: error.message || String(error), headers: {}, body: null });
    }
  }

  const detailIds = uniq(
    responses.flatMap((response) => collectOperationObjects(response.body).map((object) => normalizeOperation(object, response.url)).filter(Boolean))
      .map((operation) => operation.operationId)
  );

  for (const operationId of detailIds) {
    const detailUrl = `${BASE_URL}/facade/api/v1/operations/${encodeURIComponent(operationId)}`;
    try {
      const response = await readTextResponse(page, detailUrl);
      responses.push(response);
      const operation = normalizeOperation(response.body, detailUrl);
      if (operation) {
        const existing = discovered.get(operation.operationId);
        if (!existing || operationCreatedAtTime(operation) >= operationCreatedAtTime(existing)) {
          discovered.set(operation.operationId, buildOperationSnapshot(response.body, detailUrl));
        }
      }
    } catch (error) {
      responses.push({ url: detailUrl, httpStatus: 0, ok: false, statusText: error.message || String(error), headers: {}, body: null });
    }
  }

  const allOperations = [];
  for (const response of responses) {
    for (const object of collectOperationObjects(response.body)) {
      const snapshot = buildOperationSnapshot(object, response.url);
      if (!snapshot.operationId) continue;
      const existing = discovered.get(snapshot.operationId);
      if (!existing || operationCreatedAtTime(snapshot) >= operationCreatedAtTime(existing)) {
        discovered.set(snapshot.operationId, snapshot);
      }
    }
  }

  for (const snapshot of discovered.values()) {
    allOperations.push(snapshot);
  }

  return {
    responses,
    operations: allOperations.sort((a, b) => operationCreatedAtTime(a) - operationCreatedAtTime(b)),
  };
}

async function probeOperationEndpoints(page) {
  const results = [];
  for (const url of PROBE_ENDPOINTS) {
    try {
      const result = await probeEndpoint(page, url);
      results.push(result);
    } catch (error) {
      results.push({
        url,
        httpStatus: 0,
        ok: false,
        size: 0,
        firstKeys: [],
        operationCount: 0,
        error: error.message || String(error),
      });
    }
  }
  return results;
}

function responseLooksLikeBinary(headers, bytes) {
  const contentType = String(headers?.["content-type"] || "");
  const first4 = Buffer.from(bytes.slice(0, 4));
  if (PDF_TYPES.some((pattern) => pattern.test(contentType))) return true;
  if (CSV_TYPES.some((pattern) => pattern.test(contentType))) return true;
  if (first4.equals(Buffer.from("%PDF"))) return true;
  return false;
}

function contentDispositionFilename(contentDisposition = "") {
  const match =
    String(contentDisposition).match(/filename\*=UTF-8''([^;]+)/i) ||
    String(contentDisposition).match(/filename="?([^"]+)"?/i);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1].trim().replace(/^"(.*)"$/, "$1"));
  } catch {
    return String(match[1]).trim().replace(/^"(.*)"$/, "$1");
  }
}

function inferOriginalFilename(url, headers) {
  const fromDisposition = contentDispositionFilename(headers?.["content-disposition"] || "");
  if (fromDisposition) return fromDisposition;

  const pathname = new URL(url, BASE_URL).pathname || "";
  const basename = path.basename(pathname);
  if (basename && basename !== "/" && basename !== ".") return basename;

  return "";
}

function inferExtensionFromResponse(url, headers, bytes) {
  const contentType = String(headers?.["content-type"] || "").toLowerCase();
  const disposition = contentDispositionFilename(headers?.["content-disposition"] || "");
  const filenameExt = path.extname(disposition).replace(".", "").toLowerCase();
  if (filenameExt === "pdf" || filenameExt === "csv") return filenameExt;

  const urlExt = path.extname(new URL(url, BASE_URL).pathname).replace(".", "").toLowerCase();
  if (urlExt === "pdf" || urlExt === "csv") return urlExt;

  if (/pdf/.test(contentType) || Buffer.from(bytes.slice(0, 4)).equals(Buffer.from("%PDF"))) return "pdf";
  if (/csv/.test(contentType)) return "csv";
  return "";
}

function extractStringCandidate(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("/")) return trimmed;
    return "";
  }

  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractStringCandidate(item);
      if (found) return found;
    }
    return "";
  }

  for (const [key, nested] of Object.entries(value)) {
    if (["file", "url", "downloadurl", "downloadUrl", "link"].includes(key) && typeof nested === "string") {
      const candidate = nested.trim();
      if (candidate) return candidate;
    }
    const found = extractStringCandidate(nested);
    if (found) return found;
  }

  return "";
}

async function tryDownloadFile(page, operation, candidateUrl, records, seenUrls, depth = 0) {
  if (!candidateUrl || depth > 2) return null;
  const absolute = new URL(candidateUrl, BASE_URL).toString();
  if (seenUrls.has(absolute)) return null;
  seenUrls.add(absolute);

  const response = await readBinaryResponse(page, absolute);
  const headers = response.headers || {};
  const bytes = response.bytes || [];

  if (!response.ok) {
    const text = Buffer.from(bytes).toString("utf8");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    const nextCandidate = extractStringCandidate(json ?? text);
    if (nextCandidate && nextCandidate !== absolute) {
      return tryDownloadFile(page, operation, nextCandidate, records, seenUrls, depth + 1);
    }
    return null;
  }

  if (responseLooksLikeBinary(headers, bytes)) {
    const ext = inferExtensionFromResponse(absolute, headers, bytes) || "bin";
    const baseName = sanitizeFilePart(operation.gtin || operation.operationId || "operation");
    const targetName = await uniquePath(path.join(OUTPUT_DIR, `${baseName}.${ext}`));
    await fs.writeFile(targetName, Buffer.from(bytes));

    const originalFilename = inferOriginalFilename(absolute, headers) || `${path.basename(targetName)}`;

    records.push({
      operationId: operation.operationId,
      gtin: operation.gtin || "",
      createdAt: operation.createdAt,
      status: operation.status,
      originalFilename,
      savedFilename: path.basename(targetName),
    });

    return {
      path: targetName,
      ext,
      url: absolute,
    };
  }

  const text = Buffer.from(bytes).toString("utf8");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}

  const nextCandidate = extractStringCandidate(json ?? text);
  if (nextCandidate && nextCandidate !== absolute) {
    return tryDownloadFile(page, operation, nextCandidate, records, seenUrls, depth + 1);
  }

  return null;
}

async function downloadOperationFiles(page, operation, records) {
  const seenUrls = new Set();
  for (const template of FILE_ENDPOINTS) {
    const url = `${BASE_URL}${template.replace("{operationId}", encodeURIComponent(operation.operationId))}`;
    try {
      await tryDownloadFile(page, operation, url, records, seenUrls);
    } catch (error) {
      console.log(`download failed for ${operation.operationId} at ${url}: ${error.message || String(error)}`);
    }
  }
}

function summarizeDateFieldUsage(operations) {
  const counts = new Map();
  for (const op of operations) {
    const field = op.dateField || "unknown";
    counts.set(field, (counts.get(field) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([field, count]) => `${field || "unknown"}=${count}`)
    .join(", ");
}

function filterTargetOperations(operations) {
  return operations.filter((operation) => {
    const dateValue = operation.createdAt || operation.raw?.createdAt || operation.raw?.createdDate || operation.raw?.statusDate || operation.raw?.operationDate || operation.raw?.created || "";
    return isTargetDate(dateValue);
  });
}

async function main() {
  await ensureDirs();

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

  const indexRecords = [];

  try {
    const page = await context.newPage();
    await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: DEFAULT_TIMEOUT_MS }).catch(() => {});

    const loginPage = page.url().includes("/login") || page.url().includes("/sign-in")
      || await page.locator("input[type='password']").first().isVisible().catch(() => false);
    if (loginPage) {
      console.log("LOGIN_REQUIRED: waiting for manual login");
      await waitForManualLogin(page);
      if (!page.url().includes("/operations")) {
        await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
        await page.waitForLoadState("networkidle", { timeout: DEFAULT_TIMEOUT_MS }).catch(() => {});
      }
    }

    const probeResults = await probeOperationEndpoints(page);
    await fs.writeFile(PROBE_RESULTS_PATH, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      targetDate: TARGET_DATE_DOT,
      source: "browser-cookie-mode",
      probeEndpoints: PROBE_ENDPOINTS,
      results: probeResults.map((result) => ({
        url: result.url,
        httpStatus: result.httpStatus,
        ok: result.ok,
        size: result.size,
        firstKeys: result.firstKeys,
        operationCount: result.operationCount || 0,
        error: result.error || "",
      })),
    }, null, 2)}\n`, "utf8");

    console.log(`probe results saved: ${PROBE_RESULTS_PATH}`);
    console.table(probeResults.map((result) => ({
      url: result.url,
      status: result.httpStatus,
      size: result.size,
      firstKeys: (result.firstKeys || []).join(", "),
      operations: result.operationCount || 0,
    })));

    const bestProbe = probeResults.find((result) => (result.operationCount || 0) > 0);
    if (!bestProbe) {
      console.log("No non-empty list endpoint found yet. Export is paused.");
      return;
    }
    console.log(`Selected list endpoint: ${bestProbe.url}`);

    const preferredListUrls = probeResults
      .filter((result) => (result.operationCount || 0) > 0)
      .map((result) => result.url);
    const { responses, operations: rawOperations } = await collectOperations(page, preferredListUrls);
    const rawPayload = {
      generatedAt: new Date().toISOString(),
      targetDate: TARGET_DATE_DOT,
      source: "browser-cookie-mode",
      responses,
      operations: rawOperations,
    };
    await fs.writeFile(RAW_OPERATIONS_PATH, `${JSON.stringify(rawPayload, null, 2)}\n`, "utf8");

    console.log(`raw response saved: ${RAW_OPERATIONS_PATH}`);
    console.log("\nFirst 20 operations:");
    console.table(
      rawOperations.slice(0, 20).map((row) => ({
        operationId: row.operationId,
        createdAt: row.createdAt,
        status: row.status,
        gtin: row.gtin,
      }))
    );
    console.log(`date field usage: ${summarizeDateFieldUsage(rawOperations) || "n/a"}`);

    const operations = filterTargetOperations(rawOperations);
    console.log(`Found operations for ${TARGET_DATE}: ${operations.length}`);
    if (operations.length === 0 && rawOperations.length > 0) {
      const sortedDates = rawOperations
        .map((row) => row.createdAt)
        .filter(Boolean)
        .map((value) => datePart(value))
        .filter(Boolean)
        .sort();
      if (sortedDates.length) {
        console.log(`found date range: ${sortedDates[0]} .. ${sortedDates[sortedDates.length - 1]}`);
      }
    }

    for (const operation of operations) {
      await downloadOperationFiles(page, operation, indexRecords);
      await sleep(100);
    }

    const index = {
      generatedAt: new Date().toISOString(),
      targetDate: TARGET_DATE_DOT,
      source: "browser-cookie-mode",
      outputDir: OUTPUT_DIR,
      files: indexRecords,
    };

    await fs.writeFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, "utf8");

    console.table(indexRecords.map((row) => ({
      GTIN: row.gtin,
      operationId: row.operationId,
      status: row.status,
      savedFilename: row.savedFilename,
    })));

    console.log(`index: ${INDEX_PATH}`);
    console.log(`output: ${OUTPUT_DIR}`);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
