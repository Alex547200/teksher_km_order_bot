const fs = require("node:fs/promises");
const path = require("node:path");

const BASE_DIR = path.join("/Users/admin/Desktop", "заказ км");
const SOURCE_PATH = path.join(BASE_DIR, "битые", "marking_codes_7_fixed.txt");
const OUT_JSON = path.join(BASE_DIR, "битые", "km_status_check.json");
const OUT_CSV = path.join(BASE_DIR, "битые", "km_status_check.csv");

const PRODUCT_GROUP_NAME = "Предметы одежды, белье постельное, столовое, туалетное и кухонное (Россия)";

function splitLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseKizLine(line) {
  const gs = String.fromCharCode(29);
  const first = line.split(gs)[0] || "";
  const match = first.match(/^01(\d{14})21(.+)$/);
  if (!match) {
    return {
      raw: line,
      gtin: "",
      serial: "",
      parseError: "Could not parse GS1 KIZ line",
    };
  }

  return {
    raw: line,
    gtin: match[1],
    serial: match[2],
    parseError: "",
  };
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

function normalizeStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function inferIntroduced(status) {
  const s = normalizeStatus(status);
  return ["DONE", "READY", "INTRODUCED", "IN_CIRCULATION", "CIRCULATED", "SHIPPED"].includes(s);
}

function inferShipmentAvailable(status) {
  const s = normalizeStatus(status);
  return ["DONE", "READY", "INTRODUCED", "IN_CIRCULATION", "CIRCULATED", "SHIPPED"].includes(s);
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r;]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function pickBetter(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;

  const rank = {
    DONE: 5,
    READY: 4,
    CREATED: 3,
    PROGRESS: 2,
    ACCEPTED: 1,
    ERROR: 0,
    500: 0,
    502: 0,
  };

  const currentRank = rank[normalizeStatus(current.status)] ?? -1;
  const candidateRank = rank[normalizeStatus(candidate.status)] ?? -1;

  if (candidateRank !== currentRank) {
    return candidateRank > currentRank ? candidate : current;
  }

  const currentTime = Number(current.timestampMs || current.updatedAtMs || current.createdAtMs || 0);
  const candidateTime = Number(candidate.timestampMs || candidate.updatedAtMs || candidate.createdAtMs || 0);
  if (candidateTime !== currentTime) {
    return candidateTime > currentTime ? candidate : current;
  }

  return current;
}

async function buildLocalLookup() {
  const lookup = new Map();
  const files = await fs.readdir(BASE_DIR).catch(() => []);

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    if (file.startsWith("km_status_check")) continue;

    const filePath = path.join(BASE_DIR, file);
    let data;
    try {
      data = await readJson(filePath);
    } catch {
      continue;
    }

    const timestampMatch = file.match(/(\d{4}-\d{2}-\d{2}T[\d:-]+(?:\.\d+)?Z)/);
    const fileTimestampMs = timestampMatch ? Date.parse(timestampMatch[1].replace(/-(\d{2})Z$/, ".$1Z")) : 0;

    const register = (gtin, entry) => {
      if (!gtin || !entry) return;
      const current = lookup.get(gtin);
      const candidate = {
        gtin,
        status: entry.status || entry.apiStatus || entry.body?.status || entry.httpStatus || "",
        message: entry.message || entry.result || entry.body?.message || "",
        productGroup:
          entry.productGroup ||
          entry.body?.productGroupMarking?.name ||
          entry.body?.productGroupMarking?.code ||
          entry.productGroupMarking?.name ||
          entry.productGroupMarking?.code ||
          PRODUCT_GROUP_NAME,
        introduced: typeof entry.introduced === "boolean" ? entry.introduced : inferIntroduced(entry.status || entry.apiStatus || entry.body?.status || entry.httpStatus),
        shipmentAvailable:
          typeof entry.shipmentAvailable === "boolean"
            ? entry.shipmentAvailable
            : inferShipmentAvailable(entry.status || entry.apiStatus || entry.body?.status || entry.httpStatus),
        reason: entry.reason || entry.message || entry.body?.message || "",
        sourceFile: file,
        operationId: entry.operationId || entry.body?.id || "",
        quantity: entry.quantity || entry.body?.kmsCount || "",
        timestampMs: entry.timestampMs || entry.updatedAtMs || entry.createdAtMs || fileTimestampMs || 0,
      };
      lookup.set(gtin, pickBetter(current, candidate));
    };

    if (Array.isArray(data?.operations)) {
      for (const entry of data.operations) {
        const gtin = entry.gtin || entry.body?.product?.gtin;
        if (!gtin) continue;
        register(gtin, {
          ...entry,
          productGroup: entry.body?.productGroupMarking?.name || entry.body?.productGroupMarking?.code,
          reason: entry.message || entry.result || "",
          introduced: inferIntroduced(entry.status || entry.body?.status),
          shipmentAvailable: inferShipmentAvailable(entry.status || entry.body?.status),
          timestampMs: Date.parse(entry.createdAt || "") || fileTimestampMs || 0,
        });
      }
    }

    if (Array.isArray(data?.rows)) {
      for (const entry of data.rows) {
        if (!entry?.gtin) continue;
        register(entry.gtin, {
          ...entry,
          productGroup: PRODUCT_GROUP_NAME,
          introduced: inferIntroduced(entry.apiStatus || entry.status || entry.httpStatus),
          shipmentAvailable: inferShipmentAvailable(entry.apiStatus || entry.status || entry.httpStatus),
          reason: entry.message || "",
          timestampMs: Date.parse(entry.checkedAt || data.checkedAt || "") || fileTimestampMs || 0,
        });
      }
    }

    if (data?.gtins && typeof data.gtins === "object") {
      for (const [gtin, entry] of Object.entries(data.gtins)) {
        register(gtin, {
          ...entry,
          productGroup: PRODUCT_GROUP_NAME,
          introduced: inferIntroduced(entry.apiStatus || entry.status || entry.httpStatus),
          shipmentAvailable: inferShipmentAvailable(entry.apiStatus || entry.status || entry.httpStatus),
          reason: entry.message || "",
          timestampMs: Date.parse(entry.updatedAt || data.updatedAt || "") || fileTimestampMs || 0,
        });
      }
    }
  }

  return lookup;
}

async function main() {
  const sourceText = await fs.readFile(SOURCE_PATH, "utf8");
  const rows = splitLines(sourceText).map(parseKizLine);
  const lookup = await buildLocalLookup();

  const results = rows.map((row) => {
    const matched = lookup.get(row.gtin);
    const status = matched?.status || (row.parseError ? "ERROR" : "UNKNOWN");
    const reason = row.parseError || matched?.reason || (matched ? "" : "no local status artifact found");
    return {
      gtin: row.gtin,
      serial: row.serial,
      status,
      productGroup: matched?.productGroup || PRODUCT_GROUP_NAME,
      introduced: matched ? matched.introduced : false,
      shipmentAvailable: matched ? matched.shipmentAvailable : false,
      reason,
      sourceFile: matched?.sourceFile || "",
      operationId: matched?.operationId || "",
      quantity: matched?.quantity || "",
    };
  });

  const json = {
    generatedAt: new Date().toISOString(),
    sourcePath: SOURCE_PATH,
    rows: results,
  };

  const csvHeader = ["GTIN", "serial", "status", "productGroup", "introduced", "shipmentAvailable", "reason"];
  const csvLines = [
    csvHeader.join(","),
    ...results.map((row) =>
      [
        row.gtin,
        row.serial,
        row.status,
        row.productGroup,
        row.introduced ? "true" : "false",
        row.shipmentAvailable ? "true" : "false",
        row.reason,
      ]
        .map(csvEscape)
        .join(",")
    ),
  ];

  await fs.writeFile(OUT_JSON, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  await fs.writeFile(OUT_CSV, `${csvLines.join("\n")}\n`, "utf8");

  console.table(
    results.map((row) => ({
      GTIN: row.gtin,
      serial: row.serial,
      status: row.status,
      productGroup: row.productGroup,
      introduced: row.introduced,
      shipmentAvailable: row.shipmentAvailable,
      reason: row.reason,
    }))
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
