#!/usr/bin/env node
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const authHelper = require("./teksher-auth");

const PROJECT_DIR = __dirname;
const AUTH_TOKENS_PATH = path.join(PROJECT_DIR, "auth_tokens.json");
const DEFAULT_SOURCE_PATH = path.join(PROJECT_DIR, "batch.txt");
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_DIR, "tmp", "create-km-orders");
const DEFAULT_REPORT_JSON = path.join(DEFAULT_OUTPUT_DIR, "create_km_orders_report.json");
const DEFAULT_REPORT_TXT = path.join(DEFAULT_OUTPUT_DIR, "create_km_orders_report.txt");
const BASE_URL = "https://label.teksher.kg";
const MULTI_OPERATION_API_PATH = "/facade/order/api/v1/operations/multi";
const OPERATION_STATUS_API_PATH = "/facade/api/v1/operations/{operationId}";
const PRODUCT_GROUP_NAME = "Предметы одежды";
const BATCH_SIZE = 10;
const REQUEST_TIMEOUT_MS = 45_000;
const POLL_DELAY_MS = 5_000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_RETRIES = 3;
const RETRY_DELAY_MS = 1_000;

const dryRun = process.argv.includes("--dry-run");

function argValue(name, fallback = "") {
  const index = process.argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index === -1) return fallback;
  const arg = process.argv[index];
  if (arg.includes("=")) return arg.split("=").slice(1).join("=");
  return process.argv[index + 1] && !process.argv[index + 1].startsWith("--") ? process.argv[index + 1] : fallback;
}

function resolvePath(input, fallback) {
  return path.resolve(process.cwd(), input || fallback);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilePart(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function hasXlsxExtension(filePath) {
  return String(filePath || "").toLowerCase().endsWith(".xlsx");
}

function normalizeToken(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "").trim();
}

function isExpiredToken(token, skewMs = 60_000) {
  const expMs = authHelper.decodeJwtExpMs(normalizeToken(token));
  return !expMs || expMs <= Date.now() + skewMs;
}

function splitBatchLine(rawLine) {
  if (rawLine.includes(",")) return rawLine.split(",").map((part) => part.trim());
  if (rawLine.includes("\t")) return rawLine.split("\t").map((part) => part.trim());
  return rawLine.trim().split(/\s+/);
}

function parseBatchLine(rawLine, lineNumber) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) return null;
  const parts = splitBatchLine(line).filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Invalid batch line ${lineNumber}: "${rawLine}"`);
  }
  const gtin = parts[0].trim();
  const quantity = Number(parts[1]);
  const article = parts[2] ? String(parts[2]).trim() : "";
  const name = parts.slice(3).join(" ").trim();
  if (!gtin || !Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`Invalid batch line ${lineNumber}: "${rawLine}"`);
  }
  return {
    gtin,
    quantity,
    article,
    name,
    sourceLine: line,
  };
}

async function readBatchItems(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  const items = [];
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const parsed = parseBatchLine(rawLine, index + 1);
    if (parsed) items.push(parsed);
  }
  return items;
}

async function readXlsxRows(filePath) {
  const pythonCode = String.raw`
import json
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
}

def col_from_ref(ref):
    match = re.match(r"([A-Z]+)", ref or "")
    return match.group(1) if match else ""

def read_shared_strings(zf):
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    values = []
    for si in root.findall(".//main:si", NS):
        parts = []
        for text_node in si.findall(".//main:t", NS):
            parts.append(text_node.text or "")
        values.append("".join(parts))
    return values

def read_cell_value(cell, shared):
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.findall(".//main:t", NS))
    value_node = cell.find("main:v", NS)
    if value_node is None or value_node.text is None:
        return ""
    raw = value_node.text
    if cell_type == "s":
        if raw.isdigit():
            index = int(raw)
            if 0 <= index < len(shared):
                return shared[index]
        return ""
    return raw

def resolve_first_sheet_path(zf):
    workbook = ET.fromstring(zf.read("xl/workbook.xml"))
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    rel_map = {}
    for rel in rels:
        rel_map[rel.attrib.get("Id")] = rel.attrib.get("Target")
    sheets = workbook.findall("main:sheets/main:sheet", NS)
    chosen = sheets[0] if sheets else None
    if chosen is None:
        return ""
    rel_id = chosen.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
    target = rel_map.get(rel_id, "")
    target = (target or "").lstrip("/")
    if target.startswith("xl/"):
        return target
    return posixpath.normpath(posixpath.join("xl", target))

def main():
    workbook_path = sys.argv[1]
    with zipfile.ZipFile(workbook_path) as zf:
        shared = read_shared_strings(zf)
        sheet_path = resolve_first_sheet_path(zf)
        if not sheet_path:
            print(json.dumps({"rows": []}, ensure_ascii=False))
            return
        root = ET.fromstring(zf.read(sheet_path))
        rows = []
        for row in root.findall(".//main:sheetData/main:row", NS):
            values = {}
            for cell in row.findall("main:c", NS):
                ref = cell.attrib.get("r", "")
                col = col_from_ref(ref)
                if not col:
                    continue
                values[col] = read_cell_value(cell, shared)
            rows.append(values)
        print(json.dumps({"rows": rows}, ensure_ascii=False))

if __name__ == "__main__":
    main()
`;
  const result = spawnSync("python3", ["-c", pythonCode, filePath], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `Failed to read workbook: exit ${result.status}`);
  }
  const parsed = JSON.parse(result.stdout || "{}");
  return Array.isArray(parsed.rows) ? parsed.rows : [];
}

function normalizeHeaderText(value) {
  return String(value || "").trim().toLowerCase();
}

function findHeaderColumns(rows) {
  const headerRowIndex = rows.findIndex((row) => {
    const values = Object.values(row).map(normalizeHeaderText).filter(Boolean);
    return values.some((value) => /(gtin|товар|код)/i.test(value)) && values.some((value) => /(кол|qty|quantity|км|amount|amounts|marking)/i.test(value));
  });
  const headerRow = headerRowIndex >= 0 ? rows[headerRowIndex] : {};
  const entries = Object.entries(headerRow).map(([col, value]) => ({ col, header: normalizeHeaderText(value) }));
  let gtinCols = entries.filter(({ header }) => /(gtin|код товара|товар.*код|product.*code|barcode)/i.test(header)).map(({ col }) => col);
  let qtyCols = entries.filter(({ header }) => /(quantity|количество|км|amount|marking|qty)/i.test(header)).map(({ col }) => col);
  if (headerRowIndex < 0 || gtinCols.length === 0 || qtyCols.length === 0) {
    const firstRowColumns = Object.keys(rows[0] || {}).sort();
    gtinCols = firstRowColumns.slice(0, 1);
    qtyCols = firstRowColumns.slice(1, 2);
  }
  return {
    headerRowIndex,
    gtinCols,
    qtyCols,
  };
}

function parseQuantity(value) {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!text) return NaN;
  const num = Number(text);
  return Number.isFinite(num) ? num : NaN;
}

function normalizeImportedRows(rows) {
  const allRows = [];
  const validRows = [];
  const gtinSeen = new Set();
  const headers = findHeaderColumns(rows);
  if (headers.gtinCols.length === 0 || headers.qtyCols.length === 0) {
    throw new Error("XLSX_COLUMNS_NOT_FOUND: could not detect GTIN and quantity columns");
  }

  for (let index = Math.max(headers.headerRowIndex + 1, 0); index < rows.length; index += 1) {
    const row = rows[index];
    const gtin = headers.gtinCols.map((col) => String(row[col] ?? "").trim()).find(Boolean) || "";
    const quantityText = headers.qtyCols.map((col) => String(row[col] ?? "").trim()).find(Boolean) || "";
    const quantity = parseQuantity(quantityText);
    if (!gtin && !quantityText) continue;
    allRows.push({ index: index + 1, gtin, quantityText });
    if (!gtin || !Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) continue;
    if (gtinSeen.has(gtin)) continue;
    gtinSeen.add(gtin);
    validRows.push({
      rowNumber: index + 1,
      gtin,
      quantity,
      article: "",
      name: "",
      sourceLine: `${gtin} ${quantityText}`.trim(),
    });
  }

  return { allRows, validRows };
}

async function readSourceItems(sourcePath) {
  if (hasXlsxExtension(sourcePath)) {
    const rows = await readXlsxRows(sourcePath);
    return normalizeImportedRows(rows);
  }

  const items = await readBatchItems(sourcePath);
  return {
    allRows: items.map((item, index) => ({
      index: index + 1,
      gtin: item.gtin,
      quantityText: String(item.quantity),
    })),
    validRows: items.map((item, index) => ({
      rowNumber: index + 1,
      gtin: item.gtin,
      quantity: item.quantity,
      article: item.article,
      name: item.name,
      sourceLine: item.sourceLine,
    })),
  };
}

function validateBatchItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("BATCH_EMPTY: no valid items found");
  }

  const seen = new Map();
  const duplicates = [];
  for (const item of items) {
    if (!item || !item.gtin) {
      throw new Error("BATCH_INVALID_ROWS: every row must contain GTIN");
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new Error(`BATCH_INVALID_QUANTITY: ${item.gtin} must have a positive integer quantity`);
    }
    if (seen.has(item.gtin)) {
      duplicates.push({
        gtin: item.gtin,
        firstLine: seen.get(item.gtin).sourceLine,
        duplicateLine: item.sourceLine,
      });
      continue;
    }
    seen.set(item.gtin, item);
  }

  if (duplicates.length > 0) {
    const details = duplicates
      .map((row) => `${row.gtin} (lines ${row.firstLine} and ${row.duplicateLine})`)
      .join(", ");
    throw new Error(`BATCH_DUPLICATE_GTIN: ${details}`);
  }

  return items;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function validateChunks(chunks, maxItemsPerOrder = BATCH_SIZE) {
  for (const [index, batch] of chunks.entries()) {
    if (batch.length > maxItemsPerOrder) {
      throw new Error(`BATCH_TOO_LARGE: batch ${index + 1} has ${batch.length} items (max ${maxItemsPerOrder})`);
    }
  }
}

function buildMultiOperationPayloadFor(itemsList) {
  return {
    countryId: 199,
    extension: "lp",
    items: itemsList.map((item) => ({
      gtin: item.gtin,
      markingCodesAmount: item.quantity,
      dataSupplier: "AUTO",
    })),
  };
}

function renderBatchPreview(items) {
  return items.map((item, index) => ({
    index: index + 1,
    gtin: item.gtin,
    quantity: item.quantity,
    article: item.article,
    name: item.name,
  }));
}

function renderBatchSummary(batches) {
  return batches.map((batch, index) => ({
    batchNumber: index + 1,
    items: batch.length,
    gtins: batch.map((item) => item.gtin).join(", "),
  }));
}

function summarizeStatusBody(body) {
  const visited = new Set();
  const queue = [body];
  const readFirst = (keys) => {
    while (queue.length) {
      const current = queue.shift();
      if (current == null || typeof current !== "object") continue;
      if (visited.has(current)) continue;
      visited.add(current);
      if (Array.isArray(current)) {
        queue.push(...current);
        continue;
      }
      for (const [key, value] of Object.entries(current)) {
        if (keys.some((pattern) => pattern.test(key)) && value != null) return String(value);
        queue.push(value);
      }
    }
    return "";
  };
  return {
    status: readFirst([/^status$/i, /^state$/i, /^operationStatus$/i, /^currentStatus$/i]),
    createdAt: readFirst([/^createdAt$/i, /^created_at$/i, /^created$/i]),
    result: readFirst([/^result$/i, /^statusResult$/i]),
    message: readFirst([/^message$/i, /^description$/i, /^detail$/i, /^error$/i]),
  };
}

function isFinalStatus(status) {
  return ["COMPLETED", "DONE", "READY", "CREATED", "ERROR", "FAILED", "CANCELLED", "CANCELED", "500", "502"].includes(String(status || "").trim().toUpperCase());
}

function isAuthFailureStatus(status) {
  return status === 401 || status === 403;
}

async function fetchJson(url, { method = "GET", headers = {}, body = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("fetch timeout")), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: parsed,
      text,
    };
  } finally {
    clearTimeout(timer);
  }
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
    const refreshed = await authHelper.refreshAuthToken(refreshToken, {
      authTokensPath: AUTH_TOKENS_PATH,
      source: "create-km-orders",
    });
    accessToken = refreshed.accessToken;
    refreshToken = refreshed.refreshToken;
  }

  if (!accessToken) {
    throw new Error("TOKEN_MISSING: auth_tokens.json access_token not found");
  }
  if (isExpiredToken(accessToken)) {
    throw new Error("TOKEN_EXPIRED: auth_tokens.json access_token is expired");
  }

  return {
    accessToken,
    refreshToken,
    authHeaders: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    tokenExpiresAt: accessExpMs ? new Date(accessExpMs).toISOString() : "",
    hasAccessToken: true,
    isExpired: false,
  };
}

function collectOperationIds(body, out = []) {
  if (body == null) return out;
  if (Array.isArray(body)) {
    for (const item of body) collectOperationIds(item, out);
    return out;
  }
  if (typeof body === "object") {
    for (const [key, value] of Object.entries(body)) {
      if (/^(operationId|operationID|id|operation_id)$/.test(key) && (typeof value === "string" || typeof value === "number")) {
        out.push(String(value));
      }
      collectOperationIds(value, out);
    }
  }
  return out;
}

function pairCreatedOperations(responseBody, batchItems) {
  const pairs = [];
  if (!responseBody || typeof responseBody !== "object") return pairs;

  if (responseBody.data && typeof responseBody.data === "object" && !Array.isArray(responseBody.data)) {
    for (const [operationId, gtin] of Object.entries(responseBody.data)) {
      const item = batchItems.find((row) => row.gtin === String(gtin));
      pairs.push({
        operationId: String(operationId),
        gtin: String(gtin || item?.gtin || ""),
        quantity: item?.quantity ?? "",
        article: item?.article ?? "",
        name: item?.name ?? "",
      });
    }
    return pairs;
  }

  if (Array.isArray(responseBody.operations)) {
    const sourceItems = [...batchItems];
    for (const [index, entry] of responseBody.operations.entries()) {
      const operationId = String(entry?.operationId || entry?.id || "");
      const gtin = String(entry?.gtin || entry?.productGtin || "");
      const item = sourceItems.find((row) => row.gtin === gtin) || sourceItems[index] || sourceItems[0];
      if (!operationId) continue;
      pairs.push({
        operationId,
        gtin: gtin || item?.gtin || "",
        quantity: item?.quantity ?? "",
        article: item?.article ?? "",
        name: item?.name ?? "",
      });
    }
    return pairs;
  }

  const ids = collectOperationIds(responseBody);
  if (ids.length) {
    const sourceItems = [...batchItems];
    for (let index = 0; index < ids.length; index += 1) {
      const item = sourceItems[index] || sourceItems[0] || {};
      pairs.push({
        operationId: ids[index],
        gtin: item.gtin || "",
        quantity: item.quantity ?? "",
        article: item.article ?? "",
        name: item.name ?? "",
      });
    }
  }
  return pairs;
}

async function pollOperationStatus(operationId, authHeaders) {
  const url = `${BASE_URL}${OPERATION_STATUS_API_PATH.replace("{operationId}", encodeURIComponent(operationId))}`;
  const startedAt = Date.now();
  let attempts = 0;
  let lastResponse = null;

  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    attempts += 1;
    const response = await fetchJson(url, {
      method: "GET",
      headers: authHeaders,
    });
    lastResponse = response;
    const summary = summarizeStatusBody(response.body);
    const status = summary.status || String(response.status);
    if (response.ok && isFinalStatus(status)) {
      return {
        operationId,
        httpStatus: response.status,
        status,
        createdAt: summary.createdAt,
        result: summary.result,
        message: summary.message,
        attempts,
        body: response.body,
      };
    }
    if (isAuthFailureStatus(response.status)) {
      return {
        operationId,
        httpStatus: response.status,
        status: "AUTH_FAILED",
        createdAt: summary.createdAt,
        result: summary.result,
        message: summary.message || `HTTP ${response.status}`,
        attempts,
        body: response.body,
      };
    }
    await sleep(POLL_DELAY_MS);
  }

  const summary = summarizeStatusBody(lastResponse?.body);
  return {
    operationId,
    httpStatus: lastResponse?.status || 0,
    status: "TIMEOUT",
    createdAt: summary.createdAt,
    result: summary.result,
    message: `polling timed out after ${Math.round(POLL_TIMEOUT_MS / 1000)}s`,
    attempts,
    body: lastResponse?.body,
  };
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, lines) {
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  const sourcePath = resolvePath(argValue("--source", DEFAULT_SOURCE_PATH), DEFAULT_SOURCE_PATH);
  const outputDir = resolvePath(argValue("--output-dir", DEFAULT_OUTPUT_DIR), DEFAULT_OUTPUT_DIR);
  const reportJsonPath = resolvePath(argValue("--report-path", DEFAULT_REPORT_JSON), DEFAULT_REPORT_JSON);
  const reportTxtPath = resolvePath(
    argValue("--report-txt-path", DEFAULT_REPORT_TXT),
    DEFAULT_REPORT_TXT,
  );
  const sourceLabel = path.relative(process.cwd(), sourcePath) || sourcePath;

  if (!await fs.stat(sourcePath).catch(() => null)) {
    throw new Error(`Source file not found: ${sourcePath}`);
  }

  await fs.mkdir(outputDir, { recursive: true });

  const sourceData = await readSourceItems(sourcePath);
  const batchItems = sourceData.validRows;
  validateBatchItems(batchItems);
  if (!batchItems.length) {
    throw new Error(`No batch items found in ${sourcePath}`);
  }

  const batches = chunk(batchItems, BATCH_SIZE);
  validateChunks(batches, BATCH_SIZE);
  const totalKm = batchItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  console.log(`source: ${sourceLabel}`);
  console.log(`outputDir: ${outputDir}`);
  console.log(`batch size: ${BATCH_SIZE}`);
  console.log(`batch count: ${batches.length}`);
  console.log(`total rows: ${sourceData.allRows.length}`);
  console.log(`valid items: ${batchItems.length}`);
  console.log(`total KM: ${totalKm}`);
  console.log(`order count (10 items max): ${batches.length}`);
  console.table(renderBatchPreview(batchItems));
  console.log("batch summary:");
  console.table(renderBatchSummary(batches));

  if (dryRun) {
    const dryRunBatches = batches.map((items, index) => ({
      batchNumber: index + 1,
      count: items.length,
      payload: buildMultiOperationPayloadFor(items),
      items: items.map((item) => ({
        gtin: item.gtin,
        quantity: item.quantity,
        article: item.article,
        name: item.name,
      })),
    }));
    const dryRunPayload = {
      mode: "dry-run",
      source: sourcePath,
      batchSize: BATCH_SIZE,
      sourceRows: sourceData.allRows.length,
      validItems: batchItems.length,
      totalKm,
      batches: dryRunBatches,
    };
    await writeJson(reportJsonPath, dryRunPayload);
    await writeText(reportTxtPath, [
      "create_km_orders dry-run report",
      `source: ${sourcePath}`,
      `batch_size: ${BATCH_SIZE}`,
      `batch_count: ${batches.length}`,
      `total_rows: ${sourceData.allRows.length}`,
      `valid_items: ${batchItems.length}`,
      `total_km: ${totalKm}`,
      `output_dir: ${outputDir}`,
      "",
      JSON.stringify(dryRunPayload, null, 2),
    ]);
    console.log("dry-run: no POST requests sent");
    console.log(`report json: ${reportJsonPath}`);
    console.log(`report txt: ${reportTxtPath}`);
    console.log("example payload:");
    console.log(JSON.stringify(dryRunBatches[0]?.payload || {}, null, 2));
    console.log("dry-run batch preview:");
    console.table(dryRunBatches.map((batch) => ({
      batchNumber: batch.batchNumber,
      count: batch.count,
    })));
    return 0;
  }

  const auth = await resolveAuthFromFiles();
  console.log(`token expiresAt: ${auth.tokenExpiresAt || "(unknown)"}`);
  console.log(`token expired: ${auth.isExpired}`);

  const createdOrders = [];

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const items = batches[batchIndex];
    const batchNumber = batchIndex + 1;
    const payload = buildMultiOperationPayloadFor(items);
    console.log(`\n=== batch ${String(batchNumber).padStart(3, "0")} ===`);
    console.table(renderBatchPreview(items));
    console.log("request payload:");
    console.log(JSON.stringify(payload, null, 2));

    const response = await fetchJson(`${BASE_URL}${MULTI_OPERATION_API_PATH}`, {
      method: "POST",
      headers: {
        ...auth.authHeaders,
        "Content-Type": "application/json",
      },
      body: payload,
    });

    let finalResponse = response;
    if (isAuthFailureStatus(response.status)) {
      console.log(`batch ${batchNumber}: auth failed with ${response.status}, refreshing token and retrying once`);
      const refreshed = await authHelper.refreshAuthToken(auth.refreshToken || "", {
        authTokensPath: AUTH_TOKENS_PATH,
        source: "create-km-orders",
      });
      finalResponse = await fetchJson(`${BASE_URL}${MULTI_OPERATION_API_PATH}`, {
        method: "POST",
        headers: {
          ...refreshed.authHeaders,
          "Content-Type": "application/json",
        },
        body: payload,
      });
      auth.authHeaders.Authorization = refreshed.authHeaders.Authorization;
      auth.refreshToken = refreshed.refreshToken;
    }

    if (!finalResponse.ok) {
      throw new Error(`batch ${batchNumber} POST returned HTTP ${finalResponse.status}: ${finalResponse.text}`);
    }

    const pairs = pairCreatedOperations(finalResponse.body, [...items]);
    const operationIds = pairs.map((row) => row.operationId).filter(Boolean);
    console.log(`created operationId(s): ${operationIds.join(", ") || "(none found in response)"}`);

    const batchRecords = [];
    for (const row of pairs) {
      const statusInfo = row.operationId
        ? await pollOperationStatus(row.operationId, auth.authHeaders)
        : {
            operationId: "",
            httpStatus: 0,
            status: "NO_OPERATION_ID",
            createdAt: "",
            result: "",
            message: "operationId missing in create response",
            attempts: 0,
            body: null,
          };
      const record = {
        batchNumber,
        operationId: row.operationId,
        httpStatus: statusInfo.httpStatus,
        status: statusInfo.status,
        createdAt: statusInfo.createdAt,
        result: statusInfo.result,
        message: statusInfo.message,
        gtin: row.gtin,
        quantity: row.quantity,
        article: row.article,
        name: row.name,
        payload,
      };
      batchRecords.push(record);
      createdOrders.push(record);
    }

    console.table(batchRecords.map((row) => ({
      batchNumber: row.batchNumber,
      operationId: row.operationId,
      status: row.status,
      gtin: row.gtin,
      quantity: row.quantity,
      article: row.article,
      name: row.name,
    })));
  }

  const report = {
    source: sourcePath,
    createdAt: new Date().toISOString(),
    batchSize: BATCH_SIZE,
    dryRun: false,
    totalRows: sourceData.allRows.length,
    validItems: batchItems.length,
    totalKm,
    batchCount: batches.length,
    createdOrders,
  };
  await writeJson(reportJsonPath, report);
  await writeText(reportTxtPath, [
    "create_km_orders report",
    `source: ${sourcePath}`,
    `batch_size: ${BATCH_SIZE}`,
    `total_rows: ${sourceData.allRows.length}`,
    `valid_items: ${batchItems.length}`,
    `total_km: ${totalKm}`,
    `batch_count: ${batches.length}`,
    `created_orders: ${createdOrders.length}`,
    `output_dir: ${outputDir}`,
    "",
    ...createdOrders.map((row) =>
      `${row.batchNumber}\t${row.operationId}\t${row.status}\t${row.gtin}\t${row.quantity}\t${row.article}\t${row.name}`
    ),
  ]);

  console.log("\ncreate_km_orders summary:");
  console.log(`source file: ${sourcePath}`);
  console.log(`output dir: ${outputDir}`);
  console.log(`batches: ${batches.length}`);
  console.log(`created orders: ${createdOrders.length}`);
  console.table(createdOrders.map((row) => ({
    batchNumber: row.batchNumber,
    operationId: row.operationId,
    status: row.status,
    gtin: row.gtin,
    quantity: row.quantity,
    article: row.article,
    name: row.name,
  })));
  console.log(`report json: ${reportJsonPath}`);
  console.log(`report txt: ${reportTxtPath}`);
  return 0;
}

main().catch((err) => {
  console.error(err.stack || err.message);
  if (dryRun) process.exitCode = 1;
  else process.exitCode = 1;
});
