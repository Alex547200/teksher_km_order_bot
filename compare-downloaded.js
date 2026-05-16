const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const SOURCE_PATH = path.join(__dirname, "audit_local_all.json");
const OUTPUT_DIR = path.join(os.homedir(), "Desktop", "электросталь печать кодов паркеровки");
const MISSING_PATH = path.join(__dirname, "missing_gtins.json");

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function readText(filePath) {
  return fs.readFile(filePath, "utf8");
}

function normalizeStatus(value) {
  return String(value || "").trim().toUpperCase();
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

function csvExists(files, gtin) {
  return [".csv"].some((ext) => {
    const names = [
      `${gtin}${ext}`,
      `${gtin}_2${ext}`,
      `${gtin}_3${ext}`,
    ];
    return names.some((name) => files.has(name));
  });
}

async function main() {
  const sourceText = await readText(SOURCE_PATH);
  let payload = null;
  try {
    payload = JSON.parse(sourceText);
  } catch {
    payload = null;
  }

  const records = extractRecords(payload)
    .map((row) => ({
      gtin: extractGtin(row),
      operationId: extractOperationId(row),
      status: normalizeStatus(row?.status),
      sourceFile: row?.sourceFile || "",
    }))
    .filter((row) => row.gtin);

  const dirEntries = await fs.readdir(OUTPUT_DIR, { withFileTypes: true });
  const csvFiles = new Set(
    dirEntries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"))
      .map((entry) => entry.name)
  );

  const missing = [];
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.gtin)) continue;
    seen.add(record.gtin);
    const hasCsv =
      csvFiles.has(`${record.gtin}.csv`) ||
      csvFiles.has(`${record.gtin}_2.csv`) ||
      csvFiles.has(`${record.gtin}_3.csv`);
    if (!hasCsv) {
      missing.push(record);
    }
  }

  await fs.writeFile(MISSING_PATH, `${JSON.stringify(missing, null, 2)}\n`, "utf8");

  console.log(`total audit records: ${records.length}`);
  console.log(`total csv files: ${csvFiles.size}`);
  console.log(`missing gtin count: ${missing.length}`);

  console.table(
    records.map((row) => ({
      gtin: row.gtin,
      operationId: row.operationId,
      status: row.status,
      sourceFile: row.sourceFile,
    }))
  );
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
