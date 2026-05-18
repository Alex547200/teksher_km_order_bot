const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const authHelper = require("./teksher-auth.js");

const BASE_URL = "https://label.teksher.kg";
const TARGET_OPERATION_TYPE_CODE = "MARK_CODE_ORDER";
const TARGET_OPERATION_TYPE_TEXT = "Заказ на эмиссию КМ";
const AUTH_TOKENS_PATH = path.join(__dirname, "auth_tokens.json");
const ALL_PATH = path.join(__dirname, "audit_today_all.json");
const DUPLICATES_PATH = path.join(__dirname, "audit_today_duplicates.json");
const SELECTED_PATH = path.join(__dirname, "audit_today_selected.json");
const LOCAL_OUTPUT_DIR = path.join(os.homedir(), "Desktop", "заказ км");
const PAGE_SIZE = 100;
const LOOSEN_FILTERS = true;
let TARGET_DATE = todayLocalDate();
let TARGET_DATE_END = nextDate(TARGET_DATE);
let TARGET_DATE_DOT = `${TARGET_DATE.slice(8, 10)}.${TARGET_DATE.slice(5, 7)}.${TARGET_DATE.slice(0, 4)}`;

const SUCCESS_STATUSES = new Set(["DONE", "READY", "CREATED", "ACCEPTED"]);
const PROGRESS_STATUSES = new Set(["PROGRESS", "IN_PROGRESS", "PROCESSING", "PENDING"]);
const BAD_STATUSES = new Set(["ERROR", "500", "502"]);

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

function nextDate(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function uniq(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeStatus(value) {
  return String(value || "").trim().toUpperCase();
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

function looksLikeOperationId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function findGtin(value) {
  const direct = findFirstField(value, [/^gtin$/i, /^productGtin$/i, /^product_gtin$/i]);
  if (/^\d{8,20}$/.test(direct)) return direct;

  const text = JSON.stringify(value || "");
  const match = text.match(/\b\d{14}\b/);
  return match ? match[0] : "";
}

function hasTargetOperationType(value) {
  const fields = [
    findFirstField(value, [/^operationType$/i, /^operation_type$/i, /^type$/i]),
    findFirstField(value, [/^operationTypeName$/i, /^operationName$/i, /^name$/i]),
    findFirstField(value, [/^title$/i, /^description$/i]),
  ].filter(Boolean);

  const joined = fields.join(" ").toUpperCase();
  const text = JSON.stringify(value || "").toUpperCase();
  return joined.includes(TARGET_OPERATION_TYPE_CODE)
    || joined.includes(TARGET_OPERATION_TYPE_TEXT.toUpperCase())
    || text.includes(TARGET_OPERATION_TYPE_CODE)
    || text.includes(TARGET_OPERATION_TYPE_TEXT.toUpperCase());
}

function datePart(value) {
  const text = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const dot = text.match(/\b(\d{2})\.(\d{2})\.(\d{4})\b/);
  if (dot) return `${dot[3]}-${dot[2]}-${dot[1]}`;
  return "";
}

function isTargetDate(value) {
  const createdAt = findFirstField(value, [/^createdAt$/i, /^created_at$/i, /^created$/i, /^date$/i]);
  return datePart(createdAt) === TARGET_DATE;
}

function normalizeOperation(raw, sourceUrl = "") {
  const operationId = findOwnField(raw, [/^id$/i, /^operationId$/i, /^operationID$/i, /^operation_id$/i])
    || findFirstField(raw, [/^id$/i, /^operationId$/i, /^operationID$/i, /^operation_id$/i]);
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

function hasAnyTargetDate(value) {
  const createdAt = findFirstField(value, [/^createdAt$/i, /^created_at$/i, /^created$/i, /^date$/i]);
  return datePart(createdAt) === TARGET_DATE;
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

function collectOperationIds(value, out = [], seen = new Set()) {
  if (value == null || typeof value !== "object") return out;
  if (seen.has(value)) return out;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectOperationIds(item, out, seen);
    return out;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (/^(id|operationId|operationID|operation_id)$/i.test(key) && looksLikeOperationId(nested)) {
      out.push(String(nested));
    }
    if (looksLikeOperationId(key) && /^\d{8,20}$/.test(String(nested || ""))) {
      out.push(String(key));
    }
    collectOperationIds(nested, out, seen);
  }

  return out;
}

function isUsable(operation) {
  const status = normalizeStatus(operation.status);
  return !BAD_STATUSES.has(status) && status !== "";
}

function operationRank(operation) {
  const status = normalizeStatus(operation.status);
  if (BAD_STATUSES.has(status)) return -1;
  if (SUCCESS_STATUSES.has(status)) return 3;
  if (PROGRESS_STATUSES.has(status)) return 1;
  return 2;
}

function createdAtTime(operation) {
  const text = String(operation.createdAt || "");
  const normalized = /^\d{4}-\d{2}-\d{2}T/.test(text) ? text : text.replace(" ", "T");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareOperations(a, b) {
  const rankDiff = operationRank(a) - operationRank(b);
  if (rankDiff !== 0) return rankDiff;
  return createdAtTime(a) - createdAtTime(b);
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function normalizeToken(token) {
  return String(token || "").trim().replace(/^Bearer\s+/i, "").trim();
}

async function resolveAuthFromFiles() {
  const candidates = await authHelper.readAuthCandidatesFromFiles([
    { path: AUTH_TOKENS_PATH, source: "auth_tokens.json" },
  ]);
  const accessCandidate = authHelper.chooseAccessToken(candidates);
  const refreshCandidate = authHelper.chooseRefreshToken(candidates);
  let accessToken = normalizeToken(accessCandidate?.token || "");
  let refreshToken = normalizeToken(refreshCandidate?.token || "");
  const accessExpMs = accessToken ? authHelper.decodeJwtExpMs(accessToken) : 0;
  const isExpired = !accessToken || !accessExpMs || accessExpMs <= Date.now() + 60_000;

  if (isExpired && refreshToken) {
    try {
      const refreshed = await authHelper.refreshAuthToken(refreshToken, {
        authTokensPath: AUTH_TOKENS_PATH,
        source: "audit-today",
      });
      accessToken = normalizeToken(refreshed.accessToken || "");
      refreshToken = normalizeToken(refreshed.refreshToken || refreshToken);
    } catch (error) {
      throw new Error(`TOKEN_EXPIRED: run npm run manual-token (${error.message || error})`);
    }
  }

  const finalExpMs = accessToken ? authHelper.decodeJwtExpMs(accessToken) : 0;
  if (!accessToken) {
    throw new Error("TOKEN_MISSING: run npm run manual-token");
  }
  if (!finalExpMs || finalExpMs <= Date.now() + 60_000) {
    throw new Error("TOKEN_EXPIRED: run npm run manual-token");
  }

  return {
    accessToken,
    refreshToken,
    authHeaders: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    tokenExpiresAt: new Date(finalExpMs).toISOString(),
    hasAccessToken: true,
    isExpired: false,
  };
}

function buildListUrls() {
  const bases = [
    "/facade/api/v1/operations/filter",
    "/facade/api/v1/operations",
    "/facade/order/api/v1/operations",
  ];
  const pagingPairs = LOOSEN_FILTERS
    ? [
        { page: "0", size: String(PAGE_SIZE) },
        { page: "1", size: String(PAGE_SIZE) },
      ]
    : [
        { page: "0", size: String(PAGE_SIZE) },
        { pageNumber: "0", pageSize: String(PAGE_SIZE) },
        { page: "1", limit: String(PAGE_SIZE) },
      ];
  const urls = [];

  for (const base of bases) {
    for (const paging of pagingPairs) {
      const params = new URLSearchParams({ ...paging });
      if (base.endsWith("/filter")) {
        params.set("startDate", TARGET_DATE);
        params.set("endDate", TARGET_DATE_END);
      }
      urls.push(`${BASE_URL}${base}?${params.toString()}`);
    }
  }

  return uniq(urls);
}

async function fetchJsonGet(url, authHeaders) {
  const response = await fetch(url, {
    method: "GET",
    headers: authHeaders,
  });

  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {}

  return {
    url,
    finalUrl: response.url || url,
    httpStatus: response.status,
    ok: response.ok,
    statusText: response.statusText,
    body,
    rawText: text,
  };
}

function responseLooksUnauthorized(response) {
  if (!response) return false;
  if (response.httpStatus === 401 || response.httpStatus === 403) return true;
  const bodyText = typeof response.body === "string" ? response.body : JSON.stringify(response.body || "");
  return /unauthoriz|forbidden|token expired|invalid token/i.test(bodyText);
}

async function collectListResponses(authHeaders) {
  const responses = [];
  const errors = [];
  for (const url of buildListUrls()) {
    try {
      const response = await fetchJsonGet(url, authHeaders);
      responses.push(response);
      const found = collectOperationObjects(response.body);
      console.log(`REQUEST_URL ${url}`);
      console.log(`FINAL_URL ${response.finalUrl}`);
      console.log(`HTTP_STATUS ${response.httpStatus}`);
      console.log(`RESPONSE_COUNT ${found.length}`);
      console.log(`RAW_RESPONSE ${String(response.rawText || "").slice(0, 500).replace(/\s+/g, " ").trim()}`);
      if (typeof response.body === "string") {
        console.log(`RESPONSE_TEXT ${response.body.slice(0, 500).replace(/\s+/g, " ").trim()}`);
      } else {
        console.log(`RESPONSE_KEYS ${Array.isArray(response.body) ? `array(${response.body.length})` : Object.keys(response.body || {}).join(",")}`);
      }
      if (response.ok && found.length) {
        console.log(`GET list candidate returned operation-like data: ${url}`);
      }
    } catch (error) {
      const cause = error && error.cause ? `${error.cause.code || ""} ${error.cause.hostname || ""}`.trim() : "";
      console.log(`FETCH_ERROR ${url}`);
      console.log(`FETCH_ERROR_NAME ${error.name || "Error"}`);
      console.log(`FETCH_ERROR_MESSAGE ${error.message || error}`);
      if (cause) console.log(`FETCH_ERROR_CAUSE ${cause}`);
      responses.push({ url, httpStatus: 0, ok: false, statusText: error.message, body: null });
      errors.push({ url, error: error.message || String(error), cause });
    }
  }
  if (responses.length > 0 && responses.every((item) => item.httpStatus === 0)) {
    console.log("NETWORK_ERROR_RETRY_WITH_VPN");
    console.log(JSON.stringify(errors.slice(0, 3), null, 2));
  }
  return responses;
}

async function fetchDetailsForIds(ids, authHeaders) {
  const details = [];
  for (const operationId of ids) {
    const url = `${BASE_URL}/facade/api/v1/operations/${encodeURIComponent(operationId)}`;
    try {
      const response = await fetchJsonGet(url, authHeaders);
      details.push(response);
    } catch (error) {
      details.push({ url, httpStatus: 0, ok: false, statusText: error.message, body: null });
    }
  }
  return details;
}

function extractTargetOperations(responses) {
  const rowsById = new Map();
  const ids = [];

  for (const response of responses) {
    const objects = collectOperationObjects(response.body);
    console.log(`RAW_RESPONSE_COUNT ${response.url} ${objects.length}`);
    ids.push(...collectOperationIds(response.body));

    for (const object of objects) {
      if (!hasAnyTargetDate(object)) continue;
      if (!LOOSEN_FILTERS && !hasTargetOperationType(object)) continue;
      const row = normalizeOperation(object, response.url);
      if (!row) continue;
      const existing = rowsById.get(row.operationId);
      if (!existing || JSON.stringify(row).length > JSON.stringify(existing).length) {
        rowsById.set(row.operationId, row);
      }
    }
  }

  return {
    rows: Array.from(rowsById.values()).sort((a, b) => createdAtTime(a) - createdAtTime(b)),
    ids: uniq(ids),
  };
}

function buildDuplicates(rows) {
  const byGtin = new Map();
  for (const row of rows) {
    if (!byGtin.has(row.gtin)) byGtin.set(row.gtin, []);
    byGtin.get(row.gtin).push(row);
  }

  const duplicates = {};
  for (const [gtin, operations] of byGtin.entries()) {
    if (operations.length > 1) {
      duplicates[gtin] = operations.sort((a, b) => createdAtTime(b) - createdAtTime(a));
    }
  }
  return duplicates;
}

function selectBestByGtin(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.gtin)) grouped.set(row.gtin, []);
    grouped.get(row.gtin).push(row);
  }

  const selected = [];
  const rejected = [];

  for (const [gtin, operations] of grouped.entries()) {
    const usable = operations.filter(isUsable);
    usable.sort(compareOperations);
    const best = usable.pop() || null;

    if (best) selected.push(best);

    for (const operation of operations) {
      if (!best || operation.operationId !== best.operationId) {
        rejected.push({
          ...operation,
          reason: isUsable(operation) ? `not selected for GTIN ${gtin}` : `ignored status ${operation.status || "EMPTY"}`,
        });
      }
    }
  }

  return {
    selected: selected.sort((a, b) => a.gtin.localeCompare(b.gtin)),
    rejected: rejected.sort((a, b) => a.gtin.localeCompare(b.gtin) || createdAtTime(b) - createdAtTime(a)),
  };
}

async function main() {
  await ensureDir(LOCAL_OUTPUT_DIR);

  TARGET_DATE = todayLocalDate();
  TARGET_DATE_END = nextDate(TARGET_DATE);
  TARGET_DATE_DOT = `${TARGET_DATE.slice(8, 10)}.${TARGET_DATE.slice(5, 7)}.${TARGET_DATE.slice(0, 4)}`;

  const auth = await resolveAuthFromFiles();
  console.log(`AUTH_TOKEN_EXPIRES_AT ${auth.tokenExpiresAt}`);

  const listResponses = await collectListResponses(auth.authHeaders);
  let { rows, ids } = extractTargetOperations(listResponses);

  if (ids.length) {
    const detailResponses = await fetchDetailsForIds(ids, auth.authHeaders);
    rows = extractTargetOperations(listResponses.concat(detailResponses)).rows;
  }

  const duplicates = buildDuplicates(rows);
  const { selected, rejected } = selectBestByGtin(rows);

  await writeJson(ALL_PATH, {
    targetDate: TARGET_DATE_DOT,
    targetOperationType: TARGET_OPERATION_TYPE_TEXT,
    checkedAt: new Date().toISOString(),
    onlyGetRequests: true,
    authSource: "auth_tokens.json",
    transport: "fetch",
    operations: rows,
  });
  await writeJson(DUPLICATES_PATH, {
    targetDate: TARGET_DATE_DOT,
    duplicateGtins: Object.keys(duplicates),
    duplicates,
  });
  await writeJson(SELECTED_PATH, {
    targetDate: TARGET_DATE_DOT,
    selected,
    rejected,
  });

  console.log("\nAudit files saved:");
  console.log(ALL_PATH);
  console.log(DUPLICATES_PATH);
  console.log(SELECTED_PATH);

  console.log("\nSummary:");
  console.log(`request payload: ${JSON.stringify({ startDate: TARGET_DATE, endDate: TARGET_DATE_END, size: PAGE_SIZE, page: 0 })}`);
  console.log(`Всего операций: ${rows.length}`);
  console.log(`Уникальных GTIN: ${new Set(rows.map((row) => row.gtin)).size}`);
  console.log(`Задвоились GTIN: ${Object.keys(duplicates).length ? Object.keys(duplicates).join(", ") : "нет"}`);
  console.log(`Можно использовать: ${selected.map((row) => `${row.gtin}:${row.operationId}:${row.status}`).join(", ") || "нет"}`);
  console.log(`Нельзя использовать: ${rejected.map((row) => `${row.gtin}:${row.operationId}:${row.status}:${row.reason}`).join(", ") || "нет"}`);
  console.log(`first operationIds: ${rows.slice(0, 10).map((row) => row.operationId).join(", ") || "нет"}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
