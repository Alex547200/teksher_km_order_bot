const fs = require("node:fs/promises");
const path = require("node:path");
const authHelper = require("./teksher-auth");

const BASE_URL = "https://label.teksher.kg";
const AUTH_TOKENS_PATH = path.join(__dirname, "auth_tokens.json");
const TOKEN_URL = "https://label.teksher.kg/realms/mzkm_prod_realm/protocol/openid-connect/token";
const CLIENT_ID = "facade_client";
const REQUEST_TIMEOUT_MS = 20000;
const TARGET_DATE = "2026-05-15";
const PRODUCT_QUERY_BASES = [
  "/facade/api/v1/products?page=0&size=100&productGroup=1&createdByIssuer=true",
  "/facade/api/v1/products?page=0&size=100&createdByIssuer=true",
  "/facade/api/v1/products?page=0&size=100",
];
const OPERATION_LIST_BASES = [
  "/facade/api/v1/operations?page=0&size=100",
  "/facade/order/api/v1/operations?page=0&size=100",
];
const TARGET_GTINS = [
  "04707197100891",
  "04707197100907",
  "04707197100914",
  "04707197100921",
  "04707197100938",
];
const GTIN_PATTERNS = ["009", "0089"];
const SIMILAR_GTIN_MIN = "04707197100884";
const SIMILAR_GTIN_MAX = "04707197100907";

function normalizeToken(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "").trim();
}

function decodeJwtExpMs(token) {
  const payload = authHelper.decodeJwtPayload(token);
  const exp = Number(payload?.exp || 0);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
}

function isTokenExpired(token, skewMs = 60_000) {
  const expMs = decodeJwtExpMs(token);
  return !expMs || expMs <= Date.now() + skewMs;
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error(`request timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function firstJsonKeys(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.length && value[0] && typeof value[0] === "object" ? Object.keys(value[0]).slice(0, 10) : [];
  }
  return Object.keys(value).slice(0, 10);
}

function normalizeItem(item) {
  if (!item || typeof item !== "object") return null;
  const gtin =
    String(item.gtin || item.productGtin || item.product_gtin || item.productGTIN || item.product?.gtin || "").trim();
  const id =
    String(item.id || item.productId || item.product_id || item.product?.id || item.operationId || "").trim();
  const status = String(item.status || item.state || item.productStatus || "").trim();
  return {
    raw: item,
    productId: id,
    gtin,
    status,
  };
}

function extractItems(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.content)) return body.content;
  if (Array.isArray(body.items)) return body.items;
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.results)) return body.results;
  if (Array.isArray(body.rows)) return body.rows;
  return [];
}

function collectGtinsFromItem(item) {
  const values = [
    item.gtin,
    item.productGtin,
    item.product_gtin,
    item.productGTIN,
    item.product?.gtin,
    item.product?.productGtin,
    item.fullName,
    item.name,
    item.title,
    item.product?.fullName,
    item.product?.name,
  ];
  return values.map((value) => String(value || "").trim()).filter(Boolean);
}

function extractFullName(item) {
  return String(
    item.fullName ||
      item.name ||
      item.title ||
      item.product?.fullName ||
      item.product?.name ||
      item.product?.title ||
      ""
  ).trim();
}

function extractOperationId(item) {
  return String(item.id || item.operationId || item.operationID || item.operation_id || item.product?.operationId || "").trim();
}

function matchesSimilarGtin(gtin) {
  const text = String(gtin || "").trim();
  if (!text) return false;
  if (TARGET_GTINS.includes(text)) return true;
  if (GTIN_PATTERNS.some((pattern) => text.includes(pattern))) return true;
  return text >= SIMILAR_GTIN_MIN && text <= SIMILAR_GTIN_MAX;
}

function normalizeSimilarRow(item, sourceEndpoint) {
  const gtin = String(item.gtin || item.productGtin || item.product_gtin || item.product?.gtin || "").trim();
  const operationId = extractOperationId(item);
  const id = String(item.id || item.productId || item.product_id || item.product?.id || "").trim();
  const status = String(item.status || item.state || item.productStatus || "").trim();
  const fullName = extractFullName(item);
  if (!gtin && !operationId && !id) return null;
  return {
    gtin,
    fullName,
    status,
    id: id || "",
    operationId,
    sourceEndpoint,
  };
}

async function loadAuth() {
  const candidates = await authHelper.readAuthCandidatesFromFiles([
    { path: AUTH_TOKENS_PATH, source: "auth_tokens.json" },
  ]);
  const accessCandidate = authHelper.chooseAccessToken(candidates);
  const refreshCandidate = authHelper.chooseRefreshToken(candidates);

  let accessToken = normalizeToken(accessCandidate?.token || "");
  let refreshToken = normalizeToken(refreshCandidate?.token || "");
  let source = accessCandidate?.source || refreshCandidate?.source || "auth_tokens.json";

  if ((!accessToken || isTokenExpired(accessToken)) && refreshToken) {
    const refreshed = await authHelper.refreshAuthToken(refreshToken, {
      tokenUrl: TOKEN_URL,
      clientId: CLIENT_ID,
      authTokensPath: AUTH_TOKENS_PATH,
      source: "search-gtin",
    });
    accessToken = normalizeToken(refreshed.accessToken || "");
    refreshToken = normalizeToken(refreshed.refreshToken || refreshToken);
    source = "auth_tokens.json (refreshed)";
    console.log("ACCESS_TOKEN_REFRESHED");
    console.log(`NEW_EXP ${refreshed.tokenExpiresAt || "n/a"}`);
  }

  return {
    accessToken,
    refreshToken,
    source,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json, text/plain, */*",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/operations`,
    },
  };
}

async function getJson(url, headers) {
  console.log(`GET ${url}`);
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
      contentType: response.headers.get("content-type") || "",
      text,
      json,
      firstKeys: firstJsonKeys(json),
    };
  } catch (error) {
    console.log(`error.name: ${error?.name || "Error"}`);
    console.log(`error.message: ${error?.message || String(error)}`);
    console.log(`error.cause: ${JSON.stringify(error?.cause ?? null, null, 2)}`);
    return {
      url,
      status: 0,
      ok: false,
      contentType: "",
      text: "",
      json: null,
      firstKeys: [],
      error: {
        name: error?.name || "Error",
        message: error?.message || String(error),
        cause: JSON.stringify(error?.cause ?? null, null, 2),
        stack: error?.stack || "",
      },
    };
  }
}

async function fetchPagedCollection(baseUrl, headers, collectFn) {
  const rows = [];
  let page = 0;
  let totalPages = 1;
  const seenUrls = new Set();

  while (page < totalPages) {
    console.log(`BUILD URL: ${baseUrl}`);
    let urlText = "";
    try {
      const url = new URL(baseUrl, BASE_URL);
      url.searchParams.set("page", String(page));
      url.searchParams.set("size", "100");
      urlText = url.toString();
    } catch (error) {
      console.log("INVALID_URL");
      rows.push({
        page,
        url: baseUrl,
        status: 0,
        ok: false,
        contentType: "",
        text: "",
        json: null,
        firstKeys: [],
        error: {
          name: error?.name || "Error",
          message: error?.message || String(error),
          cause: JSON.stringify(error?.cause ?? null, null, 2),
          stack: error?.stack || "",
        },
      });
      break;
    }

    if (seenUrls.has(urlText)) break;
    seenUrls.add(urlText);

    const result = await getJson(urlText, headers);
    rows.push({ page, ...result });
    if (!result.ok) {
      if (result.error) {
        page += 1;
        continue;
      }
      break;
    }

    const items = extractItems(result.json).map(collectFn).filter(Boolean);
    rows[rows.length - 1].count = items.length;

    const totalPagesFromBody = Number(result.json?.totalPages || result.json?.page?.totalPages || 0);
    if (Number.isFinite(totalPagesFromBody) && totalPagesFromBody > 0) {
      totalPages = totalPagesFromBody;
    } else if (items.length < 100) {
      totalPages = page + 1;
    } else {
      totalPages += 1;
    }

    page += 1;
  }

  return rows;
}

async function fetchAllProducts(headers) {
  const allRows = [];
  const seen = new Map();
  for (const baseUrl of PRODUCT_QUERY_BASES) {
    const rows = await fetchPagedCollection(baseUrl, headers, normalizeItem);
    allRows.push(...rows);
    for (const row of rows) {
      const items = extractItems(row.json).map(normalizeItem).filter(Boolean);
      for (const item of items) {
        const key = `${item.gtin}|${item.productId}`;
        if (!seen.has(key)) seen.set(key, { ...item, sourceEndpoint: row.url });
      }
    }
  }
  return {
    rows: allRows,
    items: Array.from(seen.values()),
  };
}

async function fetchAllOperations(headers) {
  const rows = [];
  const seen = new Map();
  for (const baseUrl of OPERATION_LIST_BASES) {
    const pages = await fetchPagedCollection(baseUrl, headers, (item) => item);
    rows.push(...pages);
    for (const page of pages) {
      const items = extractItems(page.json);
      for (const item of items) {
        const gtin = String(item.gtin || item.productGtin || item.product_gtin || item.product?.gtin || "").trim();
        const operationId = extractOperationId(item);
        const key = `${gtin}|${operationId}`;
        if (!seen.has(key)) seen.set(key, { ...item, sourceEndpoint: page.url });
      }
    }
  }

  return {
    rows,
    items: Array.from(seen.values()),
  };
}

function matchSimilarProducts(products, targetGtin) {
  const seen = new Set();
  return products
    .filter((item) => collectGtinsFromItem(item).some((gtin) => gtin === targetGtin || matchesSimilarGtin(gtin)))
    .map((item) => normalizeSimilarRow(item, item.sourceEndpoint || ""))
    .filter(Boolean)
    .filter((item) => {
      const key = `${item.gtin}|${item.id}|${item.operationId}|${item.sourceEndpoint}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function matchSimilarOperations(operations, targetGtin) {
  const seen = new Set();
  return operations
    .filter((item) => {
      const gtin = String(item.gtin || item.productGtin || item.product_gtin || item.product?.gtin || "").trim();
      return gtin === targetGtin || matchesSimilarGtin(gtin);
    })
    .map((item) => normalizeSimilarRow(item, item.sourceEndpoint || ""))
    .filter(Boolean)
    .filter((item) => {
      const key = `${item.gtin}|${item.id}|${item.operationId}|${item.sourceEndpoint}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function buildRangeRows(products, operations) {
  const rows = [];
  const seen = new Set();

  for (const item of products) {
    const gtin = String(item.gtin || item.productGtin || item.product_gtin || item.product?.gtin || "").trim();
    if (!gtin) continue;
    if (!(TARGET_GTINS.includes(gtin) || GTIN_PATTERNS.some((pattern) => gtin.includes(pattern)) || (gtin >= SIMILAR_GTIN_MIN && gtin <= SIMILAR_GTIN_MAX))) {
      continue;
    }
    const key = `product|${gtin}|${item.productId || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      gtin,
      foundProduct: "yes",
      productStatus: item.status || "",
      operationId: "",
      operationStatus: "",
      source: item.sourceEndpoint || "products",
    });
  }

  for (const item of operations) {
    const gtin = String(item.gtin || item.productGtin || item.product_gtin || item.product?.gtin || "").trim();
    if (!gtin) continue;
    if (!(TARGET_GTINS.includes(gtin) || GTIN_PATTERNS.some((pattern) => gtin.includes(pattern)) || (gtin >= SIMILAR_GTIN_MIN && gtin <= SIMILAR_GTIN_MAX))) {
      continue;
    }
    const operationId = extractOperationId(item);
    const key = `operation|${gtin}|${operationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      gtin,
      foundProduct: "yes",
      productStatus: "",
      operationId,
      operationStatus: String(item.status || item.state || "").trim(),
      source: item.sourceEndpoint || "operations",
    });
  }

  return rows.sort((a, b) => a.gtin.localeCompare(b.gtin) || a.operationId.localeCompare(b.operationId));
}

async function main() {
  const targetGtin = String(process.argv[2] || "").trim();
  if (!targetGtin) {
    throw new Error("Usage: node search-gtin.js <GTIN>");
  }

  const auth = await loadAuth();
  const products = await fetchAllProducts(auth.headers);
  const operations = await fetchAllOperations(auth.headers);

  const exactProduct = products.items.find((item) => String(item.gtin || "").trim() === targetGtin) || null;
  const similarProducts = matchSimilarProducts(products.items, targetGtin);
  const similarOperations = matchSimilarOperations(operations.items, targetGtin);
  const combinedSimilar = [...similarProducts, ...similarOperations];
  const rangeRows = buildRangeRows(products.items, operations.items);

  const output = {
    generatedAt: new Date().toISOString(),
    targetGtin,
    targetGtins: TARGET_GTINS,
    products: products.rows,
    operations: operations.rows,
    foundProduct: Boolean(exactProduct),
    productId: exactProduct?.productId || "",
    gtin: exactProduct?.gtin || targetGtin,
    status: exactProduct?.status || "",
    similar: combinedSimilar,
    rangeRows,
  };

  await writeJson(path.join(__dirname, "search_gtin_range_result.json"), output);

  console.log(`found product ${exactProduct ? "yes" : "no"}`);
  console.log(`product id: ${exactProduct?.productId || ""}`);
  console.log(`gtin: ${exactProduct?.gtin || targetGtin}`);
  console.log(`status: ${exactProduct?.status || ""}`);
  console.log(`operationId: ${exactProduct?.operationId || ""}`);
  console.table(rangeRows.map((row) => ({
    gtin: row.gtin,
    foundProduct: row.foundProduct,
    productStatus: row.productStatus,
    operationId: row.operationId,
    operationStatus: row.operationStatus,
    source: row.source,
  })));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
