const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const authHelper = require("./teksher-auth");

const BASE_URL = "https://label.teksher.kg";
const OPERATIONS_URL = `${BASE_URL}/operations`;
const SESSION_PROFILE_DIR = path.join(__dirname, "teksher-session-profile");
const TMP_DIR = path.join(__dirname, "tmp");
const OUTPUT_DIR = path.join(os.homedir(), "Desktop", "заказ км", "электросталь печать кодов паркеровки");
const INDEX_PATH = path.join(OUTPUT_DIR, "index.json");
const RAW_OPERATIONS_PATH = path.join(OUTPUT_DIR, "operations_raw.json");
const PROBE_RESULTS_PATH = path.join(OUTPUT_DIR, "endpoint_probe_results.json");
const HEALTH_CHECK_PATH = path.join(OUTPUT_DIR, "endpoint_health_check.json");
const TOKEN_DIAGNOSTIC_PATH = path.join(OUTPUT_DIR, "token_diagnostic.json");
const AUTH_TOKENS_PATH = path.join(__dirname, "auth_tokens.json");
const ACCESS_TOKEN_PATH = path.join(__dirname, "access_token.json");
const REFRESH_TOKEN_PATH = path.join(__dirname, "refresh_token.json");
const STORAGE_STATE_PATH = path.join(__dirname, "storageState.json");
const COOKIES_PATH = path.join(__dirname, "cookies.json");
const TARGET_DATE = "2026-05-15";
const TARGET_DATE_DOT = "15.05.2026";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LIST_PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = 45000;
const TOKEN_URL = "http://10.242.17.100:8800/realms/mzkm_prod_realm/protocol/openid-connect/token";
const CLIENT_ID = "facade_client";

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

function looksLikeJwt(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.trim());
}

function normalizeToken(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "").trim();
}

function decodeJwtPayload(token) {
  if (!looksLikeJwt(token)) return null;
  const parts = String(token).trim().split(".");
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function decodeJwtExpMs(token) {
  const payload = decodeJwtPayload(token);
  const exp = Number(payload?.exp || 0);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
}

function tokenPreview(token) {
  const value = normalizeToken(token);
  if (!value) return "";
  return `${value.slice(0, 12)}...${value.slice(-8)}`;
}

function isTokenExpired(token, skewMs = 60 * 1000) {
  const exp = decodeJwtExpMs(token);
  return !exp || exp <= Date.now() + skewMs;
}

function getTokenExpiresAt(token) {
  const exp = decodeJwtExpMs(token);
  return exp ? new Date(exp).toISOString() : "";
}

function stringifyCause(cause) {
  if (!cause) return "";
  if (typeof cause === "string") return cause;
  if (typeof cause === "object") {
    return JSON.stringify({
      name: cause.name || "",
      message: cause.message || "",
      code: cause.code || "",
    });
  }
  return String(cause);
}

function classifyNetworkFailure(text) {
  const value = String(text || "");
  if (!value) return "";
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|DNS/i.test(value)) return "dns";
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(value)) return "connect_refused";
  if (/ERR_CONNECTION_TIMED_OUT|ETIMEDOUT/i.test(value)) return "connect_timeout";
  if (/ERR_PROXY|ERR_TUNNEL/i.test(value)) return "proxy";
  if (/ERR_CERT|CERT/i.test(value)) return "tls";
  return "";
}

function logFetchDiagnostics(stepName, url, timeoutMs, error, requestFailures = []) {
  const payload = {
    step: stepName,
    url,
    timeoutMs,
    error: {
      name: error?.name || "",
      message: error?.message || "",
      stack: error?.stack || "",
      cause: JSON.stringify(error?.cause ?? null, null, 2),
    },
    requestFailures: (requestFailures || []).map((failure) => ({
      url: failure.url || "",
      method: failure.method || "",
      resourceType: failure.resourceType || "",
      errorText: failure.errorText || "",
      networkClass: classifyNetworkFailure(failure.errorText || failure.reason || failure.message || ""),
    })),
  };
  console.error(JSON.stringify(payload, null, 2));
  return payload;
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
      const parsed = JSON.parse(trimmed);
      collectTokenCandidates(parsed, source, out);
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

async function readJsonIfExists(filePath, fallback = null) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err && err.code === "ENOENT") return fallback;
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function summarizeFetchDiagnostics(url, timeoutMs, error, requestFailures = []) {
  const cause = error?.cause;
  const failure = requestFailures.find((entry) => entry.url === url) || requestFailures[requestFailures.length - 1] || null;
  const networkCause = failure?.errorText || failure?.failureText || failure?.reason || "";
  return {
    error: {
      name: error?.name || "",
      message: error?.message || "",
      cause: stringifyCause(cause),
      stack: error?.stack || "",
    },
    timeoutMs,
    endpointUrl: url,
    requestFailure: failure ? {
      url: failure.url || "",
      method: failure.method || "",
      resourceType: failure.resourceType || "",
      errorText: failure.errorText || "",
      networkClass: classifyNetworkFailure(networkCause),
    } : null,
  };
}

async function readStorageTokenCandidates(page, context) {
  const storage = await page.evaluate(() => {
    const readStore = (store) => {
      const result = {};
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        result[key] = store.getItem(key);
      }
      return result;
    };
    return {
      localStorage: readStore(window.localStorage),
      sessionStorage: readStore(window.sessionStorage),
    };
  }).catch(() => ({ localStorage: {}, sessionStorage: {} }));

  const candidates = [];
  collectTokenCandidates(storage.localStorage, "localStorage", candidates);
  collectTokenCandidates(storage.sessionStorage, "sessionStorage", candidates);

  const cookies = await context.cookies().catch(() => []);
  for (const cookie of cookies) {
    collectTokenCandidates(cookie.value, `cookie.${cookie.name}`, candidates);
  }

  return candidates;
}

async function readFileTokenCandidates() {
  const candidates = [];
  const files = [
    [AUTH_TOKENS_PATH, "auth_tokens"],
    [ACCESS_TOKEN_PATH, "access_token"],
    [REFRESH_TOKEN_PATH, "refresh_token"],
    [STORAGE_STATE_PATH, "storageState"],
    [COOKIES_PATH, "cookies"],
  ];

  for (const [filePath, source] of files) {
    const data = await readJsonIfExists(filePath, null);
    if (data != null) collectTokenCandidates(data, source, candidates);
  }

  return candidates;
}

function chooseAccessToken(candidates) {
  const unique = candidates
    .map((item) => ({ ...item, token: normalizeToken(item.token) }))
    .filter((item) => item.token && !/refresh/i.test(item.source));
  unique.sort((a, b) => (decodeJwtExpMs(b.token) || 0) - (decodeJwtExpMs(a.token) || 0));
  return unique.find((item) => !isTokenExpired(item.token)) || unique[0] || null;
}

function chooseRefreshToken(candidates) {
  const unique = candidates
    .map((item) => ({ ...item, token: normalizeToken(item.token) }))
    .filter((item) => item.token && /refresh/i.test(item.source));
  return unique.find((item) => /refresh/i.test(item.source) && item.token) || unique[0] || null;
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: normalizeToken(refreshToken),
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(responseText || `refresh failed with HTTP ${response.status}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error("refresh response is not JSON");
  }

  const accessToken = normalizeToken(parsed.access_token || parsed.accessToken || "");
  const nextRefreshToken = normalizeToken(parsed.refresh_token || parsed.refreshToken || refreshToken);
  if (!accessToken) {
    throw new Error("access_token missing in refresh response");
  }

  const savedAt = new Date().toISOString();
  await writeJson(AUTH_TOKENS_PATH, {
    access_token: accessToken,
    refresh_token: nextRefreshToken,
    savedAt,
    source: "export-2026-05-15",
  });

  return {
    accessToken,
    refreshToken: nextRefreshToken,
    tokenExpiresAt: getTokenExpiresAt(accessToken),
    hasAccessToken: true,
    isExpired: false,
    savedAt,
    source: "refresh",
  };
}

async function resolveAuth(page, context) {
  const fileCandidates = await readFileTokenCandidates();
  const sessionCandidates = await readStorageTokenCandidates(page, context);
  const candidates = [...fileCandidates, ...sessionCandidates];
  const accessCandidate = chooseAccessToken(candidates);
  const refreshCandidate = chooseRefreshToken(candidates);

  let accessToken = accessCandidate?.token || "";
  let source = accessCandidate?.source || "";
  let tokenExpiresAt = getTokenExpiresAt(accessToken);
  let isExpired = !accessToken || isTokenExpired(accessToken);
  let hasAccessToken = Boolean(accessToken);

  if ((!hasAccessToken || isExpired) && refreshCandidate?.token) {
    const refreshed = await refreshAccessToken(refreshCandidate.token);
    accessToken = refreshed.accessToken;
    source = refreshed.source;
    tokenExpiresAt = refreshed.tokenExpiresAt;
    isExpired = refreshed.isExpired;
    hasAccessToken = refreshed.hasAccessToken;
  }

  const diagnostic = {
    generatedAt: new Date().toISOString(),
    hasAccessToken,
    tokenExpiresAt,
    isExpired,
    source,
    accessTokenSource: accessCandidate?.source || "",
    refreshTokenSource: refreshCandidate?.source || "",
  };

  await writeJson(TOKEN_DIAGNOSTIC_PATH, diagnostic);
  console.log("token diagnostic:");
  console.table([diagnostic]);

  if (!hasAccessToken) {
    throw new Error("No access token found");
  }

  if (isExpired) {
    throw new Error("TOKEN_EXPIRED: access token is still expired after refresh attempt");
  }

  return {
    accessToken,
    authHeaders: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    diagnostic,
  };
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

async function readTextResponse(page, url, authHeaders) {
  const requestFailures = [];
  const onRequestFailed = (request) => {
    const requestUrl = request.url();
    if (requestUrl === url || requestUrl.startsWith(url) || url.startsWith(requestUrl)) {
      const failure = request.failure() || {};
      requestFailures.push({
        url: requestUrl,
        method: request.method(),
        resourceType: request.resourceType(),
        errorText: failure.errorText || "",
      });
    }
  };

  page.on("requestfailed", onRequestFailed);
  try {
    const result = await page.evaluate(async ({ requestUrl, timeoutMs, requestHeaders }) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("Request timeout")), timeoutMs);
      try {
        const response = await fetch(requestUrl, {
          method: "GET",
          credentials: "include",
          redirect: "follow",
          headers: requestHeaders,
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
          error: null,
        };
      } catch (error) {
        return {
          url: requestUrl,
          httpStatus: 0,
          ok: false,
          statusText: "FETCH_FAILED",
          headers: {},
          body: null,
          error: {
            name: error?.name || "Error",
            message: error?.message || String(error),
            cause: stringifyCause(error?.cause),
            stack: error?.stack || "",
          },
        };
      } finally {
        clearTimeout(timeout);
      }
    }, { requestUrl: url, timeoutMs: REQUEST_TIMEOUT_MS, requestHeaders: authHeaders });

    if (result.error) {
      logFetchDiagnostics("readTextResponse", url, REQUEST_TIMEOUT_MS, {
        name: result.error.name,
        message: result.error.message,
        stack: result.error.stack,
        cause: result.error.cause,
      }, requestFailures);
    }

    return {
      ...result,
      timeoutMs: REQUEST_TIMEOUT_MS,
      requestFailures,
    };
  } catch (error) {
    logFetchDiagnostics("readTextResponse.catch", url, REQUEST_TIMEOUT_MS, error, requestFailures);
    return {
      url,
      httpStatus: 0,
      ok: false,
      statusText: "EVALUATE_FAILED",
      headers: {},
      body: null,
      timeoutMs: REQUEST_TIMEOUT_MS,
      error: {
        name: error?.name || "Error",
        message: error?.message || String(error),
        cause: stringifyCause(error?.cause),
        stack: error?.stack || "",
      },
      requestFailures,
    };
  } finally {
    page.off("requestfailed", onRequestFailed);
  }
}

async function probeEndpoint(page, url, authHeaders) {
  const response = await readTextResponse(page, url, authHeaders);
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
    error: response.error || null,
    timeoutMs: response.timeoutMs || REQUEST_TIMEOUT_MS,
    requestFailures: response.requestFailures || [],
  };
}

async function readBinaryResponse(page, url, authHeaders) {
  const requestFailures = [];
  const onRequestFailed = (request) => {
    const requestUrl = request.url();
    if (requestUrl === url || requestUrl.startsWith(url) || url.startsWith(requestUrl)) {
      const failure = request.failure() || {};
      requestFailures.push({
        url: requestUrl,
        method: request.method(),
        resourceType: request.resourceType(),
        errorText: failure.errorText || "",
      });
    }
  };

  page.on("requestfailed", onRequestFailed);
  try {
    const result = await page.evaluate(async ({ requestUrl, timeoutMs, requestHeaders }) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("Request timeout")), timeoutMs);
      try {
        const response = await fetch(requestUrl, {
          method: "GET",
          credentials: "include",
          redirect: "follow",
          headers: requestHeaders,
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
          error: null,
        };
      } catch (error) {
        return {
          url: requestUrl,
          httpStatus: 0,
          ok: false,
          statusText: "FETCH_FAILED",
          headers: {},
          bytes: [],
          error: {
            name: error?.name || "Error",
            message: error?.message || String(error),
            cause: stringifyCause(error?.cause),
            stack: error?.stack || "",
          },
        };
      } finally {
        clearTimeout(timeout);
      }
    }, { requestUrl: url, timeoutMs: REQUEST_TIMEOUT_MS, requestHeaders: authHeaders });

    if (result.error) {
      logFetchDiagnostics("readBinaryResponse", url, REQUEST_TIMEOUT_MS, {
        name: result.error.name,
        message: result.error.message,
        stack: result.error.stack,
        cause: result.error.cause,
      }, requestFailures);
    }

    return {
      ...result,
      timeoutMs: REQUEST_TIMEOUT_MS,
      requestFailures,
    };
  } catch (error) {
    logFetchDiagnostics("readBinaryResponse.catch", url, REQUEST_TIMEOUT_MS, error, requestFailures);
    return {
      url,
      httpStatus: 0,
      ok: false,
      statusText: "EVALUATE_FAILED",
      headers: {},
      bytes: [],
      timeoutMs: REQUEST_TIMEOUT_MS,
      error: {
        name: error?.name || "Error",
        message: error?.message || String(error),
        cause: stringifyCause(error?.cause),
        stack: error?.stack || "",
      },
      requestFailures,
    };
  } finally {
    page.off("requestfailed", onRequestFailed);
  }
}

async function runReadOnlyHealthCheck(page, authHeaders) {
  const url = `${BASE_URL}/facade/api/v1/products?page=0&size=1&productGroup=1&createdByIssuer=true&status=PUBLISHED`;
  const result = await readTextResponse(page, url, authHeaders);
  await writeJson(HEALTH_CHECK_PATH, {
    generatedAt: new Date().toISOString(),
    url,
    timeoutMs: result.timeoutMs || REQUEST_TIMEOUT_MS,
    httpStatus: result.httpStatus,
    ok: result.ok,
    error: result.error || null,
    requestFailures: result.requestFailures || [],
    firstKeys: firstJsonKeys(result.body),
  });
  return result;
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

async function collectOperations(page, preferredUrls = [], authHeaders) {
  const discovered = new Map();
  const responses = [];

  for (const url of uniq([...preferredUrls, ...buildListUrls()])) {
    try {
      const response = await readTextResponse(page, url, authHeaders);
      responses.push(response);
    } catch (error) {
      logFetchDiagnostics("collectOperations.list", url, REQUEST_TIMEOUT_MS, error, []);
      responses.push({
        url,
        httpStatus: 0,
        ok: false,
        statusText: "EVALUATE_FAILED",
        headers: {},
        body: null,
        error: {
          name: error?.name || "Error",
          message: error?.message || String(error),
          cause: stringifyCause(error?.cause),
          stack: error?.stack || "",
        },
        timeoutMs: REQUEST_TIMEOUT_MS,
        requestFailures: [],
      });
    }
  }

  const detailIds = uniq(
    responses.flatMap((response) => collectOperationObjects(response.body).map((object) => normalizeOperation(object, response.url)).filter(Boolean))
      .map((operation) => operation.operationId)
  );

  for (const operationId of detailIds) {
    const detailUrl = `${BASE_URL}/facade/api/v1/operations/${encodeURIComponent(operationId)}`;
    try {
      const response = await readTextResponse(page, detailUrl, authHeaders);
      responses.push(response);
      const operation = normalizeOperation(response.body, detailUrl);
      if (operation) {
        const existing = discovered.get(operation.operationId);
        if (!existing || operationCreatedAtTime(operation) >= operationCreatedAtTime(existing)) {
          discovered.set(operation.operationId, buildOperationSnapshot(response.body, detailUrl));
        }
      }
    } catch (error) {
      logFetchDiagnostics("collectOperations.detail", detailUrl, REQUEST_TIMEOUT_MS, error, []);
      responses.push({
        url: detailUrl,
        httpStatus: 0,
        ok: false,
        statusText: "EVALUATE_FAILED",
        headers: {},
        body: null,
        error: {
          name: error?.name || "Error",
          message: error?.message || String(error),
          cause: stringifyCause(error?.cause),
          stack: error?.stack || "",
        },
        timeoutMs: REQUEST_TIMEOUT_MS,
        requestFailures: [],
      });
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

async function probeOperationEndpoints(page, authHeaders) {
  const results = [];
  for (const url of PROBE_ENDPOINTS) {
    try {
      const result = await probeEndpoint(page, url, authHeaders);
      results.push(result);
    } catch (error) {
      logFetchDiagnostics("probeOperationEndpoints", url, REQUEST_TIMEOUT_MS, error, []);
      results.push({
        url,
        httpStatus: 0,
        ok: false,
        size: 0,
        firstKeys: [],
        operationCount: 0,
        error: {
          name: error?.name || "Error",
          message: error?.message || String(error),
          cause: stringifyCause(error?.cause),
          stack: error?.stack || "",
        },
        timeoutMs: REQUEST_TIMEOUT_MS,
        requestFailures: [],
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

async function tryDownloadFile(page, operation, candidateUrl, records, seenUrls, authHeaders, depth = 0) {
  if (!candidateUrl || depth > 2) return null;
  const absolute = new URL(candidateUrl, BASE_URL).toString();
  if (seenUrls.has(absolute)) return null;
  seenUrls.add(absolute);

  const response = await readBinaryResponse(page, absolute, authHeaders);
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
      return tryDownloadFile(page, operation, nextCandidate, records, seenUrls, authHeaders, depth + 1);
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
    return tryDownloadFile(page, operation, nextCandidate, records, seenUrls, authHeaders, depth + 1);
  }

  return null;
}

async function downloadOperationFiles(page, operation, records, authHeaders) {
  const seenUrls = new Set();
  for (const template of FILE_ENDPOINTS) {
    const url = `${BASE_URL}${template.replace("{operationId}", encodeURIComponent(operation.operationId))}`;
    try {
      await tryDownloadFile(page, operation, url, records, seenUrls, authHeaders);
    } catch (error) {
      logFetchDiagnostics("downloadOperationFiles", url, REQUEST_TIMEOUT_MS, error, []);
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

    let auth = await authHelper.resolveAuth(page, context, {
      fileSpecs: [
        { path: AUTH_TOKENS_PATH, source: "auth_tokens" },
        { path: ACCESS_TOKEN_PATH, source: "access_token" },
        { path: REFRESH_TOKEN_PATH, source: "refresh_token" },
        { path: STORAGE_STATE_PATH, source: "storageState" },
        { path: COOKIES_PATH, source: "cookies" },
      ],
      authTokensPath: AUTH_TOKENS_PATH,
      tokenUrl: TOKEN_URL,
      clientId: CLIENT_ID,
      source: "export-2026-05-15",
    });

    let healthCheck = await runReadOnlyHealthCheck(page, auth.authHeaders);
    if (healthCheck.httpStatus === 401 && auth.refreshToken) {
      console.log("products returned 401, refreshing token and retrying health check");
      auth = await authHelper.refreshAuthToken(auth.refreshToken, {
        tokenUrl: TOKEN_URL,
        clientId: CLIENT_ID,
        authTokensPath: AUTH_TOKENS_PATH,
        source: "export-2026-05-15",
      });
      auth = {
        ...auth,
        authHeaders: {
          Authorization: `Bearer ${auth.accessToken}`,
          Accept: "application/json",
        },
      };
      healthCheck = await runReadOnlyHealthCheck(page, {
        ...auth.authHeaders,
      });
    }
    console.log("health check saved:", HEALTH_CHECK_PATH);
    console.table([{
      url: healthCheck.url,
      status: healthCheck.httpStatus,
      ok: healthCheck.ok,
      errorName: healthCheck.error?.name || "",
      errorMessage: healthCheck.error?.message || "",
      requestFailure: healthCheck.requestFailures?.[0]?.errorText || "",
    }]);

    if (!healthCheck.ok) {
      const failure = healthCheck.error || {};
      console.log(`health check failed: ${JSON.stringify({
        url: healthCheck.url,
        timeoutMs: healthCheck.timeoutMs || REQUEST_TIMEOUT_MS,
        error: {
          name: failure.name || "",
          message: failure.message || "",
          cause: failure.cause || "",
        },
        requestFailures: healthCheck.requestFailures || [],
      })}`);
      return;
    }

    const probeResults = await probeOperationEndpoints(page, auth.authHeaders);
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
      error: result.error?.message || result.error || "",
      requestFailure: result.requestFailures?.[0]?.errorText || "",
    })));

    const bestProbe = probeResults.find((result) => (result.operationCount || 0) > 0);
    if (!bestProbe) {
      if (healthCheck.ok) {
        console.log("Health check passed, but operations list endpoints failed. Problem is likely the operations endpoint or its auth/response shape.");
      } else {
        console.log("Health check also failed. Problem is likely network/DNS/VPN/access.");
      }
      console.log("No non-empty list endpoint found yet. Export is paused.");
      return;
    }
    console.log(`Selected list endpoint: ${bestProbe.url}`);

    const preferredListUrls = probeResults
      .filter((result) => (result.operationCount || 0) > 0)
      .map((result) => result.url);
    const { responses, operations: rawOperations } = await collectOperations(page, preferredListUrls, auth.authHeaders);
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
      await downloadOperationFiles(page, operation, indexRecords, auth.authHeaders);
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
  logFetchDiagnostics("main.catch", "", REQUEST_TIMEOUT_MS, error, []);
  process.exitCode = 1;
});
