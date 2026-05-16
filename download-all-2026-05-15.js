const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const authHelper = require("./teksher-auth");

const BASE_URL = "https://label.teksher.kg";
const TARGET_DATE = "2026-05-15";
const OUTPUT_DIR = path.join(os.homedir(), "Desktop", "электросталь печать кодов паркеровки");
const ALL_OPERATIONS_PATH = path.join(__dirname, "all_operations_2026-05-15.json");
const LOG_PATH = path.join(__dirname, "download_all_2026-05-15_log.json");
const AUTH_TOKENS_PATH = path.join(__dirname, "auth_tokens.json");
const REQUEST_TIMEOUT = 45000;
const CSV_ENDPOINT = "/facade/api/v1/marking_codes/csv?operationId={operationId}";
const LIST_ENDPOINTS = [
  "/facade/api/v1/operations?page=0&size=100",
  "/facade/api/v1/operations?page=0&size=100&createdFrom=2026-05-15&createdTo=2026-05-16",
  "/facade/order/api/v1/operations?page=0&size=100",
  "/facade/order/api/v1/operations?page=0&size=100&createdFrom=2026-05-15&createdTo=2026-05-16",
];
const DOWNLOAD_CONCURRENCY = 5;
const DOWNLOAD_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeToken(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "").trim();
}

function authPrefix(token) {
  return token ? `${token.slice(0, 12)}...` : "n/a";
}

function sanitizeFilePart(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildUrl(endpointPath) {
  return new URL(endpointPath, BASE_URL).toString();
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

function normalizeDateOnly(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const ddmmyyyy = text.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (ddmmyyyy) return `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  return text.slice(0, 10);
}

function extractCollection(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["content", "records", "items", "data", "result", "list", "operations"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function extractTotalPages(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const candidates = [
    payload.totalPages,
    payload.page?.totalPages,
    payload.pagination?.totalPages,
    payload.pageInfo?.totalPages,
    payload.meta?.totalPages,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function extractOperationName(record) {
  return pickText(record, [
    "operationTypeName",
    "operationName",
    "typeName",
    "name",
    "title",
    "operationType.name",
    "type.name",
    "operation.name",
    "documentType.name",
  ]);
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
  return pickText(record, [
    "status",
    "state",
    "operationStatus",
    "currentStatus",
    "documentStatus",
  ]);
}

function extractGtin(record) {
  return pickText(record, [
    "gtin",
    "productGtin",
    "product.gtin",
    "product.code",
    "product.codeValue",
    "item.gtin",
    "productBarCode",
  ]);
}

function isTargetOperation(record) {
  const name = extractOperationName(record);
  return name.includes("Заказ на эмиссию КМ");
}

function isTargetDate(record) {
  const createdAt = extractCreatedAt(record);
  return normalizeDateOnly(createdAt) === TARGET_DATE;
}

function collectAllOperationMeta(operations) {
  const merged = new Map();
  for (const operation of operations) {
    const operationId = String(operation.operationId || "").trim();
    if (!operationId) continue;
    const current = merged.get(operationId) || {
      operationId,
      gtin: operation.gtin || "",
      status: operation.status || "",
      createdAt: operation.createdAt || "",
      typeName: operation.typeName || "",
      sourceEndpoints: [],
    };
    if (!current.gtin && operation.gtin) current.gtin = operation.gtin;
    if (!current.status && operation.status) current.status = operation.status;
    if (!current.createdAt && operation.createdAt) current.createdAt = operation.createdAt;
    if (!current.typeName && operation.typeName) current.typeName = operation.typeName;
    if (operation.sourceEndpoint && !current.sourceEndpoints.includes(operation.sourceEndpoint)) {
      current.sourceEndpoints.push(operation.sourceEndpoint);
    }
    merged.set(operationId, current);
  }
  return Array.from(merged.values());
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

async function readPage(endpointPath, headers, page) {
  const url = new URL(endpointPath, BASE_URL);
  url.searchParams.set("page", String(page));
  console.log(`LIST URL: ${url.toString()}`);
  try {
    const response = await fetchWithTimeout(url.toString(), {
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
    return {
      url: url.toString(),
      status: response.status,
      ok: response.ok,
      json,
      text,
    };
  } catch (error) {
    console.error("LIST_ERROR");
    console.error(`url: ${url.toString()}`);
    console.error(`error.name: ${error?.name || "n/a"}`);
    console.error(`error.message: ${error?.message || "n/a"}`);
    console.error(`error.stack: ${error?.stack || "n/a"}`);
    console.error(`error.cause: ${JSON.stringify(error?.cause, null, 2)}`);
    return null;
  }
}

async function collectOperationsFromEndpoint(endpointPath, headers) {
  const collected = [];
  let page = 0;
  let totalPages = null;

  while (true) {
    const result = await readPage(endpointPath, headers, page);
    if (!result) break;
    if (!result.ok) {
      console.error(`LIST_HTTP_${result.status}`);
      console.error(`url: ${result.url}`);
      console.error(`body: ${result.text.slice(0, 500)}`);
      break;
    }

    const items = extractCollection(result.json);
    if (!items.length) break;

    for (const item of items) {
      const operationId = String(item?.operationId || item?.id || "").trim();
      if (!operationId) continue;
      collected.push({
        operationId,
        gtin: extractGtin(item),
        status: extractStatus(item),
        createdAt: extractCreatedAt(item),
        typeName: extractOperationName(item),
        sourceEndpoint: result.url,
      });
    }

    totalPages = extractTotalPages(result.json);
    const pageSize = items.length;
    page += 1;

    if (typeof totalPages === "number" && totalPages > 0 && page >= totalPages) break;
    if (items.length < 100) break;
    if (pageSize === 0) break;
  }

  return collected;
}

async function readAuthHeaders() {
  const candidates = await authHelper.readAuthCandidatesFromFiles([
    { path: AUTH_TOKENS_PATH, source: "auth_tokens.json" },
  ]);
  const accessCandidate = authHelper.chooseAccessToken(candidates);
  const accessToken = normalizeToken(accessCandidate?.token || "");
  const tokenExpiresAtMs = authHelper.decodeJwtExpMs(accessToken);
  if (!accessToken) {
    throw new Error("TOKEN_MISSING: auth_tokens.json access_token not found");
  }
  if (!tokenExpiresAtMs || tokenExpiresAtMs <= Date.now()) {
    throw new Error("TOKEN_EXPIRED: auth_tokens.json access_token is expired");
  }
  return {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json, text/plain, */*",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/operations`,
    },
    accessToken,
    tokenExpiresAtMs,
    authSource: accessCandidate?.source || "auth_tokens.json",
  };
}

async function downloadCsvOnce(operationId, headers) {
  const url = buildUrl(CSV_ENDPOINT.replace("{operationId}", encodeURIComponent(operationId)));
  console.log(`DOWNLOAD URL: ${url}`);
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers,
  });
  const contentType = response.headers.get("content-type") || "";
  const contentDisposition = response.headers.get("content-disposition") || "";
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    url,
    response,
    contentType,
    contentDisposition,
    buffer,
  };
}

async function downloadCsvWithRetry(record, headers, fileBase) {
  const attempts = [];
  let lastError = null;

  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt += 1) {
    try {
      const result = await downloadCsvOnce(record.operationId, headers);
      const { response, contentType, contentDisposition, buffer, url } = result;
      attempts.push({
        attempt,
        url,
        status: response.status,
        contentType,
        contentDisposition,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}: ${buffer.toString("utf8").slice(0, 500)}`);
      }

      const targetPath = path.join(OUTPUT_DIR, `${fileBase}.csv`);
      if (await fileExists(targetPath)) {
        return {
          status: "skipped",
          targetPath,
          attempts,
        };
      }

      await fs.writeFile(targetPath, buffer);
      return {
        status: "downloaded",
        targetPath,
        attempts,
      };
    } catch (error) {
      lastError = error;
      attempts.push({
        attempt,
        error: error?.name || "Error",
        message: error?.message || String(error),
        cause: error?.cause || null,
      });
      if (attempt < DOWNLOAD_RETRIES) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  return {
    status: "failed",
    error: lastError,
    attempts,
  };
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runNext() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  const runners = [];
  const workerCount = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < workerCount; i += 1) {
    runners.push(runNext());
  }
  await Promise.all(runners);
  return results;
}

function suffixBaseForGtin(gtin, counts) {
  const key = gtin || "";
  const nextIndex = (counts.get(key) || 0) + 1;
  counts.set(key, nextIndex);
  const base = sanitizeFilePart(gtin || "");
  if (!base) return `operation`;
  return nextIndex === 1 ? base : `${base}_${nextIndex}`;
}

async function main() {
  await ensureDir(OUTPUT_DIR);

  const authState = await readAuthHeaders();
  console.log("AUTH_DIAGNOSTICS");
  console.log(`token file path: ${AUTH_TOKENS_PATH}`);
  console.log(`access token exists: ${authState.accessToken ? "yes" : "no"}`);
  console.log(`access token source: ${authState.authSource}`);
  console.log(`access token prefix: ${authPrefix(authState.accessToken)}`);
  console.log(`token exp: ${new Date(authState.tokenExpiresAtMs).toISOString()}`);
  console.log(`current time: ${new Date().toISOString()}`);

  const allRaw = [];
  for (const endpointPath of LIST_ENDPOINTS) {
    const rows = await collectOperationsFromEndpoint(endpointPath, authState.headers);
    allRaw.push(...rows);
  }

  const allOperations = collectAllOperationMeta(allRaw)
    .filter((record) => isTargetDate(record))
    .filter((record) => isTargetOperation(record));

  await writeJson(
    ALL_OPERATIONS_PATH,
    allOperations.map((record) => ({
      operationId: record.operationId,
      gtin: record.gtin,
      status: record.status,
      createdAt: record.createdAt,
      typeName: record.typeName,
      sourceEndpoints: record.sourceEndpoints || [],
    }))
  );

  if (!allOperations.length) {
    await writeJson(LOG_PATH, {
      generatedAt: new Date().toISOString(),
      allOperationsPath: ALL_OPERATIONS_PATH,
      outputDir: OUTPUT_DIR,
      rows: [],
    });
    console.log("total operations found: 0");
    console.log("downloaded: 0");
    console.log("skipped existing: 0");
    console.log("failed: 0");
    return;
  }

  const indexed = [];
  const gtinCounts = new Map();
  for (const operation of allOperations) {
    indexed.push({
      ...operation,
      fileBase: suffixBaseForGtin(operation.gtin || operation.operationId, gtinCounts),
    });
  }

  const tableRows = [];
  const logRows = [];
  let downloaded = 0;
  let skippedExisting = 0;
  let failed = 0;

  await runWithConcurrency(indexed, DOWNLOAD_CONCURRENCY, async (operation) => {
    const result = await downloadCsvWithRetry(operation, authState.headers, operation.fileBase);
    const baseRow = {
      operationId: operation.operationId,
      gtin: operation.gtin,
      status: operation.status,
      createdAt: operation.createdAt,
      typeName: operation.typeName,
    };
    if (result.status === "downloaded") {
      downloaded += 1;
      tableRows.push({ ...baseRow, filePath: result.targetPath });
      logRows.push({
        ...baseRow,
        outcome: "downloaded",
        filePath: result.targetPath,
        attempts: result.attempts,
      });
      return;
    }
    if (result.status === "skipped") {
      skippedExisting += 1;
      tableRows.push({ ...baseRow, filePath: result.targetPath });
      logRows.push({
        ...baseRow,
        outcome: "skipped_existing",
        filePath: result.targetPath,
        attempts: result.attempts,
      });
      return;
    }
    failed += 1;
    const errorText = result.error ? result.error.message || String(result.error) : "Download failed";
    tableRows.push({ ...baseRow, filePath: `ERROR: ${errorText}` });
    logRows.push({
      ...baseRow,
      outcome: "failed",
      error: errorText,
      attempts: result.attempts,
    });
  });

  await writeJson(LOG_PATH, {
    generatedAt: new Date().toISOString(),
    sourcePath: ALL_OPERATIONS_PATH,
    outputDir: OUTPUT_DIR,
    rows: logRows,
  });

  console.table(
    tableRows.map((row) => ({
      operationId: row.operationId,
      gtin: row.gtin,
      status: row.status,
      createdAt: row.createdAt,
      typeName: row.typeName,
      filePath: row.filePath,
    }))
  );

  console.log(`total operations found: ${allOperations.length}`);
  console.log(`downloaded: ${downloaded}`);
  console.log(`skipped existing: ${skippedExisting}`);
  console.log(`failed: ${failed}`);
}

main().catch((error) => {
  console.error("FATAL_ERROR");
  console.error(`error.name: ${error?.name || "n/a"}`);
  console.error(`error.message: ${error?.message || "n/a"}`);
  console.error(`error.stack: ${error?.stack || "n/a"}`);
  console.error(`error.cause: ${JSON.stringify(error?.cause, null, 2)}`);
  process.exitCode = 1;
});
