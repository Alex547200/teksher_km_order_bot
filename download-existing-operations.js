const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const authHelper = require("./teksher-auth");

const PROJECT_DIR = __dirname;
const SOURCE_DIR = path.join(os.homedir(), "Desktop", "заказ км");
const OUTPUT_DIR = path.join(os.homedir(), "Desktop", "123 электросталь");
const AUTH_TOKENS_PATH = path.join(PROJECT_DIR, "auth_tokens.json");
const BASE_URL = "https://label.teksher.kg";
const STATUS_ENDPOINT = "/facade/api/v1/operations/{operationId}";
const CSV_ENDPOINT = "/facade/api/v1/marking_codes/csv?operationId={operationId}";
const REQUEST_TIMEOUT = 45000;
const POLL_DELAY_MS = 5000;
const POLL_RETRIES = 3;
const READY_STATUSES = new Set(["COMPLETED", "DONE", "READY", "ACCEPTED", "SUCCESS", "ВЫПОЛНЕНА"]);
const BAD_STATUSES = new Set(["ERROR", "500", "502"]);
const SOURCE_FILES = [
  "api_status_check.json",
  "new_api_status_check.json",
  "next_api_status_check.json",
  "batch_status_2026-05-15T14-56-18-677Z.json",
  "batch_status_2026-05-15T15-01-46-319Z.json",
  "batch_001_status_2026-05-15T15-10-57-020Z.json",
  "batch_003_status_2026-05-15T15-10-57-020Z.json",
  "batch_004_status_2026-05-15T15-10-57-020Z.json",
  "batch_005_status_2026-05-15T15-10-57-020Z.json",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeToken(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "").trim();
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

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

async function readJsonIfExists(filePath, fallback = null) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

function extractArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.operations)) return payload.operations;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.all)) return payload.all;
  if (Array.isArray(payload?.selected)) return payload.selected;
  return [];
}

function extractGtin(row) {
  return String(
    row?.gtin ||
      row?.productGtin ||
      row?.product_gtin ||
      row?.product?.gtin ||
      row?.product?.code ||
      ""
  ).trim();
}

function extractOperationId(row) {
  return String(row?.operationId || row?.operationID || row?.operation_id || row?.id || "").trim();
}

function extractStatus(row) {
  return normalizeStatus(row?.status || row?.state || row?.operationStatus || row?.currentStatus || "");
}

function collectCandidatesFromStatusFile(payload, sourceFile) {
  return extractArray(payload)
    .map((row) => ({
      gtin: extractGtin(row),
      operationId: extractOperationId(row),
      status: extractStatus(row),
      sourceFile,
    }))
    .filter((row) => row.gtin && row.operationId);
}

async function collectOperationCandidates() {
  const candidates = [];
  for (const fileName of SOURCE_FILES) {
    const filePath = path.join(SOURCE_DIR, fileName);
    const payload = await readJsonIfExists(filePath, null);
    if (!payload) continue;
    candidates.push(...collectCandidatesFromStatusFile(payload, fileName));
  }
  const byOperationId = new Map();
  for (const row of candidates) {
    if (!byOperationId.has(row.operationId)) {
      byOperationId.set(row.operationId, row);
    }
  }
  return Array.from(byOperationId.values());
}

async function loadAuthHeaders() {
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
      source: "download-existing-ops",
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

async function fetchJson(url, headers) {
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
    status: response.status,
    ok: response.ok,
    text,
    json,
    headers: Object.fromEntries(response.headers.entries()),
  };
}

function parseOperationStatus(body, httpStatus) {
  const raw = body && typeof body === "object" ? body : {};
  const status = normalizeStatus(raw.status || raw.state || raw.operationStatus || raw.currentStatus || httpStatus);
  const createdAt = String(raw.createdAt || raw.createdDate || raw.created || "").trim();
  const message = String(raw.message || raw.description || raw.detail || raw.error || "").trim();
  return { status, createdAt, message };
}

async function pollOperationStatus(operationId, headers) {
  const url = `${BASE_URL}${STATUS_ENDPOINT.replace("{operationId}", encodeURIComponent(operationId))}`;
  let last = null;
  for (let attempt = 1; attempt <= POLL_RETRIES; attempt += 1) {
    console.log(`STATUS URL: ${url}`);
    const response = await fetchJson(url, headers);
    last = response;
    const parsed = parseOperationStatus(response.json, response.status);
    const hasBody = response.text && response.text.trim().length > 0;
    console.log(`status ${attempt}/${POLL_RETRIES}: ${operationId} -> ${parsed.status || response.status}`);

    if (response.ok && READY_STATUSES.has(parsed.status)) {
      return {
        operationId,
        httpStatus: response.status,
        status: parsed.status,
        createdAt: parsed.createdAt,
        message: parsed.message,
        ready: true,
      };
    }

    if (
      response.status === 404 ||
      response.status === 409 ||
      BAD_STATUSES.has(parsed.status) ||
      (!hasBody && !parsed.status)
    ) {
      return {
        operationId,
        httpStatus: response.status,
        status: parsed.status || String(response.status),
        createdAt: parsed.createdAt,
        message: parsed.message || "not ready",
        ready: false,
        skipReason: "not ready",
      };
    }

    if (attempt < POLL_RETRIES) {
      await sleep(POLL_DELAY_MS);
    }
  }

  const parsed = parseOperationStatus(last?.json, last?.status || 0);
  return {
    operationId,
    httpStatus: last?.status || 0,
    status: parsed.status || "TIMEOUT",
    createdAt: parsed.createdAt,
    message: parsed.message || "Polling timed out",
    ready: false,
    skipReason: "not ready",
  };
}

async function downloadCsv(operationId, headers, outputDir, fileBase) {
  const targetPath = path.join(outputDir, `${fileBase}.csv`);
  if (await fileExists(targetPath)) {
    return { status: "skipped_existing", filePath: targetPath, fileBase };
  }

  const url = `${BASE_URL}${CSV_ENDPOINT.replace("{operationId}", encodeURIComponent(operationId))}`;
  console.log(`CSV URL: ${url}`);
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers,
  });
  const contentType = response.headers.get("content-type") || "";
  const buffer = Buffer.from(await response.arrayBuffer());

  if (response.status === 404 || response.status === 409 || !buffer.length) {
    return {
      status: "skipped_not_ready",
      reason: "not ready",
      filePath: "",
      fileBase,
      httpStatus: response.status,
      contentType,
    };
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}: ${buffer.toString("utf8").slice(0, 500)}`);
  }

  await fs.writeFile(targetPath, buffer);
  return { status: "downloaded", filePath: targetPath, fileBase, httpStatus: response.status, contentType };
}

function nextFileBase(gtin, operationId, gtinCounts) {
  const key = String(gtin || operationId || "").trim();
  const count = (gtinCounts.get(key) || 0) + 1;
  gtinCounts.set(key, count);
  const baseName = sanitizeFilePart(gtin || operationId || "operation");
  return count === 1 ? baseName : `${baseName}_${count}`;
}

async function main() {
  await ensureDir(OUTPUT_DIR);

  const source = await collectOperationCandidates();
  const uniqueByOperation = new Map();
  for (const row of source) {
    if (!uniqueByOperation.has(row.operationId)) {
      uniqueByOperation.set(row.operationId, row);
    }
  }
  const candidates = Array.from(uniqueByOperation.values());
  const authState = await loadAuthHeaders();

  console.log(`candidate operations: ${candidates.length}`);
  console.log(`save path: ${OUTPUT_DIR}`);
  console.log("AUTH_DIAGNOSTICS");
  console.log(`access token exists: ${authState.accessToken ? "yes" : "no"}`);
  console.log(`token exp: ${new Date(authState.tokenExpiresAtMs).toISOString()}`);
  console.log(`current time: ${new Date().toISOString()}`);

  const results = [];
  const gtinCounts = new Map();
  let downloadedCsv = 0;
  let downloadedPdf = 0;
  let skipped = 0;
  let failed = 0;

  for (const record of candidates) {
    try {
      const current = await pollOperationStatus(record.operationId, authState.headers);
      if (!current.ready) {
        skipped += 1;
        results.push({
          gtin: record.gtin,
          operationId: record.operationId,
          status: current.status,
          csv: "skipped_not_ready",
          pdf: "api_only",
        });
        continue;
      }

      const fileBase = nextFileBase(record.gtin, record.operationId, gtinCounts);
      const csvResult = await downloadCsv(record.operationId, authState.headers, OUTPUT_DIR, fileBase);
      if (csvResult.status === "downloaded") downloadedCsv += 1;
      else if (csvResult.status === "skipped_existing") skipped += 1;
      else if (csvResult.status === "skipped_not_ready") skipped += 1;

      results.push({
        gtin: record.gtin,
        operationId: record.operationId,
        status: current.status,
        csv: csvResult.filePath || csvResult.status,
        pdf: "api_only",
      });
    } catch (error) {
      failed += 1;
      results.push({
        gtin: record.gtin,
        operationId: record.operationId,
        status: record.status,
        csv: "",
        pdf: `ERROR: ${error.message || String(error)}`,
      });
      console.error("OPERATION_ERROR");
      console.error(`operationId: ${record.operationId}`);
      console.error(`error.name: ${error?.name || "n/a"}`);
      console.error(`error.message: ${error?.message || "n/a"}`);
      console.error(`error.stack: ${error?.stack || "n/a"}`);
      console.error(`error.cause: ${safeJsonStringify(error?.cause)}`);
    }
  }

  await writeJson(path.join(PROJECT_DIR, "download_existing_2026_05_15_log.json"), {
    generatedAt: new Date().toISOString(),
    outputDir: OUTPUT_DIR,
    rows: results,
  });

  console.table(
    results.map((row) => ({
      GTIN: row.gtin,
      operationId: row.operationId,
      status: row.status,
      csv: row.csv,
      pdf: row.pdf,
    }))
  );
  console.log(`total operations: ${candidates.length}`);
  console.log(`downloaded csv: ${downloadedCsv}`);
  console.log(`downloaded pdf: ${downloadedPdf}`);
  console.log(`skipped: ${skipped}`);
  console.log(`failed: ${failed}`);
  console.log(`outputDir: ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error("FATAL_ERROR");
  console.error(`error.name: ${error?.name || "n/a"}`);
  console.error(`error.message: ${error?.message || "n/a"}`);
  console.error(`error.stack: ${error?.stack || "n/a"}`);
  console.error(`error.cause: ${safeJsonStringify(error?.cause)}`);
  process.exitCode = 1;
});
