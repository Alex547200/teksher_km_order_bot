#!/usr/bin/env node
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const authHelper = require("./teksher-auth");

const PROJECT_DIR = __dirname;
const INPUT_XLSX_PATH = path.join(os.homedir(), "Desktop", "коледино выгрузка.xlsx");
const AUTH_TOKENS_PATH = path.join(PROJECT_DIR, "auth_tokens.json");
const BASE_URL = "https://label.teksher.kg";
const MULTI_OPERATION_API_PATH = "/facade/order/api/v1/operations/multi";
const OPERATION_STATUS_API_PATH = "/facade/api/v1/operations/{operationId}";
const CSV_DOWNLOAD_API_PATH = "/facade/api/v1/marking_codes/csv?operationId={operationId}";
const PRODUCT_GROUP_NAME = "Предметы одежды";
const BATCH_SIZE = 10;
const REQUEST_TIMEOUT = 45000;
const POLL_DELAY_MS = 5000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const COMMIT = process.argv.includes("--commit");
const RESUME_ARG = process.argv.find((arg) => arg.startsWith("--resume"));
const INPUT_OVERRIDE = process.argv.find((arg) => arg.endsWith(".xlsx"));
const WORKBOOK_PATH = INPUT_OVERRIDE ? path.resolve(INPUT_OVERRIDE) : INPUT_XLSX_PATH;
const CSV_OUTPUT_DIR = path.join(os.homedir(), "Desktop", "электросталь Соня");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeToken(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "").trim();
}

function sanitizeFilePart(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function buildMultiOperationPayloadFor(itemsList) {
  return {
    countryId: 199,
    extension: "lp",
    items: itemsList.map(({ gtin, quantity }) => ({
      gtin,
      markingCodesAmount: quantity,
      dataSupplier: "AUTO",
    })),
  };
}

function extractCreatedOperationPairs(body) {
  if (!body || typeof body !== "object") return [];
  if (body.data && typeof body.data === "object" && !Array.isArray(body.data)) {
    return Object.entries(body.data)
      .map(([operationId, gtin]) => ({
        operationId: String(operationId),
        gtin: String(gtin || ""),
      }))
      .filter((row) => row.operationId && row.gtin);
  }
  if (Array.isArray(body.operations)) {
    return body.operations
      .map((entry) => ({
        operationId: String(entry?.operationId || entry?.id || ""),
        gtin: String(entry?.gtin || entry?.productGtin || ""),
      }))
      .filter((row) => row.operationId && row.gtin);
  }
  return [];
}

function findFirstField(value, keyPatterns, seen = new Set()) {
  if (value == null) return "";
  if (typeof value !== "object") return "";
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
      if (typeof nested === "string") return nested;
      if (typeof nested === "number" || typeof nested === "boolean") return String(nested);
      try {
        return JSON.stringify(nested);
      } catch {
        return String(nested);
      }
    }
  }

  for (const nested of Object.values(value)) {
    const found = findFirstField(nested, keyPatterns, seen);
    if (found !== "") return found;
  }

  return "";
}

function summarizeStatusBody(body) {
  const status = findFirstField(body, [/^status$/i, /^state$/i, /^operationStatus$/i, /^currentStatus$/i]);
  const message = findFirstField(body, [/^message$/i, /^description$/i, /^detail$/i, /^error$/i]);
  const createdAt = findFirstField(body, [/^createdAt$/i, /^created_at$/i, /^created$/i]);
  return {
    status,
    message,
    createdAt,
  };
}

function normalizeStatusText(value) {
  return String(value || "").trim().toUpperCase();
}

function isFinalStatus(status) {
  return ["COMPLETED", "DONE", "READY", "CREATED", "ERROR", "FAILED", "CANCELLED", "CANCELED", "500", "502"].includes(normalizeStatusText(status));
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readWorkbookRows(filePath) {
  const pythonCode = String.raw`
import json
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "rel": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
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

def resolve_sheet_path(zf, sheet_name):
    workbook = ET.fromstring(zf.read("xl/workbook.xml"))
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    rel_map = {}
    for rel in rels:
        rel_map[rel.attrib.get("Id")] = rel.attrib.get("Target")
    sheets = workbook.findall("main:sheets/main:sheet", NS)
    chosen = None
    for sheet in sheets:
        if sheet.attrib.get("name") == sheet_name:
            chosen = sheet
            break
    if chosen is None and sheets:
        chosen = sheets[0]
    if chosen is None:
        return "", ""
    sheet_name_found = chosen.attrib.get("name", "")
    rel_id = chosen.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
    target = rel_map.get(rel_id, "")
    target = (target or "").lstrip("/")
    if target.startswith("xl/"):
        sheet_path = target
    else:
        sheet_path = posixpath.normpath(posixpath.join("xl", target))
    return sheet_name_found, sheet_path

def main():
    workbook_path = sys.argv[1]
    with zipfile.ZipFile(workbook_path) as zf:
        shared = read_shared_strings(zf)
        sheet_name, sheet_path = resolve_sheet_path(zf, "Лист1")
        if not sheet_path:
            print(json.dumps({"sheetName": sheet_name, "rows": []}, ensure_ascii=False))
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
            rows.append([values.get("A", ""), values.get("B", "")])
        print(json.dumps({"sheetName": sheet_name, "rows": rows}, ensure_ascii=False))

if __name__ == "__main__":
    main()
`;

  const result = spawnSync("python3", ["-c", pythonCode, filePath], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `Failed to read workbook: exit ${result.status}`);
  }

  const parsed = JSON.parse(result.stdout || "{}");
  return {
    sheetName: parsed.sheetName || "",
    rows: Array.isArray(parsed.rows) ? parsed.rows : [],
  };
}

function normalizeRows(rawRows) {
  const allRows = [];
  const validRows = [];

  for (const [index, raw] of rawRows.entries()) {
    const gtin = String(raw?.[0] ?? "").trim();
    const quantityText = String(raw?.[1] ?? "").trim().replace(",", ".");
    if (!gtin && !quantityText) continue;
    allRows.push({ index: index + 1, gtin, quantityText });
    const quantity = Number(quantityText);
    if (!gtin || !Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) continue;
    validRows.push({
      rowNumber: index + 1,
      gtin,
      quantity,
    });
  }

  return { allRows, validRows };
}

function parseResumeOperationIds() {
  if (!RESUME_ARG) return [];
  const raw = RESUME_ARG.includes("=") ? RESUME_ARG.split("=").slice(1).join("=") : "";
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((item) => String(item).trim())
    .filter(Boolean);
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

async function fetchJsonWithTimeout(url, headers) {
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

async function loadCommitAuth() {
  const candidates = await authHelper.readAuthCandidatesFromFiles([
    { path: AUTH_TOKENS_PATH, source: "auth_tokens.json" },
  ]);
  const accessCandidate = authHelper.chooseAccessToken(candidates);
  const refreshCandidate = authHelper.chooseRefreshToken(candidates);
  let accessToken = normalizeToken(accessCandidate?.token || "");
  let refreshToken = normalizeToken(refreshCandidate?.token || "");
  let accessExpMs = authHelper.decodeJwtExpMs(accessToken);
  const nowMs = Date.now();
  const isExpired = !accessToken || !accessExpMs || accessExpMs <= nowMs + 60_000;

  if (isExpired && refreshToken) {
    const refreshed = await authHelper.refreshAuthToken(refreshToken, {
      authTokensPath: AUTH_TOKENS_PATH,
      source: "create-km-from-excel",
    });
    accessToken = normalizeToken(refreshed.accessToken || "");
    refreshToken = normalizeToken(refreshed.refreshToken || refreshToken);
    accessExpMs = authHelper.decodeJwtExpMs(accessToken);
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
    accessToken,
    refreshToken,
    accessExpMs,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/operations`,
    },
  };
}

async function submitBatch(batchItems, authState) {
  const url = `${BASE_URL}${MULTI_OPERATION_API_PATH}`;
  const payload = buildMultiOperationPayloadFor(batchItems);
  console.log(`POST URL: ${url}`);
  console.log("PAYLOAD:");
  console.log(JSON.stringify(payload, null, 2));

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: authState.headers,
    body: JSON.stringify(payload),
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
    body: json ?? text,
    headers: Object.fromEntries(response.headers.entries()),
    payload,
  };
}

async function fetchOperationStatus(operationId, headers) {
  const url = `${BASE_URL}${OPERATION_STATUS_API_PATH.replace("{operationId}", encodeURIComponent(operationId))}`;
  console.log(`STATUS URL: ${url}`);
  return fetchJsonWithTimeout(url, headers);
}

async function downloadOperationCsv(operationId, headers, outputDir) {
  const url = `${BASE_URL}${CSV_DOWNLOAD_API_PATH.replace("{operationId}", encodeURIComponent(operationId))}`;
  console.log(`CSV URL: ${url}`);
  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers,
  });
  const contentType = response.headers.get("content-type") || "";
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    const text = buffer.toString("utf8").slice(0, 500);
    throw new Error(`HTTP ${response.status} for ${url}: ${text}`);
  }
  const targetPath = path.join(outputDir, `${sanitizeFilePart(operationId)}.csv`);
  if (await fileExists(targetPath)) {
    return { status: "skipped", targetPath, contentType };
  }
  await fs.writeFile(targetPath, buffer);
  return { status: "downloaded", targetPath, contentType };
}

async function pollOperationUntilFinal(operationId, headers) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let attempt = 0;
  const history = [];

  while (Date.now() < deadline) {
    attempt += 1;
    const response = await fetchOperationStatus(operationId, headers);
    const summary = summarizeStatusBody(response.json ?? response.text);
    const status = normalizeStatusText(summary.status || String(response.status));
    history.push({
      attempt,
      httpStatus: response.status,
      status,
      message: summary.message,
      createdAt: summary.createdAt,
    });
    console.log(`poll ${attempt}: ${operationId} -> ${status || response.status}`);

    if (!response.ok || Number(response.status) >= 400 || isFinalStatus(status)) {
      return {
        operationId,
        httpStatus: response.status,
        status,
        message: summary.message,
        createdAt: summary.createdAt,
        history,
      };
    }

    await sleep(POLL_DELAY_MS);
  }

  return {
    operationId,
    httpStatus: 0,
    status: "TIMEOUT",
    message: `Polling timed out after ${Math.round(POLL_TIMEOUT_MS / 1000)}s`,
    createdAt: "",
    history,
  };
}

async function pollUntilFinalWithRetry(operationId, headers) {
  let lastResult = null;
  for (let attempt = 1; attempt <= POLL_RETRIES; attempt += 1) {
    lastResult = await pollOperationUntilFinal(operationId, headers);
    if (lastResult.status !== "TIMEOUT") return lastResult;
    console.log(`retry polling ${operationId}: ${attempt}/${POLL_RETRIES}`);
    if (attempt < POLL_RETRIES) {
      await sleep(RETRY_DELAY_MS);
    }
  }
  return lastResult;
}

async function main() {
  const resumeOperationIds = parseResumeOperationIds();
  if (COMMIT && resumeOperationIds.length) {
    throw new Error("Use either --commit or --resume, not both.");
  }

  if (resumeOperationIds.length) {
    const authState = await loadCommitAuth();
    await ensureDir(CSV_OUTPUT_DIR);
    console.log("MODE: RESUME");
    console.log(`operationIds: ${resumeOperationIds.join(", ")}`);
    console.log(`save path: ${CSV_OUTPUT_DIR}`);
    console.log("AUTH_DIAGNOSTICS");
    console.log(`access token exists: ${authState.accessToken ? "yes" : "no"}`);
    console.log(`token exp: ${new Date(authState.accessExpMs).toISOString()}`);
    console.log(`current time: ${new Date().toISOString()}`);

    const resumed = [];
    const failedOperationIds = [];
    for (const operationId of resumeOperationIds) {
      console.log(`\nRESUME operationId: ${operationId}`);
      const finalState = await pollUntilFinalWithRetry(operationId, authState.headers);
      console.log(JSON.stringify(finalState, null, 2));
      if (normalizeStatusText(finalState.status) !== "COMPLETED") {
        failedOperationIds.push(operationId);
        continue;
      }

      try {
        const download = await downloadOperationCsv(operationId, authState.headers, CSV_OUTPUT_DIR);
        resumed.push({
          operationId,
          status: download.status,
          filePath: download.targetPath,
        });
        console.log(`CSV ${download.status}: ${download.targetPath}`);
      } catch (error) {
        failedOperationIds.push(operationId);
        console.error("CSV_DOWNLOAD_ERROR");
        console.error(`operationId: ${operationId}`);
        console.error(`error.name: ${error?.name || "n/a"}`);
        console.error(`error.message: ${error?.message || "n/a"}`);
        console.error(`error.stack: ${error?.stack || "n/a"}`);
        console.error(`error.cause: ${safeJsonStringify(error?.cause)}`);
      }
    }

    console.log("\nRESUME SUMMARY");
    console.log(`csv downloaded: ${resumed.filter((row) => row.status === "downloaded").length}`);
    console.log(`failed operationIds: ${failedOperationIds.length ? failedOperationIds.join(", ") : "none"}`);
    console.log(`save path: ${CSV_OUTPUT_DIR}`);
    return;
  }

  const { sheetName, rows } = await readWorkbookRows(WORKBOOK_PATH);
  const { allRows, validRows } = normalizeRows(rows);
  const batches = chunk(validRows, BATCH_SIZE);

  console.log(`workbook: ${WORKBOOK_PATH}`);
  console.log(`sheet: ${sheetName || "Лист1"}`);
  console.log(`productGroup: ${PRODUCT_GROUP_NAME}`);
  console.log(`rows seen: ${allRows.length}`);
  console.log(`rows read: ${validRows.length}`);
  console.log(`batch size: ${BATCH_SIZE}`);
  console.log(`batches planned: ${batches.length}`);
  console.log(`mode: ${COMMIT ? "commit" : "dry-run"}`);

  if (!validRows.length) {
    console.log("No valid GTIN/quantity rows found.");
    return;
  }

  const plannedSummary = [];
  for (const [batchIndex, batchItems] of batches.entries()) {
    const payload = buildMultiOperationPayloadFor(batchItems);
    const batchNumber = batchIndex + 1;
    console.log(`\nBATCH ${batchNumber}/${batches.length}`);
    console.table(batchItems.map((item, index) => ({
      index: index + 1,
      rowNumber: item.rowNumber,
      gtin: item.gtin,
      quantity: item.quantity,
    })));
    console.log(JSON.stringify(payload, null, 2));
    plannedSummary.push({
      batchNumber,
      items: batchItems.map((item) => ({
        rowNumber: item.rowNumber,
        gtin: item.gtin,
        quantity: item.quantity,
      })),
      payload,
    });
  }

  if (!COMMIT) {
    console.log("\nDRY_RUN complete. No POST requests were sent.");
    console.log("Use --commit to create operations.");
    return;
  }

  const authState = await loadCommitAuth();
  await ensureDir(CSV_OUTPUT_DIR);
  console.log("AUTH_DIAGNOSTICS");
  console.log(`access token exists: ${authState.accessToken ? "yes" : "no"}`);
  console.log(`token exp: ${new Date(authState.accessExpMs).toISOString()}`);
  console.log(`current time: ${new Date().toISOString()}`);

  const createdRows = [];
  let createdOperations = 0;
  let failedBatches = 0;
  const createdOperationIds = [];

  for (const [batchIndex, batchItems] of batches.entries()) {
    const batchNumber = batchIndex + 1;
    try {
      const result = await submitBatch(batchItems, authState);
      console.log(`\nBATCH ${batchNumber}/${batches.length} response status: ${result.status}`);
      console.log(typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2));
      if (!result.ok) {
        failedBatches += 1;
        continue;
      }

      const createdPairs = extractCreatedOperationPairs(result.body);
      createdOperations += createdPairs.length;
      for (const pair of createdPairs) {
        if (pair.operationId) createdOperationIds.push(pair.operationId);
      }
      const byGtin = new Map(createdPairs.map((row) => [row.gtin, row.operationId]));
      for (const item of batchItems) {
        createdRows.push({
          batchNumber,
          rowNumber: item.rowNumber,
          gtin: item.gtin,
          quantity: item.quantity,
          operationId: byGtin.get(item.gtin) || "",
        });
      }
      console.table(createdPairs.map((row) => ({
        batchNumber,
        operationId: row.operationId,
        gtin: row.gtin,
        quantity: batchItems.find((item) => item.gtin === row.gtin)?.quantity ?? "",
      })));
    } catch (error) {
      failedBatches += 1;
      console.error("BATCH_ERROR");
      console.error(`batchNumber: ${batchNumber}`);
      console.error(`error.name: ${error?.name || "n/a"}`);
      console.error(`error.message: ${error?.message || "n/a"}`);
      console.error(`error.stack: ${error?.stack || "n/a"}`);
      console.error(`error.cause: ${safeJsonStringify(error?.cause)}`);
    }
  }

  console.log("\nSUMMARY");
  console.log(`rows read: ${validRows.length}`);
  console.log(`operations created: ${createdOperations}`);
  console.log(`failed batches: ${failedBatches}`);
  console.table(createdRows.map((row) => ({
    batchNumber: row.batchNumber,
    rowNumber: row.rowNumber,
    gtin: row.gtin,
    quantity: row.quantity,
    operationId: row.operationId,
  })));

  const uniqueOperationIds = Array.from(new Set(createdOperationIds.filter(Boolean)));
  if (!uniqueOperationIds.length) {
    console.log("No operationId values found after commit. CSV download skipped.");
    console.log(`CSV save path: ${CSV_OUTPUT_DIR}`);
    return;
  }

  const pollResults = [];
  const csvResults = [];
  const failedOperationIds = [];

  for (const operationId of uniqueOperationIds) {
    console.log(`\nPOLL operationId: ${operationId}`);
    const finalState = await pollUntilFinalWithRetry(operationId, authState.headers);
    pollResults.push(finalState);
    console.log(JSON.stringify(finalState, null, 2));

    if (normalizeStatusText(finalState.status) !== "COMPLETED") {
      failedOperationIds.push(operationId);
      continue;
    }

    try {
      const download = await downloadOperationCsv(operationId, authState.headers, CSV_OUTPUT_DIR);
      csvResults.push({
        operationId,
        status: download.status,
        filePath: download.targetPath,
      });
      console.log(`CSV ${download.status}: ${download.targetPath}`);
    } catch (error) {
      failedOperationIds.push(operationId);
      console.error("CSV_DOWNLOAD_ERROR");
      console.error(`operationId: ${operationId}`);
      console.error(`error.name: ${error?.name || "n/a"}`);
      console.error(`error.message: ${error?.message || "n/a"}`);
      console.error(`error.stack: ${error?.stack || "n/a"}`);
      console.error(`error.cause: ${safeJsonStringify(error?.cause)}`);
    }
  }

  const downloadedCsvCount = csvResults.filter((row) => row.status === "downloaded").length;
  console.log("\nPOST-COMMIT SUMMARY");
  console.log(`csv downloaded: ${downloadedCsvCount}`);
  console.log(`failed operationIds: ${failedOperationIds.length ? failedOperationIds.join(", ") : "none"}`);
  console.log(`save path: ${CSV_OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error("FATAL_ERROR");
  console.error(`error.name: ${error?.name || "n/a"}`);
  console.error(`error.message: ${error?.message || "n/a"}`);
  console.error(`error.stack: ${error?.stack || "n/a"}`);
  console.error(`error.cause: ${safeJsonStringify(error?.cause)}`);
  process.exitCode = 1;
});
