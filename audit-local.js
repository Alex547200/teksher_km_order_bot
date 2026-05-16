const fs = require("node:fs/promises");
const path = require("node:path");

const SOURCE_DIR = "/Users/admin/Desktop/заказ км";
const ALL_PATH = path.join(__dirname, "audit_local_all.json");
const DUPLICATES_PATH = path.join(__dirname, "audit_local_duplicates.json");
const SELECTED_PATH = path.join(__dirname, "audit_local_selected.json");

const BAD_STATUSES = new Set(["ERROR", "500", "502"]);
const RANKED_STATUSES = new Map([
  ["DONE", 5],
  ["READY", 4],
  ["CREATED", 3],
  ["ACCEPTED", 3],
  ["PROGRESS", 2],
  ["IN_PROGRESS", 2],
  ["PROCESSING", 2],
  ["PENDING", 2],
  ["ERROR", 0],
  ["500", 0],
  ["502", 0],
]);

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

function timestampFromSourceFile(sourceFile) {
  const name = path.basename(sourceFile);
  const match = name.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
  if (!match) return 0;
  const raw = match[1];
  const [datePart, timePartWithZ] = raw.split("T");
  const timePart = timePartWithZ.replace(/Z$/, "");
  const [hh, mm, ss, mmm] = timePart.split("-");
  const iso = `${datePart}T${hh}:${mm}:${ss}.${mmm}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusRank(status) {
  return RANKED_STATUSES.get(normalizeStatus(status)) ?? 1;
}

function operationSortKey(record) {
  return [
    statusRank(record.status),
    timestampFromSourceFile(record.sourceFile),
  ];
}

function compareSelected(a, b) {
  const [rankA, tsA] = operationSortKey(a);
  const [rankB, tsB] = operationSortKey(b);
  if (rankA !== rankB) return rankB - rankA;
  if (tsA !== tsB) return tsB - tsA;
  return String(a.sourceFile).localeCompare(String(b.sourceFile));
}

function normalizeRecord(value, sourceFile) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;

  const operationId = findOwnField(value, [/^operationId$/i, /^operationID$/i, /^operation_id$/i, /^id$/i])
    || findFirstField(value, [/^operationId$/i, /^operationID$/i, /^operation_id$/i, /^id$/i]);
  const gtin = findFirstField(value, [/^gtin$/i, /^productGtin$/i, /^product_gtin$/i, /^barcode$/i]);
  const quantityRaw = findFirstField(value, [/^quantity$/i, /^kmsCount$/i, /^markingCodesAmount$/i, /^count$/i]);
  const status = normalizeStatus(findFirstField(value, [/^status$/i, /^state$/i]));

  if (!gtin || !operationId || !status) return null;

  const quantity = quantityRaw === ""
    ? ""
    : Number.isFinite(Number(quantityRaw))
      ? Number(quantityRaw)
      : quantityRaw;

  return {
    gtin,
    quantity,
    operationId,
    status,
    sourceFile: path.basename(sourceFile),
    timestampMs: timestampFromSourceFile(sourceFile),
  };
}

function collectRecords(value, sourceFile, out = [], seen = new Set(), recordKeys = new Set()) {
  if (value == null || typeof value !== "object") return out;
  if (seen.has(value)) return out;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectRecords(item, sourceFile, out, seen, recordKeys);
    return out;
  }

  const record = normalizeRecord(value, sourceFile);
  if (record) {
    const key = [
      record.sourceFile,
      record.operationId,
      record.gtin,
      record.status,
      String(record.quantity),
    ].join("|");
    if (!recordKeys.has(key)) {
      recordKeys.add(key);
      out.push(record);
    }
  }

  for (const nested of Object.values(value)) {
    collectRecords(nested, sourceFile, out, seen, recordKeys);
  }

  return out;
}

async function walkJsonFiles(dir) {
  const entries = [];
  const stack = [dir];

  while (stack.length) {
    const current = stack.pop();
    const dirEntries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of dirEntries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
      entries.push(fullPath);
    }
  }

  return entries;
}

function matchesSourceFile(name) {
  return (
    /^batch_.*response.*\.json$/i.test(name)
    || /^batch_.*status.*\.json$/i.test(name)
    || /^new_api_response\.json$/i.test(name)
    || /^new_api_status_check\.json$/i.test(name)
    || /^api_response\.json$/i.test(name)
    || /^api_status_check\.json$/i.test(name)
  );
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

function buildDuplicates(records) {
  const grouped = new Map();
  for (const record of records) {
    if (!grouped.has(record.gtin)) grouped.set(record.gtin, []);
    grouped.get(record.gtin).push(record);
  }

  const duplicates = {};
  for (const [gtin, items] of grouped.entries()) {
    if (items.length > 1) {
      duplicates[gtin] = items.slice().sort(compareSelected);
    }
  }
  return duplicates;
}

function selectBestByGtin(records) {
  const grouped = new Map();
  for (const record of records) {
    if (!grouped.has(record.gtin)) grouped.set(record.gtin, []);
    grouped.get(record.gtin).push(record);
  }

  const selected = [];
  for (const items of grouped.values()) {
    items.sort(compareSelected);
    selected.push(items[0]);
  }

  return selected.sort((a, b) => a.gtin.localeCompare(b.gtin));
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function main() {
  const allFiles = await walkJsonFiles(SOURCE_DIR);
  const sourceFiles = allFiles
    .filter((filePath) => matchesSourceFile(path.basename(filePath)))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  const records = [];
  for (const filePath of sourceFiles) {
    const data = await readJson(filePath).catch(() => null);
    if (!data) continue;
    collectRecords(data, filePath, records);
  }

  const duplicates = buildDuplicates(records);
  const selected = selectBestByGtin(records);
  const errors = records.filter((record) => BAD_STATUSES.has(normalizeStatus(record.status)));

  await writeJson(ALL_PATH, {
    generatedAt: new Date().toISOString(),
    sourceDir: SOURCE_DIR,
    filesScanned: sourceFiles.map((filePath) => path.basename(filePath)).sort(),
    records: records.sort((a, b) => a.gtin.localeCompare(b.gtin) || a.sourceFile.localeCompare(b.sourceFile)),
  });

  await writeJson(DUPLICATES_PATH, {
    generatedAt: new Date().toISOString(),
    duplicates,
  });

  await writeJson(SELECTED_PATH, {
    generatedAt: new Date().toISOString(),
    selected,
  });

  console.table(records.map((record) => ({
    gtin: record.gtin,
    quantity: record.quantity,
    operationId: record.operationId,
    status: record.status,
    sourceFile: record.sourceFile,
  })));

  const uniqueGtins = uniq(records.map((record) => record.gtin));
  const duplicateGtins = Object.keys(duplicates);
  const selectedGtins = selected.map((record) => record.gtin);

  console.log(`Всего записей: ${records.length}`);
  console.log(`Уникальных GTIN: ${uniqueGtins.length}`);
  console.log(`Дублей: ${duplicateGtins.length}`);
  console.log(`Ошибок: ${errors.length}`);
  console.log(`Выбранных GTIN: ${selectedGtins.join(", ") || "нет"}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
