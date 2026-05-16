const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const SOURCE_PATH = path.join(__dirname, "audit_local_selected.json");
const OUTPUT_DIR = path.join(os.homedir(), "Desktop", "электросталь печать кодов паркеровки");
const LOG_PATH = path.join(__dirname, "api_pdf_download_log.json");
const AUTH_TOKENS_PATH = path.join(__dirname, "auth_tokens.json");
const ACCESS_TOKEN_PATH = path.join(__dirname, "access_token.json");
const REFRESH_TOKEN_PATH = path.join(__dirname, "refresh_token.json");
const STORAGE_STATE_PATH = path.join(__dirname, "storageState.json");
const COOKIES_PATH = path.join(__dirname, "cookies.json");
const REQUEST_TIMEOUT = 45000;
const TOKEN_URL = "http://10.242.17.100:8800/realms/mzkm_prod_realm/protocol/openid-connect/token";
const CLIENT_ID = "facade_client";

const ENDPOINTS = [
  "/facade/api/v1/operations/{operationId}",
  "/facade/order/api/v1/operations/{operationId}",
  "/facade/api/v1/operations/{operationId}/print",
  "/facade/order/api/v1/operations/{operationId}/print",
  "/facade/api/v1/operations/{operationId}/download",
  "/facade/order/api/v1/operations/{operationId}/download",
  "/facade/api/v1/operations/{operationId}/pdf",
  "/facade/order/api/v1/operations/{operationId}/pdf",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeToken(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "").trim();
}

function looksLikeJwt(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.trim());
}

function decodeJwtPayload(token) {
  if (!looksLikeJwt(token)) return null;
  const parts = String(token).trim().split(".");
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function decodeJwtExpMs(token) {
  const payload = decodeJwtPayload(token);
  const exp = Number(payload?.exp || 0);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function uniqueByPair(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${row.gtin}|${row.operationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function sanitizeFilePart(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function absoluteUrl(maybeUrl) {
  if (!maybeUrl) return null;
  try {
    return new URL(maybeUrl, "https://label.teksher.kg").toString();
  } catch {
    return null;
  }
}

function isPdfResponse(response, contentType) {
  return response.ok && /application\/pdf/i.test(contentType || "");
}

function extractStringCandidate(value, keys = new Set()) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("/")) return trimmed;
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractStringCandidate(item, keys);
      if (found) return found;
    }
    return null;
  }

  for (const [key, nested] of Object.entries(value)) {
    const keyName = key.toLowerCase();
    if (["file", "url", "downloadurl", "link"].includes(keyName) && typeof nested === "string") {
      const candidate = nested.trim();
      if (candidate) return candidate;
    }
    if (nested && typeof nested === "object") {
      const found = extractStringCandidate(nested, keys);
      if (found) return found;
    }
  }

  return null;
}

function formatIso(ms) {
  return ms ? new Date(ms).toISOString() : "n/a";
}

async function readBodyAsText(response) {
  return response.text();
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

async function downloadBinaryResponse(response, targetPath, sourceUrl) {
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${sourceUrl}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    throw new Error(`Empty body for ${sourceUrl}`);
  }
  if (!/application\/pdf/i.test(contentType) && !buffer.slice(0, 4).equals(Buffer.from("%PDF"))) {
    throw new Error(`Not a PDF response from ${sourceUrl}`);
  }
  await fs.writeFile(targetPath, buffer);
}

function extractCookiesFromState(state) {
  const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
  return cookies
    .filter((cookie) => cookie && cookie.domain && cookie.name)
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value || "",
      domain: cookie.domain,
      path: cookie.path || "/",
      expires: cookie.expires,
      sourceFile: state.sourceFile || null,
    }));
}

async function tryEndpoints(operationId, authHeaders) {
  const results = [];
  for (const template of ENDPOINTS) {
    const url = `https://label.teksher.kg${template.replace("{operationId}", encodeURIComponent(operationId))}`;
    try {
      const response = await fetchWithTimeout(url, {
        method: "GET",
        headers: authHeaders,
      });
      const contentType = response.headers.get("content-type") || "";

      if (isPdfResponse(response, contentType)) {
        const buffer = Buffer.from(await response.arrayBuffer());
        results.push({
          url,
          kind: "pdf",
          status: response.status,
          contentType,
          buffer,
        });
        continue;
      }

      const text = await readBodyAsText(response);
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }

      const candidate = extractStringCandidate(json ?? text);
      results.push({
        url,
        kind: json ? "json" : "text",
        status: response.status,
        contentType,
        bodyText: text,
        json,
        candidate: candidate ? absoluteUrl(candidate) : null,
      });
    } catch (error) {
      results.push({
        url,
        kind: "error",
        error: error.message || String(error),
        errorCode: error?.cause?.code || error?.code || null,
        errorCause: error?.cause?.message || null,
      });
    }
  }
  return results;
}

async function readAuthArtifacts() {
  const fileReaders = [
    {
      file: AUTH_TOKENS_PATH,
      kind: "auth_tokens.json",
      read: async () => {
        const data = await readJson(AUTH_TOKENS_PATH);
        return {
          sourceFile: "auth_tokens.json",
          accessToken: normalizeToken(data.access_token),
          refreshToken: normalizeToken(data.refresh_token),
          savedAt: data.savedAt || null,
          source: data.source || null,
        };
      },
    },
    {
      file: ACCESS_TOKEN_PATH,
      kind: "access_token.json",
      read: async () => {
        const data = await readJson(ACCESS_TOKEN_PATH);
        return {
          sourceFile: "access_token.json",
          accessToken: normalizeToken(data.token || data.access_token || ""),
          savedAt: data.savedAt || null,
          source: data.source || null,
        };
      },
    },
    {
      file: REFRESH_TOKEN_PATH,
      kind: "refresh_token.json",
      read: async () => {
        const data = await readJson(REFRESH_TOKEN_PATH);
        return {
          sourceFile: "refresh_token.json",
          refreshToken: normalizeToken(data.token || data.refresh_token || ""),
          savedAt: data.savedAt || null,
          source: data.source || null,
        };
      },
    },
    {
      file: STORAGE_STATE_PATH,
      kind: "storageState.json",
      read: async () => {
        const data = await readJson(STORAGE_STATE_PATH);
        return {
          sourceFile: "storageState.json",
          cookies: extractCookiesFromState({ ...data, sourceFile: "storageState.json" }),
        };
      },
    },
    {
      file: COOKIES_PATH,
      kind: "cookies.json",
      read: async () => {
        const data = await readJson(COOKIES_PATH);
        return {
          sourceFile: "cookies.json",
          cookies: extractCookiesFromState({ cookies: data, sourceFile: "cookies.json" }),
        };
      },
    },
  ];

  const sources = [];
  for (const reader of fileReaders) {
    try {
      const exists = await fileExists(reader.file);
      if (!exists) continue;
      const value = await reader.read();
      sources.push(value);
    } catch (error) {
      sources.push({
        sourceFile: path.basename(reader.file),
        error: error.message || String(error),
      });
    }
  }

  return sources;
}

function selectBestToken(sources) {
  const accessCandidates = [];
  const refreshCandidates = [];
  const cookieCandidates = [];

  for (const source of sources) {
    if (source?.accessToken) {
      accessCandidates.push({
        ...source,
        token: source.accessToken,
        expMs: decodeJwtExpMs(source.accessToken),
      });
    }
    if (source?.refreshToken) {
      refreshCandidates.push({
        ...source,
        token: source.refreshToken,
        expMs: decodeJwtExpMs(source.refreshToken),
      });
    }
    if (Array.isArray(source?.cookies)) {
      cookieCandidates.push(...source.cookies);
    }
  }

  accessCandidates.sort((a, b) => (b.expMs || 0) - (a.expMs || 0));
  refreshCandidates.sort((a, b) => (b.expMs || 0) - (a.expMs || 0));

  const access = accessCandidates[0] || null;
  const refresh = refreshCandidates[0] || null;

  const cookieMap = new Map();
  for (const cookie of cookieCandidates) {
    const key = `${cookie.domain};${cookie.path};${cookie.name}`;
    if (!cookieMap.has(key)) cookieMap.set(key, cookie);
    else if ((cookie.value || "").length > (cookieMap.get(key).value || "").length) cookieMap.set(key, cookie);
  }

  const cookies = [...cookieMap.values()];

  return {
    access,
    refresh,
    cookies,
  };
}

function buildCookieHeader(cookies, extraTokens = {}) {
  const parts = [];
  const map = new Map();

  for (const cookie of cookies) {
    if (cookie?.name && typeof cookie.value === "string" && cookie.value) {
      map.set(cookie.name, cookie.value);
    }
  }

  if (extraTokens.accessToken) map.set("access_token", extraTokens.accessToken);
  if (extraTokens.refreshToken) map.set("refresh_token", extraTokens.refreshToken);

  for (const [name, value] of map.entries()) {
    parts.push(`${name}=${value}`);
  }

  return parts.join("; ");
}

async function refreshAccessToken(refreshToken) {
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    });

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const responseText = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        body: responseText,
      };
    };

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      return {
        ok: false,
        status: response.status,
        body: responseText,
        error: "Non-JSON refresh response",
      };
    }

    const accessToken = normalizeToken(parsed.access_token || parsed.accessToken || "");
    const nextRefreshToken = normalizeToken(parsed.refresh_token || parsed.refreshToken || refreshToken);
    if (!accessToken) {
      return {
        ok: false,
        status: response.status,
        body: responseText,
        error: "access_token missing in refresh response",
      };
    }

    const savedAt = new Date().toISOString();
    await writeJson(AUTH_TOKENS_PATH, {
      access_token: accessToken,
      refresh_token: nextRefreshToken,
      savedAt,
      source: "refresh-token",
    });

    return {
      ok: true,
      accessToken,
      refreshToken: nextRefreshToken,
      savedAt,
      expMs: decodeJwtExpMs(accessToken),
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.cause?.message || error?.message || String(error),
    };
  }
}

async function main() {
  await ensureDir(OUTPUT_DIR);

  const payload = await readJson(SOURCE_PATH);
  const selected = Array.isArray(payload?.selected) ? payload.selected : [];
  const records = uniqueByPair(
    selected
      .filter((row) => row && row.gtin && row.operationId)
      .filter((row) => normalizeStatus(row.status) !== "")
  );

  const authSources = await readAuthArtifacts();
  const selectedAuth = selectBestToken(authSources);
  const nowMs = Date.now();

  let accessToken = selectedAuth.access?.token || "";
  let refreshToken = selectedAuth.refresh?.token || "";
  let authSourceFile = selectedAuth.access?.sourceFile || selectedAuth.refresh?.sourceFile || null;
  let authRefreshAttempt = null;

  const initialAuthExpMs = decodeJwtExpMs(accessToken);
  if ((!accessToken || (initialAuthExpMs && initialAuthExpMs <= nowMs + 60_000)) && refreshToken) {
    authRefreshAttempt = await refreshAccessToken(refreshToken);
    if (authRefreshAttempt.ok) {
      accessToken = authRefreshAttempt.accessToken;
      refreshToken = authRefreshAttempt.refreshToken;
      authSourceFile = "auth_tokens.json (refreshed)";
    }
  }

  const accessExpMs = decodeJwtExpMs(accessToken);
  const cookieHeader = buildCookieHeader(selectedAuth.cookies, { accessToken, refreshToken });
  const headers = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (cookieHeader) headers.Cookie = cookieHeader;
  headers.Accept = "application/json, text/plain, */*";
  headers.Origin = "https://label.teksher.kg";
  headers.Referer = "https://label.teksher.kg/operations";

  console.log("AUTH_DIAGNOSTICS");
  console.log(`token file path: ${authSourceFile || "n/a"}`);
  console.log(`access token exists: ${accessToken ? "yes" : "no"}`);
  console.log(`access token source: ${selectedAuth.access?.sourceFile || "n/a"}`);
  console.log(`refresh token source: ${selectedAuth.refresh?.sourceFile || "n/a"}`);
  console.log(`access token prefix: ${accessToken ? accessToken.slice(0, 12) : "n/a"}`);
  console.log(`savedAt: ${authRefreshAttempt?.savedAt || selectedAuth.access?.savedAt || selectedAuth.refresh?.savedAt || "n/a"}`);
  console.log(`token exp: ${accessExpMs ? new Date(accessExpMs).toISOString() : "n/a"}`);
  console.log(`current time: ${new Date(nowMs).toISOString()}`);
  console.log(`cookie header sent: ${cookieHeader ? "yes" : "no"}`);
  console.log(`cookie names: ${selectedAuth.cookies.map((cookie) => cookie.name).join(", ") || "n/a"}`);
  if (authRefreshAttempt) {
    console.log(`refresh attempt: ${authRefreshAttempt.ok ? "success" : "failed"}`);
    if (!authRefreshAttempt.ok) {
      console.log(`refresh status: ${authRefreshAttempt.status || "n/a"}`);
      console.log(`refresh body: ${authRefreshAttempt.body || authRefreshAttempt.error || "n/a"}`);
    }
  }

  const tableRows = [];
  const log = [];

  for (const record of records) {
    const targetPath = path.join(OUTPUT_DIR, `${sanitizeFilePart(record.gtin)}.pdf`);
    const baseRow = {
      gtin: record.gtin,
      operationId: record.operationId,
      status: record.status,
      filePath: targetPath,
      sourceFile: record.sourceFile || null,
    };

    if (await fileExists(targetPath)) {
      tableRows.push({ ...baseRow, status: `${record.status} (exists)` });
      log.push({
        ...baseRow,
        endpoint: null,
        outcome: "skipped_exists",
      });
      continue;
    }

    const endpointResults = await tryEndpoints(record.operationId, headers);
    console.log(`operation ${record.operationId} auth header: ${accessToken ? "Bearer " + accessToken.slice(0, 12) + "..." : "none"}`);
    console.log(`operation ${record.operationId} cookie header: ${cookieHeader ? "present" : "missing"}`);
    for (const endpoint of endpointResults) {
    console.log(`endpoint status: ${endpoint.url} -> ${endpoint.status || endpoint.error || "n/a"}`);
    if (endpoint.kind === "error" && endpoint.errorCode) {
      console.log(`endpoint error code: ${endpoint.errorCode}${endpoint.errorCause ? ` (${endpoint.errorCause})` : ""}`);
    }
  }
    let saved = false;
    let lastError = null;

    for (const entry of endpointResults) {
      if (entry.kind === "pdf" && entry.buffer) {
        try {
          await fs.writeFile(targetPath, entry.buffer);
          saved = true;
          tableRows.push({
            ...baseRow,
            filePath: targetPath,
          });
          log.push({
            ...baseRow,
            endpoint: entry.url,
            outcome: "saved_pdf",
            contentType: entry.contentType,
            requestHeaders: {
              Authorization: accessToken ? `Bearer ${accessToken.slice(0, 12)}...` : null,
              Cookie: cookieHeader ? "present" : null,
            },
          });
          break;
        } catch (error) {
          lastError = error;
          continue;
        }
      }

      if ((entry.kind === "json" || entry.kind === "text") && entry.candidate) {
        try {
          const referencedResponse = await fetchWithTimeout(entry.candidate, {
            method: "GET",
            headers,
          });
          if (referencedResponse.headers.get("content-type")?.includes("application/pdf") || referencedResponse.ok) {
            await downloadBinaryResponse(referencedResponse, targetPath, entry.candidate);
          } else {
            const text = await referencedResponse.text();
            throw new Error(`HTTP ${referencedResponse.status} for ${entry.candidate}: ${text.slice(0, 300)}`);
          }
          saved = true;
          tableRows.push({
            ...baseRow,
            filePath: targetPath,
          });
          log.push({
            ...baseRow,
            endpoint: entry.url,
            outcome: "saved_referenced_file",
            referencedUrl: entry.candidate,
            requestHeaders: {
              Authorization: accessToken ? `Bearer ${accessToken.slice(0, 12)}...` : null,
              Cookie: cookieHeader ? "present" : null,
            },
          });
          break;
        } catch (error) {
          lastError = error;
          continue;
        }
      }
    }

    if (!saved) {
      const errorText = lastError ? lastError.message || String(lastError) : "No downloadable PDF endpoint found";
      tableRows.push({
        ...baseRow,
        filePath: `ERROR: ${errorText}`,
      });
      log.push({
        ...baseRow,
        endpoint: null,
        outcome: "error",
        error: errorText,
        endpointResults,
        requestHeaders: {
          Authorization: accessToken ? `Bearer ${accessToken.slice(0, 12)}...` : null,
          Cookie: cookieHeader ? "present" : null,
        },
      });
    }

    await sleep(50);
  }

  await writeJson(LOG_PATH, {
    generatedAt: new Date().toISOString(),
    sourcePath: SOURCE_PATH,
    outputDir: OUTPUT_DIR,
    rows: log,
  });

  console.table(
    tableRows.map((row) => ({
      GTIN: row.gtin,
      operationId: row.operationId,
      status: row.status,
      filePath: row.filePath,
    }))
  );

  console.table(
    records.map((record) => ({
      operationId: record.operationId,
      gtin: record.gtin,
      status: record.status,
      authSource: authSourceFile || "n/a",
      cookieHeader: cookieHeader ? "present" : "missing",
      accessTokenPrefix: accessToken ? accessToken.slice(0, 12) : "n/a",
      accessTokenExp: accessExpMs ? new Date(accessExpMs).toISOString() : "n/a",
    }))
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
