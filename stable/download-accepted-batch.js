const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const authHelper = require("./teksher-auth");

const BASE_URL = "https://label.teksher.kg";
const TARGET_DATE = "2026-05-16";
const EXCLUDED_DATE = "2026-05-15";
const OUTPUT_DIR = path.join(os.homedir(), "Desktop", "123 электросталь 2026-05-16");
const ALL_OPERATIONS_PATH = path.join(__dirname, "all_operations_2026-05-16.json");
const LOG_PATH = path.join(__dirname, "download_all_2026-05-16_log.json");
const AUTH_TOKENS_PATH = path.join(__dirname, "auth_tokens.json");
const REQUEST_TIMEOUT = 45000;
const CSV_ENDPOINT = "/facade/api/v1/marking_codes/csv?operationId={operationId}";
const LIST_ENDPOINTS = [
  `/facade/api/v1/operations/filter?size=15&page=0&startDate=2026-05-16&endDate=2026-05-17`,
];
const EXPECTED_FILES_SOURCE_DIRS = [
  path.join(os.homedir(), "Desktop", "123 электросталь"),
];
const EXPECTED_FILES_EXCLUDED = new Set([
  "04707197100846.csv",
  "04707197100853.csv",
  "04707197101065.csv",
  "04707197100419.csv",
]);
const DOWNLOAD_CONCURRENCY = 5;
const DOWNLOAD_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const EXPECTED_TOTAL_CSV = 81;
const EXPECTED_DUPLICATE_2 = 9;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function clearDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await ensureDir(dir);
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

function extractOperationLabel(record) {
  return pickText(record, [
    "product.fullName",
    "product.name",
    "product.title",
    "productDto.fullName",
    "productDto.name",
    "productDto.title",
    "product.name",
    "product.fullName",
    "product.title",
    "productName",
    "name",
    "title",
    "documentName",
    "operationTypeName",
    "operationName",
    "typeName",
    "operationType.name",
    "type.name",
    "operation.name",
    "documentType.name",
    "products.0.name",
    "products.0.fullName",
    "products.0.title",
    "items.0.name",
    "items.0.fullName",
    "items.0.title",
    "markingCodes.0.name",
    "markingCodes.0.fullName",
    "markingCodes.0.title",
    "batch.name",
    "batch.title",
    "order.name",
    "order.title",
  ]);
}

function extractGtinLike(value) {
  const text = JSON.stringify(value || "");
  const match = text.match(/\b\d{14}\b/);
  return match ? match[0] : "";
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
  return pickText(record, ["status", "state", "operationStatus", "currentStatus", "documentStatus"]);
}

function extractOperationId(record) {
  return pickText(record, ["operationId", "id"]);
}

function isTargetDate(record) {
  const value = String(extractCreatedAt(record) || "").trim();
  return value.startsWith(TARGET_DATE) || normalizeDateOnly(value) === TARGET_DATE;
}

function isExcludedDate(record) {
  const value = String(extractCreatedAt(record) || "").trim();
  return value.startsWith(EXCLUDED_DATE) || normalizeDateOnly(value) === EXCLUDED_DATE;
}

function collectAllOperationMeta(operations) {
  const merged = new Map();
  for (const operation of operations) {
    const operationId = extractOperationId(operation);
    if (!operationId) continue;
    const current = merged.get(operationId) || {
      operationId,
      label: operation.label || "",
      status: operation.status || "",
      createdAt: operation.createdAt || "",
      sourceEndpoints: [],
    };
    if (!current.label && operation.label) current.label = operation.label;
    if (!current.status && operation.status) current.status = operation.status;
    if (!current.createdAt && operation.createdAt) current.createdAt = operation.createdAt;
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
      requestedSize: Number(url.searchParams.get("size")) || 100,
      page,
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
    if (page === 0) {
      const rootKeys = result.json && typeof result.json === "object" && !Array.isArray(result.json)
        ? Object.keys(result.json)
        : [];
      console.log("PAGE0_ROOT_KEYS");
      console.log(JSON.stringify(rootKeys, null, 2));
      console.log("PAGE0_FIRST_ITEM_KEYS");
      console.log(JSON.stringify(items[0] && typeof items[0] === "object" ? Object.keys(items[0]) : [], null, 2));
      console.log("PAGE0_JSON_SNIPPET");
      console.log(JSON.stringify(result.json, null, 2).slice(0, 5000));
    }
    if (!items.length) break;

    for (const item of items) {
      const operationId = extractOperationId(item);
      if (!operationId) continue;
      console.log(
        JSON.stringify(
          {
            operationId,
            createdAt: extractCreatedAt(item),
            productGroupMarkingDtoName: pickText(item, ["productGroupMarkingDto.name"]),
            status: extractStatus(item),
          },
          null,
          0
        )
      );
      collected.push({
        operationId,
        label: extractOperationLabel(item),
        status: extractStatus(item),
        createdAt: extractCreatedAt(item),
        sourceEndpoint: result.url,
      });
    }

    totalPages = extractTotalPages(result.json);
    const pageSize = items.length;
    const requestedSize = result.requestedSize || 100;
    page += 1;

    if (typeof totalPages === "number" && totalPages > 0 && page >= totalPages) break;
    if (items.length < requestedSize) break;
    if (pageSize === 0) break;
  }

  return collected;
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
    return {
      url,
      status: response.status,
      ok: response.ok,
      json,
      text,
    };
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

async function loadExpectedFiles() {
  for (const sourceDir of EXPECTED_FILES_SOURCE_DIRS) {
    try {
      const entries = await fs.readdir(sourceDir, { withFileTypes: true });
      const expectedNames = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"))
        .map((entry) => entry.name)
        .filter((name) => !EXPECTED_FILES_EXCLUDED.has(name))
        .map((name) => path.basename(name, ".csv"))
        .sort();
      if (expectedNames.length) {
        return {
          sourceDir,
          expectedNames,
          expectedSet: new Set(expectedNames),
        };
      }
    } catch {}
  }
  return {
    sourceDir: "",
    expectedNames: [],
    expectedSet: new Set(),
  };
}

function chooseExpectedFileBase(operation, detail, expectedSet) {
  const candidates = [
    extractOperationLabel(detail?.json || {}),
    extractOperationLabel(operation),
    extractGtinLike(detail?.json || {}),
    extractGtinLike(operation),
    operation.operationId,
  ];

  for (const candidate of candidates) {
    const base = sanitizeFilePart(candidate);
    if (base && expectedSet.has(base)) return base;
  }

  return "";
}

function minuteKey(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 16) : "";
}

function summarizeAcceptedByMinute(operations) {
  const counts = new Map();
  for (const operation of operations) {
    const key = minuteKey(operation.createdAt);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function findAcceptedBatchWindow(operations, expectedCount) {
  if (operations.length < expectedCount) return null;
  let best = null;
  for (let start = 0; start + expectedCount <= operations.length; start += 1) {
    const window = operations.slice(start, start + expectedCount);
    const startCreatedAt = window[0]?.createdAt || "";
    const endCreatedAt = window[window.length - 1]?.createdAt || "";
    const startTime = Date.parse(startCreatedAt) || 0;
    const endTime = Date.parse(endCreatedAt) || 0;
    const spanMs = Math.max(0, endTime - startTime);
    const startMinute = minuteKey(startCreatedAt);
    const endMinute = minuteKey(endCreatedAt);
    const score = {
      start,
      window,
      startCreatedAt,
      endCreatedAt,
      startMinute,
      endMinute,
      spanMs,
    };
    if (!best) {
      best = score;
      continue;
    }
    if (score.spanMs < best.spanMs) {
      best = score;
      continue;
    }
    if (score.spanMs === best.spanMs && score.start < best.start) {
      best = score;
    }
  }
  return best;
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

      if (response.status === 404 || response.status === 409 || !buffer.length) {
        return {
          status: "skipped_not_ready",
          reason: "not ready",
          targetPath: "",
          attempts,
        };
      }

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

function suffixBaseForLabel(label, counts, fallbackId) {
  const key = label || fallbackId || "operation";
  const nextIndex = (counts.get(key) || 0) + 1;
  counts.set(key, nextIndex);
  const base = sanitizeFilePart(label || fallbackId || "operation");
  return nextIndex === 1 ? base : `${base}_${nextIndex}`;
}

function validateFinalFolder(expectedNames) {
  return fs
    .readdir(OUTPUT_DIR)
    .then((entries) => entries.filter((name) => name.endsWith(".csv")).sort())
    .then((actualNames) => {
      const actualSet = new Set(actualNames);
      const expectedSet = new Set(expectedNames);
      const missing = expectedNames.filter((name) => !actualSet.has(name));
      const extra = actualNames.filter((name) => !expectedSet.has(name));
      const duplicate2 = actualNames.filter((name) => /_2\.csv$/i.test(name)).length;
      const ok =
        actualNames.length === EXPECTED_TOTAL_CSV &&
        duplicate2 === EXPECTED_DUPLICATE_2 &&
        missing.length === 0 &&
        extra.length === 0;
      return {
        ok,
        actualNames,
        missing,
        extra,
        duplicate2,
      };
    });
}

async function main() {
  await clearDir(OUTPUT_DIR);

  const authState = await readAuthHeaders();
  const expectedFiles = await loadExpectedFiles();
  console.log("AUTH_DIAGNOSTICS");
  console.log(`token file path: ${AUTH_TOKENS_PATH}`);
  console.log(`access token exists: ${authState.accessToken ? "yes" : "no"}`);
  console.log(`access token source: ${authState.authSource}`);
  console.log(`access token prefix: ${authPrefix(authState.accessToken)}`);
  console.log(`token exp: ${new Date(authState.tokenExpiresAtMs).toISOString()}`);
  console.log(`current time: ${new Date().toISOString()}`);
  console.log(`expected files source: ${expectedFiles.sourceDir || "n/a"}`);
  console.log(`expected files count: ${expectedFiles.expectedNames.length}`);

  const allRaw = [];
  for (const endpointPath of LIST_ENDPOINTS) {
    const rows = await collectOperationsFromEndpoint(endpointPath, authState.headers);
    allRaw.push(...rows);
  }

  const filteredRaw = allRaw.filter((record) => isTargetDate(record));
  const excluded15May = allRaw.filter((record) => isExcludedDate(record)).length;
  console.log(`total raw operations before date filter: ${allRaw.length}`);
  console.log(`total operations after date filter: ${filteredRaw.length}`);
  console.log(
    `first 5 operationIds: ${filteredRaw
      .slice(0, 5)
      .map((record) => extractOperationId(record))
      .filter(Boolean)
      .join(", ") || "none"}`
  );

  const acceptedOperations = filteredRaw
    .map((record) => ({
      operationId: extractOperationId(record),
      status: extractStatus(record),
      createdAt: extractCreatedAt(record),
      sourceEndpoint: record.sourceEndpoint || "",
      rawRecord: record,
    }))
    .filter((operation) => String(operation.status || "").trim().toUpperCase() === "ACCEPTED")
    .sort((left, right) => {
      const leftTime = Date.parse(left.createdAt || "") || 0;
      const rightTime = Date.parse(right.createdAt || "") || 0;
      if (leftTime !== rightTime) return leftTime - rightTime;
      return String(left.operationId || "").localeCompare(String(right.operationId || ""));
    });

  console.log(`total accepted operations after status filter: ${acceptedOperations.length}`);
  console.log("accepted by minute summary:");
  for (const [minute, count] of summarizeAcceptedByMinute(acceptedOperations)) {
    console.log(`${minute} -> ${count}`);
  }

  const batchWindow = findAcceptedBatchWindow(acceptedOperations, expectedFiles.expectedNames.length);
  if (!batchWindow) {
    await writeJson(LOG_PATH, {
      generatedAt: new Date().toISOString(),
      allOperationsPath: ALL_OPERATIONS_PATH,
      outputDir: OUTPUT_DIR,
      rows: [],
      reason: "batch_window_not_found",
      expectedCount: expectedFiles.expectedNames.length,
      actualAcceptedCount: acceptedOperations.length,
      operations: acceptedOperations.map((operation) => ({
        operationId: operation.operationId,
        createdAt: operation.createdAt,
        status: operation.status,
      })),
    });
    console.log("total operations found: 0");
    console.log("downloaded: 0");
    console.log("skipped existing: 0");
    console.log("failed: 0");
    console.log(`excluded 15 May operations: ${excluded15May}`);
    console.log(`expected accepted operations: ${expectedFiles.expectedNames.length}`);
    console.log(`actual accepted operations: ${acceptedOperations.length}`);
    console.log("createdAt | operationId | status");
    for (const operation of acceptedOperations) {
      console.log(`${operation.createdAt || ""} | ${operation.operationId || ""} | ${operation.status || ""}`);
    }
    console.log(`final folder path: ${OUTPUT_DIR}`);
    process.exitCode = 1;
    return;
  }

  const selectedOperations = batchWindow.window;
  console.log(`selected accepted operations: ${selectedOperations.length}`);
  console.log(`selected createdAt range: ${batchWindow.startCreatedAt} -> ${batchWindow.endCreatedAt}`);

  if (selectedOperations.length !== expectedFiles.expectedNames.length) {
    await writeJson(LOG_PATH, {
      generatedAt: new Date().toISOString(),
      allOperationsPath: ALL_OPERATIONS_PATH,
      outputDir: OUTPUT_DIR,
      rows: [],
      reason: "accepted_count_mismatch",
      expectedCount: expectedFiles.expectedNames.length,
      actualCount: selectedOperations.length,
      operations: selectedOperations.map((operation) => ({
        operationId: operation.operationId,
        createdAt: operation.createdAt,
        status: operation.status,
      })),
    });
    console.log("total operations found: 0");
    console.log("downloaded: 0");
    console.log("skipped existing: 0");
    console.log("failed: 0");
    console.log(`excluded 15 May operations: ${excluded15May}`);
    console.log(`expected accepted operations: ${expectedFiles.expectedNames.length}`);
    console.log(`actual accepted operations: ${selectedOperations.length}`);
    console.log("createdAt | operationId | status");
    for (const operation of selectedOperations) {
      console.log(`${operation.createdAt || ""} | ${operation.operationId || ""} | ${operation.status || ""}`);
    }
    console.log(`final folder path: ${OUTPUT_DIR}`);
    process.exitCode = 1;
    return;
  }

  const finalOperations = selectedOperations.map((operation, index) => ({
    operationId: operation.operationId,
    label: expectedFiles.expectedNames[index],
    status: operation.status,
    createdAt: operation.createdAt,
    sourceEndpoint: operation.sourceEndpoint,
    fileBase: expectedFiles.expectedNames[index],
    detailSourceUrl: "",
    rawRecord: operation.rawRecord,
  }));

  await writeJson(
    ALL_OPERATIONS_PATH,
    finalOperations.map((record) => ({
      operationId: record.operationId,
      label: record.label,
      status: record.status,
      createdAt: record.createdAt,
      sourceEndpoints: record.sourceEndpoints || [],
    }))
  );

  if (!finalOperations.length) {
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
    console.log(`excluded 15 May operations: ${excluded15May}`);
    console.log(`final folder path: ${OUTPUT_DIR}`);
    process.exitCode = 1;
    return;
  }

  const indexed = [];
  const labelCounts = new Map();
  for (const operation of finalOperations) {
    const label = operation.fileBase || operation.label || operation.operationId;
    indexed.push({
      ...operation,
      fileBase: suffixBaseForLabel(label, labelCounts, operation.operationId),
    });
  }

  const plannedFileNames = indexed.map((operation) => `${operation.fileBase}.csv`);
  const tableRows = [];
  const logRows = [];
  let downloaded = 0;
  let skippedExisting = 0;
  let failed = 0;

  await runWithConcurrency(indexed, DOWNLOAD_CONCURRENCY, async (operation) => {
    const result = await downloadCsvWithRetry(operation, authState.headers, operation.fileBase);
    const baseRow = {
      operationId: operation.operationId,
      label: operation.label,
      status: operation.status,
      createdAt: operation.createdAt,
      sourceEndpoints: operation.sourceEndpoints || [],
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
    if (result.status === "skipped_not_ready") {
      skippedExisting += 1;
      tableRows.push({ ...baseRow, filePath: "skipped_not_ready" });
      logRows.push({
        ...baseRow,
        outcome: "skipped_not_ready",
        filePath: "",
        attempts: result.attempts,
        reason: result.reason || "not ready",
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

  const validation = await validateFinalFolder(plannedFileNames);

  console.table(
    tableRows.map((row) => ({
      operationId: row.operationId,
      label: row.label,
      status: row.status,
      createdAt: row.createdAt,
      filePath: row.filePath,
    }))
  );

  console.log(`total operations found: ${finalOperations.length}`);
  console.log(`downloaded: ${downloaded}`);
  console.log(`skipped existing: ${skippedExisting}`);
  console.log(`failed: ${failed}`);
  console.log(`excluded 15 May operations: ${excluded15May}`);
  console.log(`final folder path: ${OUTPUT_DIR}`);
  console.log(`total csv files: ${validation.actualNames.length}`);
  console.log(`duplicate _2 files: ${validation.duplicate2}`);

  if (!validation.ok) {
    console.log("VALIDATION_FAILED");
    console.log(`missing files: ${JSON.stringify(validation.missing, null, 2)}`);
    console.log(`extra files: ${JSON.stringify(validation.extra, null, 2)}`);
    if (validation.actualNames.length > EXPECTED_TOTAL_CSV) {
      console.log("TOO_MANY_FILES");
    }
    process.exitCode = 1;
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
