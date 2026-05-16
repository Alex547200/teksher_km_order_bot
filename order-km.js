const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const authHelper = require("./teksher-auth");

const OPERATIONS_URL = "https://label.teksher.kg/operations";
const OPERATIONS_IP_URL = "https://109.71.231.11/operations";
const LOGIN_URL = "https://label.teksher.kg/login";
const MULTI_OPERATION_API_PATH = "/facade/order/api/v1/operations/multi";
const projectDir = __dirname;
const outputDir = path.join(os.homedir(), "Desktop", "заказ км");
const screenshotsDir = path.join(outputDir, "screenshots");
const tmpDir = path.join(projectDir, "tmp");
const userDataDir = path.join(projectDir, "teksher-session-profile");
const batchFilePath = path.join(projectDir, "batch.txt");
const batchesFilePath = path.join(projectDir, "batches.txt");
const diagnoseSuccessPath = path.join(outputDir, "diagnose_batch_successes.json");

const items = [
  ["04707197100945", 5],
  ["04707197100952", 6],
  ["04707197100969", 5],
  ["04707197101027", 6],
  ["04707197101034", 6],
  ["04707197101041", 5],
  ["04707197101058", 5],
  ["04707197100860", 5],
  ["04707197100877", 5],
  ["04707197100884", 5],
];

const newItems = [
  ["04707197100419", 5],
  ["04707197100426", 5],
  ["04707197100433", 5],
  ["04707197100440", 5],
  ["04707197100457", 5],
  ["04707197100464", 5],
  ["04707197100471", 5],
  ["04707197100488", 5],
  ["04707197100495", 5],
];

async function ensureDirs() {
  await fs.mkdir(screenshotsDir, { recursive: true });
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.mkdir(userDataDir, { recursive: true });
}

function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function readBatchItems(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const parsed = [];

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) {
      throw new Error(`Invalid batch line ${index + 1}: "${rawLine}"`);
    }
    const gtin = parts[0].trim();
    const quantity = Number(parts[1]);
    if (!gtin || !Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`Invalid batch line ${index + 1}: "${rawLine}"`);
    }
    parsed.push([gtin, quantity]);
  }

  return parsed;
}

async function readBatches(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const batches = [];
  let current = null;

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const batchMatch = line.match(/^BATCH\s+(.+)$/i);
    if (batchMatch) {
      if (current) batches.push(current);
      current = {
        batchLabel: batchMatch[1].trim(),
        items: [],
      };
      continue;
    }

    if (!current) {
      throw new Error(`Item found before first BATCH marker on line ${index + 1}: "${rawLine}"`);
    }

    const parts = line.split(/\s+/);
    if (parts.length < 2) {
      throw new Error(`Invalid batch item on line ${index + 1}: "${rawLine}"`);
    }
    const gtin = parts[0].trim();
    const quantity = Number(parts[1]);
    if (!gtin || !Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`Invalid batch item on line ${index + 1}: "${rawLine}"`);
    }
    current.items.push([gtin, quantity]);
  }

  if (current) batches.push(current);
  return batches;
}

function safeName(name) {
  return name.replace(/[^a-z0-9а-яё_-]+/gi, "_").replace(/^_+|_+$/g, "");
}

async function extractControls(page) {
  return page.locator("button,input,select,option,textarea,a,[role='button'],[role='option'],[role='menuitem']").evaluateAll((els) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    return els.filter(visible).map((el, index) => ({
      index,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || "",
      role: el.getAttribute("role") || "",
      text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
      value: el.tagName.toLowerCase() === "input" ? "" : (el.value || ""),
      placeholder: el.getAttribute("placeholder") || "",
      name: el.getAttribute("name") || "",
      id: el.id || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      title: el.getAttribute("title") || "",
      disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
    }));
  });
}

async function saveStep(page, name) {
  const base = safeName(name);
  const screenshotPath = path.join(screenshotsDir, `${base}.png`);
  const htmlPath = path.join(screenshotsDir, `${base}.html`);
  const controlsPath = path.join(screenshotsDir, `${base}.controls.json`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await fs.writeFile(htmlPath, await page.content(), "utf8");
  const controls = await extractControls(page);
  await fs.writeFile(controlsPath, JSON.stringify(controls, null, 2), "utf8");
  console.log(`\n=== ${name} ===`);
  console.log(`screenshot: ${screenshotPath}`);
  console.log(`html: ${htmlPath}`);
  console.log(`controls: ${controlsPath}`);
  console.table(controls.map((c) => ({
    index: c.index,
    tag: c.tag,
    type: c.type,
    role: c.role,
    text: c.text.slice(0, 60),
    placeholder: c.placeholder.slice(0, 40),
    name: c.name,
    id: c.id,
  })));
  return controls;
}

async function pauseForManual(page, step, message) {
  await saveStep(page, `blocked_${step}`);
  console.error(`BLOCKED at ${step}: ${message}`);
  process.exitCode = 2;
}

async function logPageLocation(page, label) {
  const title = await page.title().catch(() => "");
  console.log(`${label} current URL: ${page.url()}`);
  console.log(`${label} title: ${title}`);
}

async function saveStepSafe(page, name) {
  try {
    await saveStep(page, name);
  } catch (err) {
    console.error(`could not save ${name}: ${err.message}`);
  }
}

async function saveHtmlAndScreenshot(page, htmlPath, screenshotPath) {
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await fs.writeFile(htmlPath, await page.content(), "utf8");
  console.log(`screenshot: ${screenshotPath}`);
  console.log(`html: ${htmlPath}`);
}

async function gotoOperationsWithRetry(page, label) {
  const attempts = [
    {
      name: "domcontentloaded",
      run: () => page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: 30000 }),
    },
    {
      name: "commit",
      run: () => page.goto(OPERATIONS_URL, { waitUntil: "commit", timeout: 30000 }),
    },
    {
      name: "ip_host_header",
      run: async () => {
        await page.setExtraHTTPHeaders({ Host: "label.teksher.kg" }).catch((err) => {
          console.error(`could not set Host header for IP fallback: ${err.message}`);
        });
        return page.goto(OPERATIONS_IP_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      },
    },
  ];

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    console.log(`${label}: goto operations attempt ${index + 1}/${attempts.length} (${attempt.name})`);
    try {
      await attempt.run();
      await logPageLocation(page, `${label} attempt ${index + 1} ok`);
      return true;
    } catch (err) {
      console.error(`${label}: goto operations attempt ${index + 1} failed: ${err.message}`);
      await logPageLocation(page, `${label} attempt ${index + 1} failed`);
      await saveStepSafe(page, `${label}_goto_attempt_${index + 1}_${attempt.name}_failed`);
    }
  }

  return false;
}

async function waitForOperations(page, timeout = 30000) {
  const result = await Promise.race([
    page.waitForURL((url) => {
      try {
        return new globalThis.URL(String(url)).pathname.includes("/operations");
      } catch {
        return false;
      }
    }, { timeout }).then(() => true),
    page.waitForSelector("text=Операции", { timeout }).then(() => true),
  ]).catch(() => false);
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  return result;
}

async function isAuthorized(page) {
  return page.url().includes("/operations") || await page.locator("text=Операции").first().isVisible().catch(() => false);
}

async function ensureAuthenticated(page) {
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  if (await isAuthorized(page)) {
    await saveStep(page, "01_authenticated_session");
    return { ok: true, manual: false };
  }

  console.log(`Not authorized in ${userDataDir}`);
  console.log("Enter login/password manually in this Playwright browser window. Session will be saved in teksher-session-profile.");
  if (!page.url().includes("/login")) {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  }
  await saveStep(page, "01_manual_login_page");

  const ok = await waitForOperations(page, 10 * 60 * 1000);
  if (!ok) {
    await pauseForManual(page, "manual_login", "manual login timed out; URL did not become /operations and text Операции did not appear");
    return { ok: false, manual: true };
  }

  await saveStep(page, "02_manual_login_saved");

  const operationsGotoOk = await gotoOperationsWithRetry(page, "after_manual_login_operations");
  const operationsLoaded = operationsGotoOk && await waitForOperations(page, 30000);
  if (!operationsLoaded) {
    await pauseForManual(page, "manual_login_operations", "manual login succeeded, but operations page did not load");
    return { ok: false, manual: true };
  }

  await saveHtmlAndScreenshot(
    page,
    path.join(screenshotsDir, "after_manual_login_operations.html"),
    path.join(screenshotsDir, "after_manual_login_operations.png"),
  );
  return { ok: true, manual: true };
}

async function extractBearerToken(page, context) {
  return authHelper.extractBearerToken(page, context);
}

function buildMultiOperationPayloadFor(itemsList) {
  return {
    countryId: 199,
    extension: "lp",
    items: itemsList.map(([gtin, markingCodesAmount]) => ({
      gtin,
      markingCodesAmount,
      dataSupplier: "AUTO",
    })),
  };
}

function isAuthFailureStatus(status) {
  return status === 401 || status === 403;
}

async function executeJsonFetch(page, { url, method, headers, body }) {
  return page.evaluate(async ({ requestUrl, requestMethod, requestHeaders, requestBody }) => {
    const response = await fetch(requestUrl, {
      method: requestMethod,
      headers: requestHeaders,
      body: requestBody == null ? undefined : JSON.stringify(requestBody),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      body: json ?? text,
    };
  }, {
    requestUrl: url,
    requestMethod: method,
    requestHeaders: headers,
    requestBody: body,
  });
}

async function writeJsonFile(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function findCreatedOperationIds(value, out = []) {
  if (value == null) return out;
  if (Array.isArray(value)) {
    for (const item of value) findCreatedOperationIds(item, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (/^(id|operationId|operationID|operation_id)$/.test(key) && ["string", "number"].includes(typeof nested)) {
        out.push(nested);
      }
      findCreatedOperationIds(nested, out);
    }
  }
  return out;
}

function collectStringFields(value, keys, out = []) {
  if (value == null) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectStringFields(item, keys, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (keys.some((pattern) => pattern.test(key)) && typeof nested === "string" && nested.trim()) {
        out.push(nested.trim());
      }
      collectStringFields(nested, keys, out);
    }
  }
  return out;
}

function buildOperationUrlCandidates(apiResult, operationIds = []) {
  const urls = [];
  const directUrls = collectStringFields(apiResult.body, [/^(url|href|link|operationUrl|redirectUrl)$/i, /url$/i]);
  for (const value of directUrls) {
    try {
      urls.push(new globalThis.URL(value, "https://label.teksher.kg").toString());
    } catch {}
  }

  for (const id of operationIds) {
    const idText = encodeURIComponent(String(id));
    urls.push(`https://label.teksher.kg/operations/${idText}`);
    urls.push(`https://label.teksher.kg/operation/${idText}`);
    urls.push(`https://label.teksher.kg/operations?operationId=${idText}`);
  }

  return Array.from(new Set(urls));
}

async function openOperationUrlIfPossible(page, apiResult, operationIds) {
  const candidates = buildOperationUrlCandidates(apiResult, operationIds);
  if (candidates.length === 0) {
    console.log("No operation URL candidates found in API response.");
    return false;
  }

  console.log("operation URL candidates:");
  console.table(candidates.map((url, index) => ({ index, url })));

  for (const url of candidates) {
    try {
      console.log(`opening operation URL: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      await logPageLocation(page, "operation_opened");
      await saveStepSafe(page, "operation_opened");
      return true;
    } catch (err) {
      console.error(`failed to open operation URL ${url}: ${err.message}`);
    }
  }

  return false;
}

async function readJsonFile(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function readJsonFileIfExists(filePath, fallback = null) {
  try {
    return await readJsonFile(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") return fallback;
    throw err;
  }
}

function extractCreatedOperations(apiResponse) {
  const data = apiResponse?.body?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  return Object.entries(data)
    .map(([operationId, gtin]) => ({
      operationId: String(operationId),
      gtin: String(gtin),
    }))
    .filter((item) => item.operationId && item.gtin);
}

function stringifyValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function findFirstField(value, keyPatterns, seen = new Set()) {
  if (value == null) return "";
  if (typeof value !== "object") {
    return "";
  }
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
      return stringifyValue(nested);
    }
  }

  for (const nested of Object.values(value)) {
    const found = findFirstField(nested, keyPatterns, seen);
    if (found !== "") return found;
  }

  return "";
}

function summarizeOperationStatusBody(body) {
  return {
    status: findFirstField(body, [/^status$/i, /^state$/i]) || "",
    createdAt: findFirstField(body, [/^createdAt$/i, /^created_at$/i, /^created$/i]) || "",
    result: findFirstField(body, [/^result$/i, /^outcome$/i]) || "",
    message: findFirstField(body, [/^message$/i, /^description$/i, /^detail$/i, /^error$/i]) || "",
  };
}

function findOperationForGtin(apiResponse, gtin) {
  return extractCreatedOperations(apiResponse).find((operation) => operation.gtin === gtin) || null;
}

function isHttpOk(status) {
  return Number.isFinite(Number(status)) && Number(status) >= 200 && Number(status) < 300;
}

function summarizeApiResult(response) {
  const summary = summarizeOperationStatusBody(response?.body);
  return {
    apiStatus: summary.status || String(response?.status ?? response?.httpStatus ?? ""),
    message: summary.message || "",
    createdAt: summary.createdAt || "",
    result: summary.result || "",
  };
}

async function listOutputJsonFiles() {
  try {
    const names = await fs.readdir(outputDir);
    return names
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(outputDir, name));
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
}

async function fetchOperationStatus(page, operationId, authToken) {
  const url = `https://label.teksher.kg/facade/api/v1/operations/${encodeURIComponent(operationId)}`;
  return page.evaluate(async ({ requestUrl, token }) => {
    const response = await fetch(requestUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return {
      httpStatus: response.status,
      ok: response.ok,
      statusText: response.statusText,
      body: json ?? text,
    };
  }, { requestUrl: url, token: authToken });
}

async function checkCreatedOperationStatuses(page, context) {
  const apiResponsePath = path.join(outputDir, "api_response.json");
  const statusCheckPath = path.join(outputDir, "api_status_check.json");

  const apiResponse = await readJsonFile(apiResponsePath);
  const createdOperations = extractCreatedOperations(apiResponse);
  if (createdOperations.length === 0) {
    await pauseForManual(page, "api_status_check", `no operationId -> gtin mappings found in ${apiResponsePath}`);
    return false;
  }

  const tokenCandidate = await extractBearerToken(page, context);
  if (!tokenCandidate) {
    await pauseForManual(page, "api_status_check_auth", "could not find Bearer/JWT token for status check");
    return false;
  }

  const results = [];
  for (const operation of createdOperations) {
    console.log(`checking operation ${operation.operationId} for gtin ${operation.gtin}`);
    try {
      const response = await fetchOperationStatus(page, operation.operationId, tokenCandidate.token);
      const summary = summarizeOperationStatusBody(response.body);
      results.push({
        operationId: operation.operationId,
        gtin: operation.gtin,
        httpStatus: response.httpStatus,
        status: summary.status || String(response.httpStatus),
        createdAt: summary.createdAt,
        result: summary.result,
        message: summary.message,
        body: response.body,
      });
    } catch (err) {
      results.push({
        operationId: operation.operationId,
        gtin: operation.gtin,
        httpStatus: 0,
        status: "ERROR",
        createdAt: "",
        result: "",
        message: err.message,
        body: null,
      });
    }
  }

  const output = {
    source: apiResponsePath,
    checkedAt: new Date().toISOString(),
    endpoint: "https://label.teksher.kg/facade/api/v1/operations/{operationId}",
    operations: results,
  };

  await fs.writeFile(statusCheckPath, JSON.stringify(output, null, 2), "utf8");
  console.log(`api status check saved: ${statusCheckPath}`);
  console.table(results.map((row) => ({
    operationId: row.operationId,
    gtin: row.gtin,
    status: row.status,
    "createdAt/result/message": [row.createdAt, row.result, row.message].filter(Boolean).join(" | "),
  })));
  return true;
}

async function submitNewMultiOperationApi(page, context) {
  if (!page.url().startsWith("https://label.teksher.kg/")) {
    console.log(`API workflow needs label.teksher.kg origin; current URL is ${page.url()}`);
    const operationsOk = await gotoOperationsWithRetry(page, "api_prepare_operations");
    if (!operationsOk || !(await waitForOperations(page, 30000))) {
      await pauseForManual(page, "api_prepare_operations", "could not prepare label.teksher.kg operations page before API fetch");
      return false;
    }
  }

  const tokenCandidate = await extractBearerToken(page, context);
  if (!tokenCandidate) {
    await pauseForManual(page, "api_auth_token", "could not find Bearer/JWT token in localStorage/sessionStorage/cookies");
    return false;
  }

  const token = tokenCandidate.token;
  const payload = buildMultiOperationPayloadFor(newItems);
  const requestPath = path.join(outputDir, "next_api_request.json");
  const responsePath = path.join(outputDir, "next_api_response.json");
  await fs.writeFile(requestPath, JSON.stringify({
    url: `https://label.teksher.kg${MULTI_OPERATION_API_PATH}`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.slice(0, 12)}...${token.slice(-8)}`,
      "Content-Type": "application/json",
    },
    payload,
  }, null, 2), "utf8");
  console.log(`api request saved: ${requestPath}`);

  const apiResult = await page.evaluate(async ({ apiUrl, authToken, body }) => {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
      body: json ?? text,
    };
  }, { apiUrl: `https://label.teksher.kg${MULTI_OPERATION_API_PATH}`, authToken: token, body: payload });

  await fs.writeFile(responsePath, JSON.stringify(apiResult, null, 2), "utf8");
  console.log(`api response saved: ${responsePath}`);
  console.log(`status: ${apiResult.status} ${apiResult.statusText}`);
  console.log("response body:");
  console.log(typeof apiResult.body === "string" ? apiResult.body : JSON.stringify(apiResult.body, null, 2));

  const operationIds = findCreatedOperationIds(apiResult.body);
  if (operationIds.length) console.log(`created operation id: ${operationIds.join(", ")}`);
  if (!apiResult.ok) {
    await pauseForManual(page, "api_multi_operation", `API returned non-OK status ${apiResult.status}`);
    return false;
  }
  return true;
}

async function checkNewOperationStatuses(page, context) {
  const apiResponsePath = path.join(outputDir, "next_api_response.json");
  const statusCheckPath = path.join(outputDir, "next_api_status_check.json");

  const apiResponse = await readJsonFile(apiResponsePath);
  const createdOperations = extractCreatedOperations(apiResponse);
  if (createdOperations.length === 0) {
    await pauseForManual(page, "new_api_status_check", `no operationId -> gtin mappings found in ${apiResponsePath}`);
    return false;
  }

  const tokenCandidate = await extractBearerToken(page, context);
  if (!tokenCandidate) {
    await pauseForManual(page, "new_api_status_check_auth", "could not find Bearer/JWT token for new order status check");
    return false;
  }

  const results = [];
  for (const operation of createdOperations) {
    console.log(`checking new operation ${operation.operationId} for gtin ${operation.gtin}`);
    try {
      const response = await fetchOperationStatus(page, operation.operationId, tokenCandidate.token);
      const summary = summarizeOperationStatusBody(response.body);
      results.push({
        operationId: operation.operationId,
        gtin: operation.gtin,
        httpStatus: response.httpStatus,
        status: summary.status || String(response.httpStatus),
        createdAt: summary.createdAt,
        result: summary.result,
        message: summary.message,
        body: response.body,
      });
    } catch (err) {
      results.push({
        operationId: operation.operationId,
        gtin: operation.gtin,
        httpStatus: 0,
        status: "ERROR",
        createdAt: "",
        result: "",
        message: err.message,
        body: null,
      });
    }
  }

  const output = {
    source: apiResponsePath,
    checkedAt: new Date().toISOString(),
    endpoint: "https://label.teksher.kg/facade/api/v1/operations/{operationId}",
    operations: results,
  };

  await fs.writeFile(statusCheckPath, JSON.stringify(output, null, 2), "utf8");
  console.log(`next api status check saved: ${statusCheckPath}`);
  console.table(results.map((row) => ({
    operationId: row.operationId,
    gtin: row.gtin,
    quantity: newItems.find(([gtin]) => gtin === row.gtin)?.[1] ?? "",
    status: row.status,
    "createdAt/result/message": [row.createdAt, row.result, row.message].filter(Boolean).join(" | "),
  })));
  return true;
}

async function ensureBatchRelogin(page) {
  console.log("Access token is missing or expired. Please log in again in the browser window.");
  if (!page.url().includes("/login")) {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((err) => {
      console.error(`could not open login page: ${err.message}`);
    });
  }
  await saveStep(page, "batch_manual_login_page");
  const ok = await waitForOperations(page, 10 * 60 * 1000);
  if (!ok) {
    await pauseForManual(page, "batch_manual_login", "manual relogin timed out; URL did not become /operations and text Операции did not appear");
    return false;
  }
  await saveStep(page, "batch_manual_login_saved");
  return true;
}

async function ensureBatchAuth(page, context) {
  const tokenCandidate = await extractBearerToken(page, context);
  if (tokenCandidate) return tokenCandidate.token;
  const reloginOk = await ensureBatchRelogin(page);
  if (!reloginOk) return null;
  const refreshed = await extractBearerToken(page, context);
  return refreshed ? refreshed.token : null;
}

async function submitBatchOrderApi(page, context, batchItems, requestPath, responsePath, label) {
  const payload = buildMultiOperationPayloadFor(batchItems);
  const prefix = label ? `${label} ` : "";

  const performPost = async (token) => {
    await writeJsonFile(requestPath, {
      url: `https://label.teksher.kg${MULTI_OPERATION_API_PATH}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.slice(0, 12)}...${token.slice(-8)}`,
        "Content-Type": "application/json",
      },
      payload,
    });
    console.log(`${prefix}api request saved: ${requestPath}`);
    return executeJsonFetch(page, {
      url: `https://label.teksher.kg${MULTI_OPERATION_API_PATH}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: payload,
    });
  };

  let token = await ensureBatchAuth(page, context);
  if (!token) return null;

  let apiResult = await performPost(token);
  if (isAuthFailureStatus(apiResult.status)) {
    console.log(`POST returned ${apiResult.status}; prompting for manual relogin.`);
    const reloginOk = await ensureBatchRelogin(page);
    if (!reloginOk) return null;
    token = await ensureBatchAuth(page, context);
    if (!token) return null;
    apiResult = await performPost(token);
  }

  await writeJsonFile(responsePath, apiResult);
  console.log(`${prefix}api response saved: ${responsePath}`);
  console.log(`status: ${apiResult.status} ${apiResult.statusText}`);
  console.log("response body:");
  console.log(typeof apiResult.body === "string" ? apiResult.body : JSON.stringify(apiResult.body, null, 2));

  if (!apiResult.ok) {
    await pauseForManual(page, "batch_api_post", `batch POST returned non-OK status ${apiResult.status}`);
    return null;
  }

  const operationIds = findCreatedOperationIds(apiResult.body);
  if (operationIds.length) console.log(`created operation id: ${operationIds.join(", ")}`);
  return { apiResult, requestPath, responsePath, operationIds };
}

async function checkBatchOperationStatuses(page, context, batchItems, apiResponsePath, statusCheckPath, label) {
  const batchMap = new Map(batchItems.map(([gtin, quantity]) => [gtin, quantity]));
  const prefix = label ? `${label} ` : "";

  const apiResponse = await readJsonFile(apiResponsePath);
  const createdOperations = extractCreatedOperations(apiResponse);
  if (createdOperations.length === 0) {
    await pauseForManual(page, "batch_status_check", `no operationId -> gtin mappings found in ${apiResponsePath}`);
    return false;
  }

  let token = await ensureBatchAuth(page, context);
  if (!token) return false;

  const results = [];
  for (const operation of createdOperations) {
    console.log(`checking batch operation ${operation.operationId} for gtin ${operation.gtin}`);
    let response = await executeJsonFetch(page, {
      url: `https://label.teksher.kg/facade/api/v1/operations/${encodeURIComponent(operation.operationId)}`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: null,
    });

    if (isAuthFailureStatus(response.status)) {
      const reloginOk = await ensureBatchRelogin(page);
      if (!reloginOk) return false;
      token = await ensureBatchAuth(page, context);
      if (!token) return false;
      response = await executeJsonFetch(page, {
        url: `https://label.teksher.kg/facade/api/v1/operations/${encodeURIComponent(operation.operationId)}`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: null,
      });
    }

    const summary = summarizeOperationStatusBody(response.body);
    results.push({
      operationId: operation.operationId,
      gtin: operation.gtin,
      quantity: batchMap.get(operation.gtin) ?? "",
      httpStatus: response.status,
      status: summary.status || String(response.status),
      createdAt: summary.createdAt,
      result: summary.result,
      message: summary.message,
      body: response.body,
    });
  }

  const output = {
    source: apiResponsePath,
    checkedAt: new Date().toISOString(),
    endpoint: "https://label.teksher.kg/facade/api/v1/operations/{operationId}",
    operations: results,
  };

  await writeJsonFile(statusCheckPath, output);
  console.log(`${prefix}status saved: ${statusCheckPath}`);
  console.table(results.map((row) => ({
    gtin: row.gtin,
    quantity: row.quantity,
    status: row.status,
  })));
  return results;
}

async function findLatestFailedBatchNumber(maxBatchNumber) {
  const files = await listOutputJsonFiles();
  const candidates = [];

  for (const filePath of files) {
    const name = path.basename(filePath);
    const match = name.match(/^batch_(\d{3})_error_.*\.json$/);
    if (!match) continue;
    const fallbackNumber = Number(match[1]);
    const stat = await fs.stat(filePath).catch(() => null);
    const payload = await readJsonFileIfExists(filePath, {});
    const batchNumber = Number(payload?.batchNumber || fallbackNumber);
    if (!Number.isInteger(batchNumber) || batchNumber < 1 || batchNumber > maxBatchNumber) continue;
    candidates.push({
      batchNumber,
      mtimeMs: stat ? stat.mtimeMs : 0,
      filePath,
    });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] ? candidates[0].batchNumber : 1;
}

async function resolveDiagnoseBatchNumber(maxBatchNumber) {
  const explicit = Number(process.env.ORDER_KM_DIAGNOSE_BATCH || process.env.DIAGNOSE_BATCH_NUMBER || "");
  if (Number.isInteger(explicit) && explicit >= 1 && explicit <= maxBatchNumber) {
    return explicit;
  }
  return findLatestFailedBatchNumber(maxBatchNumber);
}

async function readDiagnoseSuccessRegistry() {
  const existing = await readJsonFileIfExists(diagnoseSuccessPath, null);
  if (existing && typeof existing === "object" && existing.gtins && typeof existing.gtins === "object") {
    return existing;
  }
  return {
    updatedAt: "",
    gtins: {},
  };
}

async function writeDiagnoseSuccessRegistry(registry) {
  registry.updatedAt = new Date().toISOString();
  await writeJsonFile(diagnoseSuccessPath, registry);
}

function addCreatedOperation(createdMap, entry) {
  if (!entry?.gtin || !entry?.operationId) return;
  if (createdMap.has(entry.gtin)) return;
  createdMap.set(entry.gtin, {
    gtin: entry.gtin,
    quantity: entry.quantity ?? "",
    operationId: entry.operationId,
    httpStatus: entry.httpStatus ?? "",
    apiStatus: entry.apiStatus || entry.status || "CREATED",
    message: entry.message || "",
    source: entry.source || "",
  });
}

async function collectAlreadyCreatedGtins() {
  const createdMap = new Map();
  const registry = await readDiagnoseSuccessRegistry();

  for (const entry of Object.values(registry.gtins)) {
    addCreatedOperation(createdMap, {
      ...entry,
      source: entry.source || diagnoseSuccessPath,
    });
  }

  for (const filePath of await listOutputJsonFiles()) {
    const payload = await readJsonFileIfExists(filePath, null).catch(() => null);
    if (!payload || typeof payload !== "object") continue;

    if (Array.isArray(payload.operations)) {
      for (const operation of payload.operations) {
        if (!operation?.gtin || !operation?.operationId || !isHttpOk(operation.httpStatus)) continue;
        addCreatedOperation(createdMap, {
          gtin: String(operation.gtin),
          quantity: operation.quantity ?? "",
          operationId: String(operation.operationId),
          httpStatus: operation.httpStatus,
          apiStatus: operation.status || operation.apiStatus || "CREATED",
          message: operation.message || "",
          source: filePath,
        });
      }
    }

    if (payload.ok === true && isHttpOk(payload.status)) {
      for (const operation of extractCreatedOperations(payload)) {
        addCreatedOperation(createdMap, {
          gtin: operation.gtin,
          operationId: operation.operationId,
          httpStatus: payload.status,
          apiStatus: "CREATED",
          source: filePath,
        });
      }
    }
  }

  return { createdMap, registry };
}

async function fetchOperationStatusWithRetry(page, context, operationId, token) {
  let currentToken = token;
  let response = await executeJsonFetch(page, {
    url: `https://label.teksher.kg/facade/api/v1/operations/${encodeURIComponent(operationId)}`,
    method: "GET",
    headers: {
      Authorization: `Bearer ${currentToken}`,
      "Content-Type": "application/json",
    },
    body: null,
  });

  if (isAuthFailureStatus(response.status)) {
    const reloginOk = await ensureBatchRelogin(page);
    if (!reloginOk) return { response, token: currentToken };
    currentToken = await ensureBatchAuth(page, context);
    if (!currentToken) return { response, token: currentToken };
    response = await executeJsonFetch(page, {
      url: `https://label.teksher.kg/facade/api/v1/operations/${encodeURIComponent(operationId)}`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${currentToken}`,
        "Content-Type": "application/json",
      },
      body: null,
    });
  }

  return { response, token: currentToken };
}

async function postSingleGtinOperation(page, context, gtin, quantity, token, requestPath, responsePath) {
  const payload = buildMultiOperationPayloadFor([[gtin, quantity]]);

  const performPost = async (currentToken) => {
    await writeJsonFile(requestPath, {
      url: `https://label.teksher.kg${MULTI_OPERATION_API_PATH}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${currentToken.slice(0, 12)}...${currentToken.slice(-8)}`,
        "Content-Type": "application/json",
      },
      payload,
    });
    return executeJsonFetch(page, {
      url: `https://label.teksher.kg${MULTI_OPERATION_API_PATH}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${currentToken}`,
        "Content-Type": "application/json",
      },
      body: payload,
    });
  };

  let currentToken = token;
  let response = await performPost(currentToken);
  if (isAuthFailureStatus(response.status)) {
    console.log(`single ${gtin}: POST returned ${response.status}; prompting for manual relogin.`);
    const reloginOk = await ensureBatchRelogin(page);
    if (!reloginOk) {
      await writeJsonFile(responsePath, response);
      return { response, token: currentToken };
    }
    currentToken = await ensureBatchAuth(page, context);
    if (!currentToken) {
      await writeJsonFile(responsePath, response);
      return { response, token: currentToken };
    }
    response = await performPost(currentToken);
  }

  await writeJsonFile(responsePath, response);
  return { response, token: currentToken };
}

async function runDiagnoseBatchWorkflow(page, context) {
  const batches = await readBatches(batchesFilePath);
  if (batches.length === 0) {
    throw new Error(`No batches found in ${batchesFilePath}`);
  }

  const batchNumber = await resolveDiagnoseBatchNumber(batches.length);
  const batch = batches[batchNumber - 1];
  const timestamp = timestampForFilename();
  const batchTag = `batch_${String(batchNumber).padStart(3, "0")}`;
  console.log(`Diagnose timestamp: ${timestamp}`);
  console.log(`Diagnose batches file: ${batchesFilePath}`);
  console.log(`Diagnose failed batch: ${batchTag} (${batch.batchLabel})`);
  console.table(batch.items.map(([gtin, quantity]) => ({ gtin, quantity })));

  await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((err) => {
    console.error(`could not open operations page: ${err.message}`);
  });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  if (!(await isAuthorized(page))) {
    console.log("No active session found. Manual login is required once for this browser profile.");
    const reloginOk = await ensureBatchRelogin(page);
    if (!reloginOk) return false;
  }

  const { createdMap, registry } = await collectAlreadyCreatedGtins();
  let token = await ensureBatchAuth(page, context);
  if (!token) return false;

  const rows = [];
  for (const [gtin, quantity] of batch.items) {
    const alreadyCreated = createdMap.get(gtin);
    if (alreadyCreated) {
      rows.push({
        gtin,
        quantity,
        httpStatus: "SKIPPED",
        apiStatus: alreadyCreated.apiStatus || "CREATED",
        message: `already created: ${alreadyCreated.operationId}`,
      });
      console.log(`single ${gtin}: skipped, already created as ${alreadyCreated.operationId}`);
      continue;
    }

    const baseName = `single_${safeName(gtin)}`;
    const requestPath = path.join(outputDir, `${baseName}_request.json`);
    const responsePath = path.join(outputDir, `${baseName}_response.json`);
    const statusPath = path.join(outputDir, `${baseName}_status.json`);
    console.log(`single ${gtin}: POST quantity=${quantity}`);

    let postResult;
    try {
      const posted = await postSingleGtinOperation(page, context, gtin, quantity, token, requestPath, responsePath);
      postResult = posted.response;
      token = posted.token || token;
    } catch (err) {
      rows.push({
        gtin,
        quantity,
        httpStatus: 0,
        apiStatus: "ERROR",
        message: err.message,
      });
      continue;
    }

    const postSummary = summarizeApiResult(postResult);
    const operation = findOperationForGtin(postResult, gtin);
    if (!postResult.ok || !operation) {
      rows.push({
        gtin,
        quantity,
        httpStatus: postResult.status,
        apiStatus: postSummary.apiStatus,
        message: postSummary.message || (!operation ? "operation id not found in response" : ""),
      });
      continue;
    }

    const checked = await fetchOperationStatusWithRetry(page, context, operation.operationId, token);
    token = checked.token || token;
    await writeJsonFile(statusPath, checked.response);
    const statusSummary = summarizeApiResult(checked.response);
    const apiStatus = statusSummary.apiStatus || postSummary.apiStatus;
    const message = statusSummary.message || postSummary.message;

    registry.gtins[gtin] = {
      gtin,
      quantity,
      operationId: operation.operationId,
      httpStatus: postResult.status,
      apiStatus,
      message,
      statusHttpStatus: checked.response.status,
      requestPath,
      responsePath,
      statusPath,
      source: "diagnose-batch",
      updatedAt: new Date().toISOString(),
    };
    await writeDiagnoseSuccessRegistry(registry);
    addCreatedOperation(createdMap, registry.gtins[gtin]);

    rows.push({
      gtin,
      quantity,
      httpStatus: postResult.status,
      apiStatus,
      message,
    });
  }

  const summaryPath = path.join(outputDir, `${batchTag}_diagnose_summary_${timestamp}.json`);
  await writeJsonFile(summaryPath, {
    batchNumber,
    batchLabel: batch.batchLabel,
    checkedAt: new Date().toISOString(),
    rows,
  });
  console.log(`diagnose summary saved: ${summaryPath}`);
  console.table(rows.map((row) => ({
    gtin: row.gtin,
    quantity: row.quantity,
    httpStatus: row.httpStatus,
    apiStatus: row.apiStatus,
    message: row.message,
  })));
  return true;
}

async function clickText(page, text, stepName) {
  const locator = page.getByText(text, { exact: true });
  const count = await locator.count();
  if (count !== 1) {
    const loose = page.getByText(text, { exact: false });
    const looseCount = await loose.count();
    if (looseCount !== 1) {
      await pauseForManual(page, stepName, `text "${text}" count exact=${count}, loose=${looseCount}`);
      return false;
    }
    await loose.click();
  } else {
    await locator.click();
  }
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await saveStep(page, stepName);
  return true;
}

async function listButtonAndLinks(page) {
  const elements = await page.locator("button,a").evaluateAll((els) => els.map((el, index) => ({
    index,
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
    href: el.getAttribute("href") || "",
    action: el.getAttribute("action") || "",
    type: el.getAttribute("type") || "",
    ariaLabel: el.getAttribute("aria-label") || "",
    title: el.getAttribute("title") || "",
    className: el.getAttribute("class") || "",
    visible: (() => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    })(),
  })));
  console.log("button/a list:");
  console.table(elements.map((el) => ({
    index: el.index,
    tag: el.tag,
    visible: el.visible,
    text: el.text.slice(0, 80),
    href: el.href,
    action: el.action,
    type: el.type,
    ariaLabel: el.ariaLabel,
    title: el.title,
    class: el.className,
  })));
  return elements;
}

async function logOperationsDomState(page, label) {
  const readyState = await page.evaluate(() => document.readyState).catch(() => "unavailable");
  const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  const counts = {
    button: await page.locator("button").count().catch(() => 0),
    a: await page.locator("a").count().catch(() => 0),
    input: await page.locator("input").count().catch(() => 0),
    div: await page.locator("div").count().catch(() => 0),
  };
  console.log(`\n=== operations DOM state: ${label} ===`);
  console.log(`current URL: ${page.url()}`);
  console.log(`document.readyState: ${readyState}`);
  console.table([counts]);
  console.log(`body.innerText first 3000 chars:\n${bodyText.slice(0, 3000)}`);
  return counts;
}

async function waitForOperationsDomReady(page, label) {
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const controls = await extractControls(page).catch(() => []);
  console.log(`${label} controls count: ${controls.length}`);
  await logOperationsDomState(page, label);
  return controls;
}

async function openAddOperationPage(page) {
  if (!new globalThis.URL(page.url()).pathname.includes("/operations")) {
    const operationsGotoOk = await gotoOperationsWithRetry(page, "04_operations");
    const operationsLoaded = operationsGotoOk && await waitForOperations(page, 30000);
    if (!operationsLoaded) {
      await pauseForManual(page, "04_operations", "operations page did not load");
      return false;
    }
  }

  let controls = await waitForOperationsDomReady(page, "04_operations_initial");
  if (controls.length === 0) {
    console.log("operations controls are empty; reloading once before blocking");
    await page.reload({ waitUntil: "networkidle", timeout: 60000 }).catch((err) => {
      console.error(`operations reload failed: ${err.message}`);
    });
    await page.waitForTimeout(3000);
    controls = await waitForOperationsDomReady(page, "04_operations_after_reload");
    if (controls.length === 0) {
      await pauseForManual(page, "operations_empty_dom", "operations DOM controls are still empty after reload");
      return false;
    }
  }

  await saveStep(page, "04_operations");

  const elements = await listButtonAndLinks(page);
  const candidates = elements
    .filter((el) => el.visible)
    .map((el) => {
      const haystack = `${el.text} ${el.href} ${el.action} ${el.ariaLabel} ${el.title} ${el.className}`.toLowerCase();
      let score = 0;
      if (/добавить\s+операц/i.test(el.text)) score += 100;
      if (/^добавить$/i.test(el.text)) score += 70;
      if (el.text.trim() === "+") score += 60;
      if (/(create|add|new)/i.test(`${el.href} ${el.action}`)) score += 40;
      if (/(create|add|new|добав)/i.test(haystack)) score += 20;
      return { ...el, score };
    })
    .filter((el) => el.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const best = candidates[0];
  if (!best) {
    await pauseForManual(page, "add_operation", "could not find Add operation button/link");
    return false;
  }

  console.log(`click add operation candidate index=${best.index} tag=${best.tag} score=${best.score} text="${best.text}" href="${best.href}"`);
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    page.locator("button,a").nth(best.index).click(),
  ]);
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await saveStep(page, "05_add_operation_page");
  return true;
}

async function logSelectOptions(page) {
  const selectData = await page.locator("select").evaluateAll((selects) => selects.map((select, selectIndex) => ({
    selectIndex,
    name: select.getAttribute("name") || "",
    id: select.getAttribute("id") || "",
    ariaLabel: select.getAttribute("aria-label") || "",
    className: select.getAttribute("class") || "",
    visible: (() => {
      const rect = select.getBoundingClientRect();
      const style = window.getComputedStyle(select);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    })(),
    options: Array.from(select.options).map((option, optionIndex) => ({
      optionIndex,
      text: (option.innerText || option.textContent || "").replace(/\s+/g, " ").trim(),
      value: option.value || "",
    })),
  })));

  for (const select of selectData) {
    console.log(`select[${select.selectIndex}] name="${select.name}" id="${select.id}" visible=${select.visible}`);
    console.table(select.options);
  }
  return selectData;
}

async function selectNativeProductGroup(page) {
  const selectData = await logSelectOptions(page);
  for (const select of selectData) {
    const option = select.options.find((item) => /предмет|одеж/i.test(item.text));
    if (!option) continue;
    console.log(`select product group via select[${select.selectIndex}] option text="${option.text}" value="${option.value}"`);
    await page.locator("select").nth(select.selectIndex).selectOption({ value: option.value });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await saveStep(page, "product_group_selected");
    return true;
  }
  return false;
}

async function findProductGroupControls(page) {
  const selector = "select,input,[role='combobox'],button,div";
  const controls = await page.locator(selector).evaluateAll((els) => els.map((el, index) => {
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    const attrs = [
      el.getAttribute("placeholder") || "",
      el.getAttribute("aria-label") || "",
      el.getAttribute("name") || "",
      el.getAttribute("id") || "",
      el.getAttribute("title") || "",
      el.getAttribute("class") || "",
    ].join(" ");
    const labels = el.labels ? Array.from(el.labels).map((label) => label.innerText || label.textContent || "").join(" ") : "";
    const parentText = (el.parentElement?.innerText || el.parentElement?.textContent || "").replace(/\s+/g, " ").trim();
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    const haystack = `${text} ${attrs} ${labels} ${parentText}`.toLowerCase();
    let score = 0;
    if (/товарная\s+группа/i.test(haystack)) score += 100;
    if (/(product\s*group)/i.test(haystack)) score += 90;
    if (/(^|\s)группа($|\s)/i.test(haystack)) score += 30;
    if (["select", "input", "button"].includes(el.tagName.toLowerCase())) score += 10;
    if (el.getAttribute("role") === "combobox") score += 20;
    return {
      index,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      text: text.slice(0, 120),
      placeholder: el.getAttribute("placeholder") || "",
      name: el.getAttribute("name") || "",
      id: el.getAttribute("id") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      className: el.getAttribute("class") || "",
      visible,
      score,
    };
  }));

  const candidates = controls
    .filter((control) => control.visible && control.score > 0)
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length);
  console.log("product group control candidates:");
  console.table(candidates.map((control) => ({
    index: control.index,
    tag: control.tag,
    role: control.role,
    score: control.score,
    text: control.text,
    placeholder: control.placeholder,
    name: control.name,
    id: control.id,
    ariaLabel: control.ariaLabel,
    class: control.className,
  })));
  return { selector, candidates };
}

async function logVisibleDropdownItems(page, label) {
  const selector = "[role='option'],[role='listitem'],li,option,div,a,button";
  const items = await page.locator(selector).evaluateAll((els) => els.map((el, index) => {
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return {
      index,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      text,
      visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
      className: el.getAttribute("class") || "",
    };
  }));
  const visibleItems = items.filter((item) => item.visible && item.text);
  console.log(`${label} visible dropdown/list items:`);
  console.table(visibleItems.map((item) => ({
    index: item.index,
    tag: item.tag,
    role: item.role,
    text: item.text.slice(0, 140),
    class: item.className,
  })));
  return { selector, items: visibleItems };
}

async function logVisibleProductGroupDebugItems(page) {
  const selector = "button,div,li,option,[role='option'],[role='listitem'],a";
  const items = await page.locator(selector).evaluateAll((els) => els.map((el, index) => {
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return {
      index,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      text,
      visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
      className: el.getAttribute("class") || "",
    };
  }));
  const visibleItems = items.filter((item) => item.visible && item.text);
  console.log("visible button/div/li/option/text:");
  console.table(visibleItems.map((item) => ({
    index: item.index,
    tag: item.tag,
    role: item.role,
    text: item.text.slice(0, 180),
    class: item.className,
  })));

  const bodyText = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
  console.log("visible body text lines:");
  console.table(bodyText
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 200)
    .map((text, index) => ({ index, text: text.slice(0, 180) })));
}

async function waitForProductGroupOptionItems(page, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let lastList = { selector: "[role='option'],[role='listitem'],li,option,div,a,button", items: [] };
  while (Date.now() < deadline) {
    lastList = await logVisibleDropdownItems(page, "product_group_dropdown_poll");
    if (lastList.items.some((item) => /предметы\s+одежды|одежда|одеж/i.test(item.text))) {
      return lastList;
    }
    await page.waitForTimeout(300);
  }
  return lastList;
}

async function clickProductGroupOption(page, items, selector) {
  const option = items
    .filter((item) => /предметы\s+одежды|одежда|одеж/i.test(item.text))
    .map((item) => {
      let score = 0;
      if (/^предметы\s+одежды$/i.test(item.text)) score += 100;
      if (/^одежда$/i.test(item.text)) score += 90;
      if (/предметы\s+одежды/i.test(item.text)) score += 70;
      if (/одеж/i.test(item.text)) score += 40;
      if (["option", "li", "a", "button"].includes(item.tag) || item.role === "option") score += 20;
      if (item.tag === "div") score -= 10;
      return { ...item, score };
    })
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length)[0];
  if (!option) return false;
  console.log(`click product group option index=${option.index} score=${option.score} text="${option.text}"`);
  await page.locator(selector).nth(option.index).click({ timeout: 5000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await saveStep(page, "product_group_selected");
  return true;
}

async function searchProductGroupOption(page) {
  const searchInput = page.locator("input:visible,textarea:visible,[contenteditable='true']:visible").last();
  if ((await searchInput.count()) < 1) return false;
  await searchInput.fill("одеж").catch(async () => {
    await searchInput.click();
    await page.keyboard.type("одеж");
  });
  await page.waitForTimeout(700);
  const { selector, items } = await logVisibleDropdownItems(page, "dropdown_search");
  return clickProductGroupOption(page, items, selector);
}

async function selectCustomProductGroup(page) {
  const { selector, candidates } = await findProductGroupControls(page);
  for (const candidate of candidates) {
    console.log(`open product group dropdown candidate index=${candidate.index} tag=${candidate.tag} score=${candidate.score}`);
    const clicked = await page.locator(selector).nth(candidate.index).click({ timeout: 5000 }).then(() => true).catch((err) => {
      console.error(`product group dropdown click failed within 5s: ${err.message}`);
      return false;
    });
    await saveStep(page, "product_group_dropdown_after_click");
    if (!clicked) {
      await logVisibleProductGroupDebugItems(page);
      await pauseForManual(page, "product_group_dropdown_timeout", "product group dropdown click timed out or failed");
      return false;
    }

    const list = await waitForProductGroupOptionItems(page, 5000);
    if (!(await clickProductGroupOption(page, list.items, list.selector))) {
      await logVisibleProductGroupDebugItems(page);
      await pauseForManual(page, "product_group_dropdown_timeout", 'option "Предметы одежды" was not found within 5 seconds after opening dropdown');
      return false;
    }
    return true;
  }
  return false;
}

async function clickChooseProduct(page) {
  const choose = page
    .getByRole("button", { name: /выбрать\s+товар/i })
    .or(page.locator("button,a").filter({ hasText: /выбрать\s+товар/i }))
    .first();
  if (!(await choose.isVisible().catch(() => false))) {
    await pauseForManual(page, "choose_product", 'could not find "Выбрать товар" button');
    return false;
  }
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    choose.click(),
  ]);
  const modalOpened = await page.waitForSelector(
    'input, table, [role="dialog"], .modal, [class*="modal"], [class*="dialog"]',
    { timeout: 10000 },
  ).then(() => true).catch(() => false);

  if (!modalOpened) {
    await pauseForManual(page, "choose_product_modal_not_opened", 'after clicking "Выбрать товар", no modal/dialog/table/search appeared');
    return false;
  }

  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(700);
  await saveStep(page, "choose_product_modal_opened");
  await logChooseProductModalDiagnostics(page);
  return true;
}

async function logChooseProductModalDiagnostics(page) {
  const modals = await page.locator('[role="dialog"],.modal,[class*="modal"],[class*="dialog"]').evaluateAll((els) => els.map((el, index) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return {
      index,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      id: el.getAttribute("id") || "",
      className: el.getAttribute("class") || "",
      visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
      text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
    };
  })).catch(() => []);
  console.log("choose product dialog/modal elements:");
  console.table(modals);

  const inputs = await page.locator("input,textarea").evaluateAll((els) => els.map((el, index) => ({
    index,
    type: el.getAttribute("type") || "",
    name: el.getAttribute("name") || "",
    id: el.getAttribute("id") || "",
    placeholder: el.getAttribute("placeholder") || "",
    className: el.getAttribute("class") || "",
    value: el.value || "",
  }))).catch(() => []);
  console.log("choose product inputs:");
  console.table(inputs);

  const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  console.log(`choose product body.innerText first 5000 chars:\n${bodyText.slice(0, 5000)}`);
}

async function logReactProductGroupOptions(page) {
  const options = await page.locator("[id*='react-select-operationOrderForm-productGroup-option']").evaluateAll((els) => els.map((el, index) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return {
      index,
      id: el.getAttribute("id") || "",
      text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
      visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
      className: el.getAttribute("class") || "",
    };
  }));
  console.log("react product group options:");
  console.table(options.map((option) => ({
    index: option.index,
    id: option.id,
    visible: option.visible,
    text: option.text,
    class: option.className,
  })));
  return options;
}

async function productGroupSelected(page) {
  return page.getByText(/предметы\s+одежды|одежда|одеж/i).first().isVisible().catch(() => false);
}

async function selectReactProductGroup(page) {
  const input = page.locator("#react-select-operationOrderForm-productGroup-input");
  if (!(await input.isVisible({ timeout: 5000 }).catch(() => false))) {
    await pauseForManual(page, "product_group", "react select productGroup input is not visible");
    return false;
  }

  await input.click({ timeout: 5000 });
  await input.fill("одеж").catch(async () => {
    await page.keyboard.type("одеж");
  });
  await page.waitForTimeout(700);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);

  if (await productGroupSelected(page)) {
    await saveStep(page, "product_group_selected");
    return true;
  }

  await saveStep(page, "product_group_after_search");
  const options = await logReactProductGroupOptions(page);
  const option = options.find((item) => item.visible && /одеж|предмет/i.test(item.text));
  if (!option) {
    await pauseForManual(page, "product_group", 'react select option containing "одеж" or "Предмет" was not found');
    return false;
  }

  await page.locator("[id*='react-select-operationOrderForm-productGroup-option']").nth(option.index).click({ timeout: 5000 });
  await page.waitForTimeout(700);
  if (!(await productGroupSelected(page))) {
    await pauseForManual(page, "product_group", "product group option was clicked, but selected text did not appear");
    return false;
  }

  await saveStep(page, "product_group_selected");
  return true;
}

async function selectProductGroup(page) {
  await saveStep(page, "07_before_product_group");
  if (!(await selectReactProductGroup(page))) {
    return false;
  }
  return clickChooseProduct(page);
}

async function getInputRows(page) {
  return page.locator("input,textarea,[contenteditable='true']").evaluateAll((els) => els.map((el, index) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    return {
      index,
      tag,
      type: el.getAttribute("type") || "",
      name: el.getAttribute("name") || "",
      id: el.getAttribute("id") || "",
      placeholder: el.getAttribute("placeholder") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      className: el.getAttribute("class") || "",
      value: tag === "input" || tag === "textarea" ? el.value || "" : el.textContent || "",
      visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
      disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
    };
  }));
}

async function logAllInputs(page, label) {
  const inputs = await getInputRows(page).catch(() => []);
  console.log(`${label} inputs:`);
  console.table(inputs.map((input) => ({
    index: input.index,
    tag: input.tag,
    type: input.type,
    visible: input.visible,
    disabled: input.disabled,
    name: input.name,
    id: input.id,
    placeholder: input.placeholder,
    ariaLabel: input.ariaLabel,
    class: input.className,
    value: String(input.value).slice(0, 80),
  })));
  return inputs;
}

async function openItemFilters(page) {
  const filterButton = page
    .getByRole("button", { name: /фильтры/i })
    .or(page.locator("button,a").filter({ hasText: /^Фильтры$/i }))
    .first();
  if (await filterButton.isVisible().catch(() => false)) {
    await filterButton.click({ timeout: 5000 }).catch((err) => {
      console.error(`could not click filters button: ${err.message}`);
    });
    await page.waitForTimeout(700);
  }
}

async function findItemSearchInput(page) {
  await openItemFilters(page);
  const inputs = await logAllInputs(page, "item_search");
  const candidates = inputs
    .filter((input) => input.visible && !input.disabled && !["hidden", "checkbox", "radio", "submit", "button"].includes(input.type.toLowerCase()))
    .map((input) => {
      const haystack = `${input.name} ${input.id} ${input.placeholder} ${input.ariaLabel} ${input.className}`.toLowerCase();
      let score = 0;
      if (/gtin|штрих|barcode|bar.?code|код/.test(haystack)) score += 100;
      if (/товар|product|item/.test(haystack)) score += 70;
      if (/search|поиск|filter|фильтр/.test(haystack)) score += 50;
      if (["text", "search", ""].includes(input.type.toLowerCase())) score += 10;
      if (input.value) score -= 10;
      return { ...input, score };
    })
    .filter((input) => input.score >= 50)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  console.log("item search input candidates:");
  console.table(candidates.map((input) => ({
    index: input.index,
    score: input.score,
    type: input.type,
    name: input.name,
    id: input.id,
    placeholder: input.placeholder,
    ariaLabel: input.ariaLabel,
    class: input.className,
  })));

  if (!candidates.length) {
    await pauseForManual(page, "item_search_controls", "could not identify item code search/filter input");
    return null;
  }
  return page.locator("input,textarea,[contenteditable='true']").nth(candidates[0].index);
}

async function fillItemSearch(page, searchInput, code) {
  await searchInput.click({ timeout: 5000 });
  await searchInput.fill("").catch(async () => {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Backspace");
  });
  await searchInput.fill(code).catch(async () => {
    await page.keyboard.type(code);
  });
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
}

async function logItemSearchResultRows(page, code) {
  const rows = await page.locator("tr,[role='row'],li,[role='option'],tbody div,[class*='row'],div").evaluateAll((els, itemCode) => els.map((el, index) => {
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return {
      index,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      text,
      visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
      className: el.getAttribute("class") || "",
      hasCode: text.includes(itemCode),
      hasDigits: /\d{8,}/.test(text),
    };
  }), code);
  const matches = rows.filter((row) => row.visible && (row.hasCode || row.hasDigits));
  console.log(`item search result rows/elements for ${code}:`);
  console.table(matches.map((row) => ({
    index: row.index,
    tag: row.tag,
    role: row.role,
    hasCode: row.hasCode,
    text: row.text.slice(0, 220),
    class: row.className,
  })));
  return matches;
}

async function rowSelectionState(rowLocator) {
  const input = rowLocator.locator("input[type='checkbox'],input[type='radio']").first();
  const inputVisible = await input.isVisible().catch(() => false);
  const inputChecked = inputVisible ? await input.isChecked().catch(() => false) : false;
  const ariaSelected = await rowLocator.getAttribute("aria-selected").catch(() => null);
  const className = await rowLocator.getAttribute("class").catch(() => "");
  return {
    inputVisible,
    inputChecked,
    ariaSelected,
    className,
    selected: inputChecked || ariaSelected === "true" || /selected|active|checked/i.test(className || ""),
  };
}

async function logItemSelectableInputs(page, code) {
  const inputs = await page.locator("input[type='checkbox'],input[type='radio']").evaluateAll((els, itemCode) => els.map((el, index) => {
    const container = el.closest("tr,[role='row'],li,[role='option'],[class*='row'],[class*='card'],div") || el.parentElement;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return {
      index,
      type: el.getAttribute("type") || "",
      checked: Boolean(el.checked),
      value: el.value || "",
      name: el.getAttribute("name") || "",
      id: el.getAttribute("id") || "",
      className: el.getAttribute("class") || "",
      visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
      parentText: (container?.innerText || container?.textContent || "").replace(/\s+/g, " ").trim(),
      parentHasCode: ((container?.innerText || container?.textContent || "")).includes(itemCode),
    };
  }), code);
  console.log(`checkbox/radio inputs before choose ${code}:`);
  console.table(inputs.map((input) => ({
    index: input.index,
    type: input.type,
    visible: input.visible,
    checked: input.checked,
    value: input.value,
    name: input.name,
    id: input.id,
    class: input.className,
    parentHasCode: input.parentHasCode,
    parentText: input.parentText.slice(0, 220),
  })));
  return inputs;
}

async function getRowStateSnapshot(rowLocator) {
  return rowLocator.evaluate((el) => ({
    className: el.getAttribute("class") || "",
    style: el.getAttribute("style") || "",
    ariaSelected: el.getAttribute("aria-selected") || "",
    ariaChecked: el.getAttribute("aria-checked") || "",
  })).catch(() => ({}));
}

async function chooseFoundItemRow(page, code) {
  await saveStep(page, `item_search_results_${code}`);
  await logItemSearchResultRows(page, code);

  const rowLocator = page
    .locator("tr,[role='row'],li,[role='option'],tbody div,[class*='row'],div")
    .filter({ hasText: code })
    .first();
  if (!(await rowLocator.isVisible().catch(() => false))) {
    await saveStep(page, `item_${code}_not_found`);
    await pauseForManual(page, "item_not_found", `could not find row containing item code ${code}`);
    return false;
  }

  await logItemSelectableInputs(page, code);
  const beforeState = await getRowStateSnapshot(rowLocator);
  const selectable = rowLocator.locator("input[type='checkbox'],input[type='radio']").first();
  if (await selectable.isVisible().catch(() => false)) {
    await selectable.check({ timeout: 5000 }).catch(async () => {
      await selectable.click({ timeout: 5000 });
    });
  } else {
    await rowLocator.click({ timeout: 5000 });
    await page.waitForTimeout(300);
    await rowLocator.dblclick({ timeout: 5000 }).catch(() => {});
  }
  await page.waitForTimeout(500);
  const afterState = await getRowStateSnapshot(rowLocator);
  console.log(`item row state before click ${code}: ${JSON.stringify(beforeState)}`);
  console.log(`item row state after click ${code}: ${JSON.stringify(afterState)}`);

  const state = await rowSelectionState(rowLocator);
  console.log(`item row selection state for ${code}: ${JSON.stringify(state)}`);
  if (!state.selected) {
    await rowLocator.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
  const stateAfterRetry = await rowSelectionState(rowLocator);
  if (!stateAfterRetry.selected) console.warn(`row for ${code} was clicked, but selected/checked state was not detected`);

  const chooseButton = page
    .getByRole("button", { name: /^Выбрать$/i })
    .or(page.locator("button,a").filter({ hasText: /^Выбрать$/i }))
    .first();
  const chooseEnabled = await chooseButton.isEnabled().catch(() => false);
  const gtinButtonVisible = await page.getByRole("button", { name: new RegExp(`GTIN:\\s*${code}`, "i") }).isVisible().catch(() => false);
  const rowStillVisible = await rowLocator.isVisible().catch(() => false);
  console.log(`item choose readiness for ${code}: chooseEnabled=${chooseEnabled}, gtinButtonVisible=${gtinButtonVisible}, rowStillVisible=${rowStillVisible}`);

  return true;
}

async function clickChooseItemAndVerify(page, code) {
  await saveStep(page, `item_before_choose_${code}`);
  await logItemSelectableInputs(page, code);
  if (!(await clickExactButton(page, "Выбрать", "item_choose_button"))) return false;
  await page.waitForTimeout(1500);
  await saveStep(page, `item_after_choose_${code}`);
  const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  console.log(`body.innerText first 5000 chars after choose ${code}:\n${bodyText.slice(0, 5000)}`);
  if (!bodyText.includes(code)) {
    await saveHtmlAndScreenshot(
      page,
      path.join(screenshotsDir, `item_modal_debug_${code}.html`),
      path.join(screenshotsDir, `item_modal_debug_${code}.png`),
    );
    console.log(`item modal debug body.innerText first 5000 chars:\n${bodyText.slice(0, 5000)}`);
    await logItemSelectableInputs(page, code);
    await logAllInputs(page, "item_not_added_after_choose");
    await logFormControls(page, "item_not_added_after_choose");
    await pauseForManual(page, "item_not_added_after_choose", `item code ${code} did not appear on form after pressing Выбрать`);
    return false;
  }
  return true;
}

async function waitForManualItemSelection(page, code) {
  console.log(`MANUAL ACTION REQUIRED: выберите товар ${code} вручную и нажмите "Выбрать".`);
  await saveStep(page, `item_manual_select_ready_${code}`);
  const modalSelector = '[role="dialog"],.modal,[class*="modal"],[class*="dialog"]';
  await Promise.race([
    page.locator(modalSelector).first().waitFor({ state: "hidden", timeout: 10 * 60 * 1000 }),
    page.waitForFunction((itemCode) => document.body.innerText.includes(itemCode), code, { timeout: 10 * 60 * 1000 }),
  ]).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await saveStep(page, `item_after_manual_choose_${code}`);
  const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  console.log(`body.innerText first 5000 chars after manual choose ${code}:\n${bodyText.slice(0, 5000)}`);
  if (!bodyText.includes(code)) {
    await pauseForManual(page, "item_not_added_after_manual_choose", `item code ${code} did not appear on form after manual selection`);
    return false;
  }
  return true;
}

async function clickExactButton(page, name, step) {
  const button = page
    .getByRole("button", { name: new RegExp(`^${name}$`, "i") })
    .or(page.locator("button,a").filter({ hasText: new RegExp(`^${name}$`, "i") }))
    .first();
  if (!(await button.isVisible().catch(() => false))) {
    await pauseForManual(page, step, `could not find button "${name}"`);
    return false;
  }
  await button.click({ timeout: 5000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(700);
  return true;
}

async function findSelectedItemRow(page, code) {
  const selector = "tr,[role='row'],tbody div,[class*='row'],div";
  const row = page.locator(selector).filter({ hasText: code }).first();
  if (await row.isVisible().catch(() => false)) return row;

  const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  console.log(`body.innerText first 5000 chars:\n${bodyText.slice(0, 5000)}`);
  await pauseForManual(page, "item_row_not_found", `could not find selected item row/container containing code ${code}`);
  return null;
}

async function describeQuantityInput(quantityInput) {
  return quantityInput.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || "",
      name: el.getAttribute("name") || "",
      id: el.getAttribute("id") || "",
      placeholder: el.getAttribute("placeholder") || "",
      className: el.getAttribute("class") || "",
      value: el.value || "",
      disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
      visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
    };
  }).catch((err) => ({ error: err.message }));
}

async function findQuantityInputInRow(page, code) {
  const row = await findSelectedItemRow(page, code);
  if (!row) return null;
  const inputs = row.locator("input");
  const count = await inputs.count().catch(() => 0);
  console.log(`quantity row for ${code} input count: ${count}`);
  for (let i = 0; i < count; i += 1) {
    const input = inputs.nth(i);
    const info = await describeQuantityInput(input);
    console.log(`row input[${i}]: ${JSON.stringify(info)}`);
    if (!info.disabled && info.type !== "hidden") return input;
  }

  await pauseForManual(page, "item_quantity_controls", `selected item row for ${code} has no enabled quantity input`);
  return null;
}

async function setItemQuantity(page, code, quantity) {
  await saveStep(page, "item_quantity_page");
  await logAllInputs(page, "item_quantity_all");
  const quantityInput = await findQuantityInputInRow(page, code);
  if (!quantityInput) {
    return null;
  }
  const expected = String(quantity);
  await quantityInput.evaluate((el, value) => {
    el.value = value;
    for (const eventName of ["input", "change", "blur"]) {
      el.dispatchEvent(new Event(eventName, { bubbles: true }));
    }
  }, expected);
  await page.waitForTimeout(500);
  const actual = await quantityInput.evaluate((el) => {
    return el.value || "";
  }).catch(() => "");
  if (actual.trim() !== expected) {
    const inputInfo = await describeQuantityInput(quantityInput);
    console.error(`quantity input value mismatch: expected="${expected}" actual="${actual}"`);
    console.log(`quantity input used: ${JSON.stringify(inputInfo)}`);
    await pauseForManual(page, "item_quantity_value", `quantity input value did not match requested quantity; used field ${JSON.stringify(inputInfo)}`);
    return null;
  }
  return quantityInput;
}

async function logFormControls(page, label) {
  const rows = await page.locator("input,select,button").evaluateAll((els) => els.map((el, index) => {
    const tag = el.tagName.toLowerCase();
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const value = tag === "select"
      ? Array.from(el.selectedOptions || []).map((option) => option.value || option.textContent || "").join(", ")
      : el.value || "";
    return {
      index,
      tag,
      type: el.getAttribute("type") || "",
      value,
      disabled: Boolean(el.disabled),
      ariaDisabled: el.getAttribute("aria-disabled") || "",
      name: el.getAttribute("name") || "",
      id: el.getAttribute("id") || "",
      placeholder: el.getAttribute("placeholder") || "",
      className: el.getAttribute("class") || "",
      text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
      visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
    };
  }));
  console.log(`${label} input/select/button diagnostics:`);
  console.table(rows.map((row) => ({
    index: row.index,
    tag: row.tag,
    type: row.type,
    visible: row.visible,
    value: String(row.value).slice(0, 80),
    disabled: row.disabled,
    "aria-disabled": row.ariaDisabled,
    name: row.name,
    id: row.id,
    placeholder: row.placeholder,
    class: row.className,
    text: row.text.slice(0, 100),
  })));
  return rows;
}

async function findConfirmItemButton(page) {
  return page
    .getByRole("button", { name: /^(добавить|подтвердить|сохранить|выбрать|ок)$/i })
    .or(page.locator("button,a").filter({ hasText: /^(Добавить|Подтвердить|Сохранить|Выбрать|ОК)$/i }))
    .first();
}

async function dispatchQuantityEvents(quantityInput) {
  await quantityInput.evaluate((el) => {
    for (const eventName of ["input", "change", "blur"]) {
      el.dispatchEvent(new Event(eventName, { bubbles: true }));
    }
  }).catch((err) => {
    console.error(`could not dispatch quantity events: ${err.message}`);
  });
}

async function confirmItemQuantity(page, quantityInput) {
  await saveStep(page, "quantity_before_confirm");
  await logFormControls(page, "quantity_before_confirm");
  const confirm = page
    .getByRole("button", { name: /^(добавить|подтвердить|сохранить|выбрать|ок)$/i })
    .or(page.locator("button,a").filter({ hasText: /^(Добавить|Подтвердить|Сохранить|Выбрать|ОК)$/i }))
    .first();
  if (!(await confirm.isVisible().catch(() => false))) {
    await pauseForManual(page, "item_confirm_controls", "could not find confirm/add button after quantity input");
    return false;
  }

  let enabled = await confirm.isEnabled().catch(() => false);
  const ariaDisabled = await confirm.getAttribute("aria-disabled").catch(() => null);
  if (!enabled || ariaDisabled === "true") {
    await dispatchQuantityEvents(quantityInput);
    await page.waitForTimeout(500);
    enabled = await confirm.isEnabled().catch(() => false);
  }

  if (!enabled || (await confirm.getAttribute("aria-disabled").catch(() => null)) === "true") {
    await logFormControls(page, "quantity_confirm_disabled");
    await pauseForManual(page, "quantity_confirm_disabled", "confirm/add button is still disabled after quantity input and input/change/blur events");
    return false;
  }

  await confirm.click({ timeout: 5000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(700);
  return true;
}

async function automateItemEntry(page) {
  await saveStep(page, "item_select_page");
  let searchInput = await findItemSearchInput(page);
  if (!searchInput) return false;

  for (let i = 0; i < items.length; i += 1) {
    const [code, quantity] = items[i];
    console.log(`select item ${i + 1}/${items.length}: ${code}, quantity=${quantity}`);
    if (!(await searchInput.isVisible().catch(() => false))) {
      if (!(await clickChooseProduct(page))) return false;
      await saveStep(page, `item_${String(i + 1).padStart(2, "0")}_select_page`);
      searchInput = await findItemSearchInput(page);
      if (!searchInput) return false;
    }
    await openItemFilters(page);
    await fillItemSearch(page, searchInput, code);
    if (!(await waitForManualItemSelection(page, code))) return false;
    const quantityInput = await setItemQuantity(page, code, quantity);
    if (!quantityInput) return false;
    if (!(await confirmItemQuantity(page, quantityInput))) return false;
    await saveStep(page, `item_${String(i + 1).padStart(2, "0")}_selected`);
  }

  return true;
}

async function runBatchWorkflow(page, context) {
  const batchItems = await readBatchItems(batchFilePath);
  if (batchItems.length === 0) {
    throw new Error(`No batch items found in ${batchFilePath}`);
  }

  const timestamp = timestampForFilename();
  console.log(`Batch timestamp: ${timestamp}`);
  console.log(`Batch file: ${batchFilePath}`);
  console.table(batchItems.map(([gtin, quantity]) => ({ gtin, quantity })));

  await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((err) => {
    console.error(`could not open operations page: ${err.message}`);
  });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  if (!(await isAuthorized(page))) {
    console.log("No active session found. Manual login is required once for this browser profile.");
    const reloginOk = await ensureBatchRelogin(page);
    if (!reloginOk) return false;
  }

  const requestPath = path.join(outputDir, `batch_api_request_${timestamp}.json`);
  const responsePath = path.join(outputDir, `batch_api_response_${timestamp}.json`);
  const statusPath = path.join(outputDir, `batch_status_${timestamp}.json`);

  const submission = await submitBatchOrderApi(page, context, batchItems, requestPath, responsePath, "batch");
  if (!submission) return false;

  const checked = await checkBatchOperationStatuses(page, context, batchItems, responsePath, statusPath, "batch");
  if (!checked) return false;

  console.log("Batch workflow completed.");
  return true;
}

async function saveBatchErrorFile(batchNumber, timestamp, error) {
  const errorPath = path.join(outputDir, `batch_${String(batchNumber).padStart(3, "0")}_error_${timestamp}.json`);
  const payload = {
    batchNumber,
    timestamp,
    message: error?.message || String(error),
    stack: error?.stack || "",
  };
  await writeJsonFile(errorPath, payload);
  console.log(`batch error saved: ${errorPath}`);
  return errorPath;
}

async function runMultiBatchWorkflow(page, context) {
  const batches = await readBatches(batchesFilePath);
  if (batches.length === 0) {
    throw new Error(`No batches found in ${batchesFilePath}`);
  }

  const timestamp = timestampForFilename();
  console.log(`Multi-batch timestamp: ${timestamp}`);
  console.log(`Batches file: ${batchesFilePath}`);
  console.log(`Batch count: ${batches.length}`);

  await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((err) => {
    console.error(`could not open operations page: ${err.message}`);
  });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  if (!(await isAuthorized(page))) {
    console.log("No active session found. Manual login is required once for this browser profile.");
    const reloginOk = await ensureBatchRelogin(page);
    if (!reloginOk) return false;
  }

  const summaryRows = [];
  for (let index = 0; index < batches.length; index += 1) {
    const batchNumber = index + 1;
    const batch = batches[index];
    const batchTag = `batch_${String(batchNumber).padStart(3, "0")}`;
    const requestPath = path.join(outputDir, `${batchTag}_request_${timestamp}.json`);
    const responsePath = path.join(outputDir, `${batchTag}_response_${timestamp}.json`);
    const statusPath = path.join(outputDir, `${batchTag}_status_${timestamp}.json`);

    console.log(`\n=== ${batchTag} (${batch.batchLabel}) ===`);
    console.table(batch.items.map(([gtin, quantity]) => ({ gtin, quantity })));

    try {
      const submission = await submitBatchOrderApi(page, context, batch.items, requestPath, responsePath, batchTag);
      if (!submission) {
        throw new Error("batch submission failed");
      }

      const checked = await checkBatchOperationStatuses(page, context, batch.items, responsePath, statusPath, batchTag);
      if (!checked) {
        throw new Error("batch status check failed");
      }

      for (const row of checked) {
        summaryRows.push({
          batchNumber,
          gtin: row.gtin,
          quantity: row.quantity,
          status: row.status,
          operationId: row.operationId,
        });
      }
    } catch (error) {
      await saveBatchErrorFile(batchNumber, timestamp, error);
      for (const [gtin, quantity] of batch.items) {
        summaryRows.push({
          batchNumber,
          gtin,
          quantity,
          status: "ERROR",
          operationId: "",
        });
      }
      console.error(`batch ${batchNumber} failed, continuing to next batch: ${error.message}`);
    }

    if (index < batches.length - 1) {
      await page.waitForTimeout(3000);
    }
  }

  console.log("\nOverall batch summary:");
  console.table(summaryRows.map((row) => ({
    batchNumber: row.batchNumber,
    gtin: row.gtin,
    quantity: row.quantity,
    status: row.status,
    operationId: row.operationId,
  })));
  return true;
}

async function main() {
  await ensureDirs();
  console.log(`Using Playwright Chromium: ${chromium.executablePath()}`);
  console.log(`Using Playwright session profile: ${userDataDir}`);
  const mode = process.env.ORDER_KM_MODE || "single";
  console.log(`Workflow mode: ${mode}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    acceptDownloads: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
    env: {
      ...process.env,
      CHROME_CONFIG_HOME: tmpDir,
      XDG_CACHE_HOME: tmpDir,
      XDG_CONFIG_HOME: tmpDir,
      TMPDIR: tmpDir,
    },
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-popup-blocking",
      "--disable-crash-reporter",
      "--disable-crashpad",
      "--disable-breakpad",
      "--host-resolver-rules=MAP label.teksher.kg 109.71.231.11",
    ],
  });
  const page = await context.newPage();

  page.on("download", async (download) => {
    const suggested = download.suggestedFilename();
    const target = path.join(outputDir, suggested);
    await download.saveAs(target);
    console.log(`download saved: ${target}`);
  });

  if (mode === "multi-batch") {
    if (!(await runMultiBatchWorkflow(page, context))) return;
  } else if (mode === "diagnose-batch") {
    if (!(await runDiagnoseBatchWorkflow(page, context))) return;
  } else {
    if (!(await runBatchWorkflow(page, context))) return;
  }
}

main().catch(async (err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
