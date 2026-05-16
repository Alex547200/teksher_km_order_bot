const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const authHelper = require("./teksher-auth");

const PROJECT_DIR = __dirname;
const SOURCE_PATH = path.join(PROJECT_DIR, "audit_local_all.json");
const OUTPUT_DIR = path.join(os.homedir(), "Desktop", "электросталь печать кодов паркеровки");
const RESULT_PATH = path.join(PROJECT_DIR, "missing_range_04707197100105_04707197100945.json");
const AUTH_TOKENS_PATH = path.join(PROJECT_DIR, "auth_tokens.json");
const BASE_URL = "https://label.teksher.kg";
const CSV_ENDPOINT = "/facade/api/v1/marking_codes/csv?operationId={operationId}";
const REQUEST_TIMEOUT = 45000;
const DOWNLOAD_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

const RANGE_START = "04707197100105";
const RANGE_END = "04707197100945";
const RANGE_WIDTH = RANGE_START.length;

const ERROR_STATUSES = new Set(["ERROR", "500", "502"]);
const SUCCESS_STATUS_RANK = new Map([
  ["DONE", 0],
  ["READY", 1],
  ["CREATED", 2],
  ["PROGRESS", 3],
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function extractRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.all)) return payload.all;
  if (Array.isArray(payload?.selected)) return payload.selected;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.operations)) return payload.operations;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function extractGtin(row) {
  return String(
    row?.gtin ||
      row?.productGtin ||
      row?.product_gtin ||
      row?.productGTIN ||
      row?.product?.gtin ||
      ""
  ).trim();
}

function extractOperationId(row) {
  return String(row?.operationId || row?.operationID || row?.operation_id || row?.id || "").trim();
}

function extractSourceFile(row) {
  return String(row?.sourceFile || row?.source_file || "").trim();
}

function extractTimestampMs(row) {
  const raw = row?.timestampMs ?? row?.timestamp ?? row?.createdAtMs ?? row?.created_at_ms ?? "";
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

function statusRank(status) {
  const normalized = normalizeStatus(status);
  if (SUCCESS_STATUS_RANK.has(normalized)) return SUCCESS_STATUS_RANK.get(normalized);
  if (!normalized) return 6;
  if (ERROR_STATUSES.has(normalized)) return 9;
  return 5;
}

function compareCandidate(a, b) {
  const rankDiff = statusRank(a.status) - statusRank(b.status);
  if (rankDiff !== 0) return rankDiff;
  const timeDiff = (extractTimestampMs(b) || 0) - (extractTimestampMs(a) || 0);
  if (timeDiff !== 0) return timeDiff;
  return String(a.operationId || "").localeCompare(String(b.operationId || ""));
}

function rangeToGtins(start, end) {
  const startBig = BigInt(start);
  const endBig = BigInt(end);
  if (endBig < startBig) {
    throw new Error(`Invalid range: ${start} > ${end}`);
  }
  const out = [];
  for (let current = startBig; current <= endBig; current += 1n) {
    out.push(current.toString().padStart(RANGE_WIDTH, "0"));
  }
  return out;
}

function buildCsvUrl(operationId) {
  return `${BASE_URL}${CSV_ENDPOINT.replace("{operationId}", encodeURIComponent(operationId))}`;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function readText(filePath) {
  return fs.readFile(filePath, "utf8");
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function hasDownloadedCsv(gtin, fileNames) {
  const candidates = [
    `${gtin}.csv`,
    `${gtin}_2.csv`,
    `${gtin}_3.csv`,
  ];
  if (candidates.some((name) => fileNames.has(name))) return true;
  const pattern = new RegExp(`^${gtin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:_\\d+)?\\.csv$`, "i");
  return Array.from(fileNames).some((name) => pattern.test(name));
}

function groupByGtin(records) {
  const map = new Map();
  for (const row of records) {
    const gtin = extractGtin(row);
    if (!gtin) continue;
    const item = {
      gtin,
      operationId: extractOperationId(row),
      status: normalizeStatus(row?.status),
      sourceFile: extractSourceFile(row),
      timestampMs: extractTimestampMs(row),
    };
    if (!map.has(gtin)) map.set(gtin, []);
    map.get(gtin).push(item);
  }
  for (const list of map.values()) {
    list.sort(compareCandidate);
  }
  return map;
}

async function loadAuthHeaders() {
  const candidates = await authHelper.readAuthCandidatesFromFiles([
    { path: AUTH_TOKENS_PATH, source: "auth_tokens.json" },
  ]);
  const accessCandidate = authHelper.chooseAccessToken(candidates);
  const refreshCandidate = authHelper.chooseRefreshToken(candidates);

  let accessToken = authHelper.normalizeToken(accessCandidate?.token || "");
  let refreshToken = authHelper.normalizeToken(refreshCandidate?.token || "");
  let accessExpMs = authHelper.decodeJwtExpMs(accessToken);
  const nowMs = Date.now();
  const isExpired = !accessToken || !accessExpMs || accessExpMs <= nowMs + 60_000;
  let refreshed = false;

  if (isExpired && refreshToken) {
    const refreshedAuth = await authHelper.refreshAuthToken(refreshToken, {
      authTokensPath: AUTH_TOKENS_PATH,
      source: "find-missing-range",
    });
    accessToken = authHelper.normalizeToken(refreshedAuth.accessToken || "");
    refreshToken = authHelper.normalizeToken(refreshedAuth.refreshToken || refreshToken);
    accessExpMs = authHelper.decodeJwtExpMs(accessToken);
    refreshed = true;
    console.log("ACCESS_TOKEN_REFRESHED");
    console.log(`NEW_EXP ${accessExpMs ? new Date(accessExpMs).toISOString() : "n/a"}`);
  }

  if (!accessToken) {
    throw new Error("TOKEN_MISSING: auth_tokens.json access_token not found");
  }
  if (!accessExpMs || accessExpMs <= Date.now()) {
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
    accessExpMs,
    refreshed,
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

async function downloadCsv(operationId, headers, targetPath) {
  const url = buildCsvUrl(operationId);
  let currentHeaders = headers;
  let refreshedOnce = false;
  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt += 1) {
    try {
      console.log(`DOWNLOAD URL: ${url}`);
      const response = await fetchWithTimeout(url, {
        method: "GET",
        headers: currentHeaders,
      });
      const contentType = response.headers.get("content-type") || "";
      const contentDisposition = response.headers.get("content-disposition") || "";
      const buffer = Buffer.from(await response.arrayBuffer());

      if (response.status === 401) {
        if (!refreshedOnce) {
          const refreshedAuth = await loadAuthHeaders();
          currentHeaders = refreshedAuth.headers;
          refreshedOnce = true;
        }
        throw new Error(`HTTP 401 for ${url}`);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}: ${buffer.toString("utf8").slice(0, 300)}`);
      }
      if (!buffer.length) {
        throw new Error(`Empty body for ${url}`);
      }

      if (await fileExists(targetPath)) {
        return {
          status: "skipped_existing",
          targetPath,
          contentType,
          contentDisposition,
        };
      }

      await fs.writeFile(targetPath, buffer);
      return {
        status: "downloaded",
        targetPath,
        contentType,
        contentDisposition,
      };
    } catch (error) {
      console.error("DOWNLOAD_ERROR");
      console.error(`operationId: ${operationId}`);
      console.error(`attempt: ${attempt}/${DOWNLOAD_RETRIES}`);
      console.error(`error.name: ${error?.name || "n/a"}`);
      console.error(`error.message: ${error?.message || "n/a"}`);
      console.error(`error.stack: ${error?.stack || "n/a"}`);
      console.error(`error.cause: ${JSON.stringify(error?.cause, null, 2)}`);
      if (attempt < DOWNLOAD_RETRIES) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  return {
    status: "failed",
    targetPath: "",
  };
}

async function main() {
  await ensureDir(OUTPUT_DIR);
  const authState = await loadAuthHeaders();

  const sourceText = await readText(SOURCE_PATH);
  let payload = null;
  try {
    payload = JSON.parse(sourceText);
  } catch {
    payload = null;
  }

  const records = extractRecords(payload);
  const byGtin = groupByGtin(records);
  const gtinsInRange = rangeToGtins(RANGE_START, RANGE_END);
  const dirEntries = await fs.readdir(OUTPUT_DIR, { withFileTypes: true });
  const csvFileNames = new Set(
    dirEntries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"))
      .map((entry) => entry.name)
  );

  const missing = [];
  const missingWithoutOperationId = [];
  const downloaded = [];
  const existing = [];

  for (const gtin of gtinsInRange) {
    const hasCsv = hasDownloadedCsv(gtin, csvFileNames);
    const candidates = (byGtin.get(gtin) || []).filter((row) => row.operationId);
    const candidateOperationIds = Array.from(new Set(candidates.map((row) => row.operationId)));

    if (hasCsv) {
      existing.push({
        gtin,
        operationIds: candidateOperationIds,
      });
      continue;
    }

    const chosen = candidates[0] || null;
    const entry = {
      gtin,
      operationIds: candidateOperationIds,
      chosenOperationId: chosen?.operationId || "",
      status: chosen?.status || "",
      sourceFile: chosen?.sourceFile || "",
      timestampMs: chosen?.timestampMs || 0,
    };

    if (!chosen?.operationId) {
      missingWithoutOperationId.push(entry);
      missing.push(entry);
      continue;
    }

    const targetPath = path.join(OUTPUT_DIR, `${sanitizeFilePart(gtin)}.csv`);
    const result = await downloadCsv(chosen.operationId, authState.headers, targetPath).catch((error) => ({
      status: "failed",
      targetPath: "",
      error,
    }));
    entry.downloadStatus = result.status;
    entry.downloadedFile = result.targetPath || "";
    if (result.status === "downloaded" || result.status === "skipped_existing") {
      downloaded.push(entry);
      csvFileNames.add(path.basename(result.targetPath));
    } else {
      missing.push(entry);
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    rangeStart: RANGE_START,
    rangeEnd: RANGE_END,
    totalInRange: gtinsInRange.length,
    totalAuditRecords: records.length,
    totalCsvFiles: Array.from(csvFileNames).length,
    missing,
    missingWithoutOperationId,
    downloaded,
    existing,
  };

  await writeJson(RESULT_PATH, result);

  console.log(`total in range: ${gtinsInRange.length}`);
  console.log(`total audit records: ${records.length}`);
  console.log(`total csv files: ${csvFileNames.size}`);
  console.log(`missing gtin count: ${missing.length}`);
  console.log(`missing without operationId: ${missingWithoutOperationId.length}`);
  console.table(missing.map((row) => ({
    gtin: row.gtin,
    operationId: row.chosenOperationId || row.operationIds.join(", "),
    status: row.status,
    sourceFile: row.sourceFile,
    downloadStatus: row.downloadStatus || "missing",
  })));

  if (missingWithoutOperationId.length) {
    console.log("missing_without_operationId");
    console.table(missingWithoutOperationId.map((row) => ({
      gtin: row.gtin,
      status: row.status,
      sourceFile: row.sourceFile,
    })));
  }

  if (downloaded.length) {
    console.log("downloaded missing CSV:");
    console.table(downloaded.map((row) => ({
      gtin: row.gtin,
      operationId: row.chosenOperationId,
      filePath: row.downloadedFile,
      status: row.downloadStatus,
    })));
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
