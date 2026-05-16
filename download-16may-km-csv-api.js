const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const authHelper = require("./teksher-auth");

const PROJECT_DIR = __dirname;
const BASE_URL = "https://label.teksher.kg";
const AUTH_TOKENS_PATH = path.join(PROJECT_DIR, "auth_tokens.json");
const OUTPUT_DIR = path.join(os.homedir(), "Desktop", "Текшер CSV", "16.05.2026");
const LOG_PATH = path.join(PROJECT_DIR, "download_16may_km_csv_api_log.json");
const LIST_ENDPOINT = "/facade/api/v1/operations/filter?size=15&page={page}&startDate=2026-05-16&endDate=2026-05-17";
const CSV_ENDPOINT = "/facade/api/v1/marking_codes/csv?operationId={operationId}";
const REQUEST_TIMEOUT = 45000;
const TARGET_DATE = "2026-05-16";
const TARGET_OPERATION_TYPE = "MARK_CODE_ORDER";

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
  return value.startsWith(TARGET_DATE) || normalizeDateOnly(value) === TARGET_DATE;
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
    const response = await fetchWithTimeout(url, {
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
  const response = await fetchWithTimeout(url, { method: "GET", headers });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { url, status: response.status, ok: response.ok, json, text };
}

async function loadOperations(headers) {
  const pages = [];
  let pageNumber = 0;
  let totalPages = null;
  const seenIds = new Set();
  const rows = [];
  while (true) {
    const page = await fetchOperationListPage(pageNumber, headers);
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
  return { pages, rows };
}

async function downloadCsv(operationId, headers, fileBase) {
  const url = buildUrl(CSV_ENDPOINT.replace("{operationId}", encodeURIComponent(operationId)));
  console.log(`CSV URL: ${url}`);
  const response = await fetchWithTimeout(url, { method: "GET", headers });
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
  const { rows } = await loadOperations(authState.headers);
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

  console.log(`total operations found: ${accepted.length}`);
  console.log(`output folder: ${OUTPUT_DIR}`);
  console.log(`token exp: ${new Date(authState.tokenExpiresAtMs).toISOString()}`);

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
    outputDir: OUTPUT_DIR,
    rows: results,
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
