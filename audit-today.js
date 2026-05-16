const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const BASE_URL = "https://label.teksher.kg";
const OPERATIONS_URL = `${BASE_URL}/operations`;
const PROFILE_DIR = path.join(__dirname, "teksher-session-profile");
const TARGET_DATE = "2026-05-15";
const TARGET_DATE_DOT = "15.05.2026";
const TARGET_OPERATION_TYPE_CODE = "MARK_CODE_ORDER";
const TARGET_OPERATION_TYPE_TEXT = "Заказ на эмиссию КМ";
const ALL_PATH = path.join(__dirname, "audit_today_all.json");
const DUPLICATES_PATH = path.join(__dirname, "audit_today_duplicates.json");
const SELECTED_PATH = path.join(__dirname, "audit_today_selected.json");
const LOCAL_OUTPUT_DIR = path.join(os.homedir(), "Desktop", "заказ км");
const PAGE_SIZE = 100;

const SUCCESS_STATUSES = new Set(["DONE", "READY", "CREATED", "ACCEPTED"]);
const PROGRESS_STATUSES = new Set(["PROGRESS", "IN_PROGRESS", "PROCESSING", "PENDING"]);
const BAD_STATUSES = new Set(["ERROR", "500", "502"]);

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

function buildListUrls() {
  const bases = [
    "/facade/api/v1/operations",
    "/facade/order/api/v1/operations",
  ];
  const datePairs = [
    { createdAtFrom: `${TARGET_DATE}T00:00:00`, createdAtTo: `${TARGET_DATE}T23:59:59` },
    { createdFrom: `${TARGET_DATE}T00:00:00`, createdTo: `${TARGET_DATE}T23:59:59` },
    { dateFrom: TARGET_DATE, dateTo: TARGET_DATE },
    { from: TARGET_DATE_DOT, to: TARGET_DATE_DOT },
  ];
  const typePairs = [
    { operationType: TARGET_OPERATION_TYPE_CODE },
    { type: TARGET_OPERATION_TYPE_CODE },
    { operationType: TARGET_OPERATION_TYPE_TEXT },
  ];
  const pagingPairs = [
    { page: "0", size: String(PAGE_SIZE) },
    { pageNumber: "0", pageSize: String(PAGE_SIZE) },
    { page: "1", limit: String(PAGE_SIZE) },
  ];
  const urls = [];

  for (const base of bases) {
    for (const dates of datePairs) {
      for (const type of typePairs) {
        for (const paging of pagingPairs) {
          const params = new URLSearchParams({ ...dates, ...type, ...paging });
          urls.push(`${BASE_URL}${base}?${params.toString()}`);
        }
      }
    }
  }

  return uniq(urls);
}

async function fetchJsonGet(page, url) {
  return page.evaluate(async ({ requestUrl }) => {
    const response = await fetch(requestUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      credentials: "include",
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
      body,
    };
  }, { requestUrl: url });
}

function responseLooksUnauthorized(response) {
  if (!response) return false;
  if (response.httpStatus === 401 || response.httpStatus === 403) return true;
  const bodyText = typeof response.body === "string" ? response.body : JSON.stringify(response.body || "");
  return /unauthoriz|forbidden|token expired|invalid token/i.test(bodyText);
}

async function collectListResponses(page) {
  const responses = [];
  for (const url of buildListUrls()) {
    try {
      const response = await fetchJsonGet(page, url);
      responses.push(response);
      const found = collectOperationObjects(response.body);
      if (response.ok && found.length) {
        console.log(`GET list candidate returned operation-like data: ${url}`);
      }
    } catch (error) {
      responses.push({ url, httpStatus: 0, ok: false, statusText: error.message, body: null });
    }
  }
  return responses;
}

async function fetchDetailsForIds(page, ids) {
  const details = [];
  for (const operationId of ids) {
    const url = `${BASE_URL}/facade/api/v1/operations/${encodeURIComponent(operationId)}`;
    try {
      const response = await fetchJsonGet(page, url);
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
    ids.push(...collectOperationIds(response.body));

    for (const object of objects) {
      if (!hasTargetOperationType(object) || !isTargetDate(object)) continue;
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
  await ensureDir(PROFILE_DIR);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    acceptDownloads: false,
    viewport: { width: 1440, height: 1200 },
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

    const currentUrl = page.url();
    const isLogin = currentUrl.includes("/login")
      || await page.locator("input[type='password']").first().isVisible().catch(() => false);

    if (isLogin) {
      console.error("LOGIN_REQUIRED");
      process.exitCode = 1;
      return;
    }

    const listResponses = await collectListResponses(page);
    let { rows, ids } = extractTargetOperations(listResponses);

    if (ids.length) {
      const detailResponses = await fetchDetailsForIds(page, ids);
      rows = extractTargetOperations(listResponses.concat(detailResponses)).rows;
    }

    const duplicates = buildDuplicates(rows);
    const { selected, rejected } = selectBestByGtin(rows);

    await writeJson(ALL_PATH, {
      targetDate: TARGET_DATE_DOT,
      targetOperationType: TARGET_OPERATION_TYPE_TEXT,
      checkedAt: new Date().toISOString(),
      onlyGetRequests: true,
      transport: "browser-cookie-mode",
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
    console.log(`Всего операций: ${rows.length}`);
    console.log(`Уникальных GTIN: ${new Set(rows.map((row) => row.gtin)).size}`);
    console.log(`Задвоились GTIN: ${Object.keys(duplicates).length ? Object.keys(duplicates).join(", ") : "нет"}`);
    console.log(`Можно использовать: ${selected.map((row) => `${row.gtin}:${row.operationId}:${row.status}`).join(", ") || "нет"}`);
    console.log(`Нельзя использовать: ${rejected.map((row) => `${row.gtin}:${row.operationId}:${row.status}:${row.reason}`).join(", ") || "нет"}`);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
