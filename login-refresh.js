const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const BASE_URL = "https://label.teksher.kg";
const LOGIN_URL = "https://label.teksher.kg/login";
const PROFILE_DIR = path.join(__dirname, "teksher-session-profile");

const ACCESS_TOKEN_TXT = path.join(__dirname, "access_token.txt");
const ACCESS_TOKEN_JSON = path.join(__dirname, "access_token.json");
const REFRESH_TOKEN_TXT = path.join(__dirname, "refresh_token.txt");
const REFRESH_TOKEN_JSON = path.join(__dirname, "refresh_token.json");
const AUTH_TOKENS_JSON = path.join(__dirname, "auth_tokens.json");
const COOKIES_JSON = path.join(__dirname, "cookies.json");
const STORAGE_STATE_JSON = path.join(__dirname, "storageState.json");
const TOKEN_TIMESTAMP_JSON = path.join(__dirname, "token_timestamp.json");

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT = 30000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function looksLikeJwt(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.trim());
}

function decodeJwtExp(token) {
  if (!looksLikeJwt(token)) return 0;
  const parts = token.split(".");
  if (parts.length < 2) return 0;
  try {
    const body = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(body);
    return Number(payload.exp || 0) * 1000;
  } catch {
    return 0;
  }
}

function normalizeToken(value) {
  if (value == null) return "";
  const text = String(value).trim();
  return text.replace(/^Bearer\s+/i, "").trim();
}

async function ensureProfileDir() {
  await fs.mkdir(PROFILE_DIR, { recursive: true });
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function writeText(filePath, value) {
  await fs.writeFile(filePath, `${String(value || "").trim()}\n`, "utf8");
}

function extractFromText(text, source, out) {
  const raw = String(text || "");
  if (!raw) return out;

  const patterns = [
    /Bearer\s+([A-Za-z0-9._-]+)/gi,
    /["']access[_-]?token["']\s*[:=]\s*["']([^"']+)["']/gi,
    /["']refresh[_-]?token["']\s*[:=]\s*["']([^"']+)["']/gi,
    /["']token["']\s*[:=]\s*["']([^"']+)["']/gi,
    /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    /\b[A-Za-z0-9._-]{32,}\b/g,
  ];

  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      const token = normalizeToken(match[1] || match[0]);
      if (token && token.length >= 20 && !/\s/.test(token)) {
        out.push({ token, source });
      }
    }
  }

  return out;
}

function extractFromValue(value, source, out = []) {
  if (value == null) return out;
  if (typeof value === "string") {
    extractFromText(value, source, out);
    try {
      extractFromValue(JSON.parse(value), `${source}.json`, out);
    } catch {}
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractFromValue(item, source, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      extractFromValue(nested, `${source}.${key}`, out);
    }
  }
  return out;
}

async function readBrowserState(page, context) {
  const storage = await page.evaluate(() => {
    const read = (store) => {
      const out = {};
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        out[key] = store.getItem(key);
      }
      return out;
    };

    return {
      localStorage: read(window.localStorage),
      sessionStorage: read(window.sessionStorage),
    };
  }).catch(() => ({ localStorage: {}, sessionStorage: {} }));

  const cookies = await context.cookies().catch(() => []);
  return { storage, cookies };
}

function filterAccessCandidates(candidates) {
  return candidates.filter((candidate) => !/refresh/i.test(String(candidate.source || "")));
}

function filterRefreshCandidates(candidates) {
  return candidates.filter((candidate) => /refresh/i.test(String(candidate.source || "")));
}

function selectFreshestAccessCandidate(candidates, minValidUntilMs = Date.now() + 60 * 1000) {
  return candidates
    .map((candidate) => ({
      ...candidate,
      expMs: decodeJwtExp(candidate.token),
    }))
    .filter((candidate) => candidate.expMs > minValidUntilMs)
    .sort((a, b) => b.expMs - a.expMs || tokenScore(a) - tokenScore(b))[0] || null;
}

function selectBestRefreshCandidate(candidates) {
  return candidates
    .map((candidate) => ({
      ...candidate,
      expMs: decodeJwtExp(candidate.token),
    }))
    .sort((a, b) => b.expMs - a.expMs || tokenScore(a) - tokenScore(b))[0] || null;
}

function tokenScore(candidate) {
  const source = String(candidate.source || "");
  if (/access[_-]?token/i.test(source)) return 0;
  if (/refresh[_-]?token/i.test(source)) return 1;
  if (/authorization|bearer/i.test(source)) return 2;
  if (/cookie/i.test(source)) return 3;
  if (/sessionstorage|session storage/i.test(source)) return 4;
  if (/localstorage|local storage/i.test(source)) return 5;
  return 9;
}

function groupNamedTokens(entries, kind) {
  const out = [];
  const keyPatterns = kind === "access"
    ? [/access[_-]?token/i, /^token$/i, /authorization/i, /bearer/i]
    : [/refresh[_-]?token/i, /refresh/i];

  for (const [key, value] of entries) {
    const keyText = String(key || "");
    if (!keyPatterns.some((pattern) => pattern.test(keyText))) continue;
    extractFromValue(value, `named.${keyText}`, out);
    const token = normalizeToken(value);
    if (token) out.push({ token, source: `named.${keyText}` });
  }

  return out;
}

function collectCandidates(state, cookies) {
  const candidates = [];

  const localEntries = Object.entries(state.localStorage || {});
  const sessionEntries = Object.entries(state.sessionStorage || {});
  const cookieEntries = (cookies || []).map((cookie) => [cookie.name, cookie.value]);

  for (const item of groupNamedTokens(localEntries, "access")) candidates.push(item);
  for (const item of groupNamedTokens(sessionEntries, "access")) candidates.push(item);
  for (const item of groupNamedTokens(cookieEntries, "access")) candidates.push(item);

  for (const item of groupNamedTokens(localEntries, "refresh")) candidates.push(item);
  for (const item of groupNamedTokens(sessionEntries, "refresh")) candidates.push(item);
  for (const item of groupNamedTokens(cookieEntries, "refresh")) candidates.push(item);

  extractFromValue(state.localStorage || {}, "localStorage", candidates);
  extractFromValue(state.sessionStorage || {}, "sessionStorage", candidates);
  extractFromValue(cookies || [], "cookie", candidates);

  const unique = candidates.filter((candidate, index, array) => array.findIndex((item) => item.token === candidate.token) === index);
  unique.sort((a, b) => tokenScore(a) - tokenScore(b));
  return unique;
}

async function saveAuthArtifacts({ accessToken, refreshToken, cookies, storageState, sourcePageUrl }) {
  const savedAt = nowIso();
  const accessExp = decodeJwtExp(accessToken);
  const refreshExp = decodeJwtExp(refreshToken);
  const authTokens = {
    access_token: accessToken,
    refresh_token: refreshToken,
    savedAt,
    source: "login-refresh",
  };

  await writeText(ACCESS_TOKEN_TXT, accessToken);
  await writeJson(ACCESS_TOKEN_JSON, {
    token: accessToken,
    savedAt,
    source: "login-refresh",
    pageUrl: sourcePageUrl,
    expiresAt: accessExp ? new Date(accessExp).toISOString() : "",
  });

  await writeText(REFRESH_TOKEN_TXT, refreshToken);
  await writeJson(REFRESH_TOKEN_JSON, {
    token: refreshToken,
    savedAt,
    source: "login-refresh",
    pageUrl: sourcePageUrl,
    expiresAt: refreshExp ? new Date(refreshExp).toISOString() : "",
  });

  await writeJson(AUTH_TOKENS_JSON, authTokens);
  await writeJson(COOKIES_JSON, cookies || []);
  await writeJson(STORAGE_STATE_JSON, storageState);
  await writeJson(TOKEN_TIMESTAMP_JSON, {
    savedAt,
    accessTokenSavedAt: savedAt,
    refreshTokenSavedAt: savedAt,
    pageUrl: sourcePageUrl,
    accessTokenExpiresAt: accessExp ? new Date(accessExp).toISOString() : "",
    refreshTokenExpiresAt: refreshExp ? new Date(refreshExp).toISOString() : "",
  });
}

async function clearLabelAuthState(page, context) {
  await context.clearCookies().catch(() => {});
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  }).catch(() => {});
  await page.reload({ waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT }).catch(() => {});
}

async function waitForManualLogin(context, page) {
  const startedAt = Date.now();
  let clearedExpiredState = false;
  while (Date.now() - startedAt < LOGIN_TIMEOUT_MS) {
    const { storage, cookies } = await readBrowserState(page, context);
    const candidates = collectCandidates(storage, cookies);
    const accessCandidates = filterAccessCandidates(candidates);
    const refreshCandidates = filterRefreshCandidates(candidates);
    const access = selectFreshestAccessCandidate(accessCandidates);
    const refresh = selectBestRefreshCandidate(refreshCandidates);

    if (access?.token) {
      const storageState = await context.storageState();
      await saveAuthArtifacts({
        accessToken: access.token,
        refreshToken: refresh?.token || "",
        cookies,
        storageState,
        sourcePageUrl: page.url(),
      });

      const expMs = decodeJwtExp(access.token);
      return {
        accessToken: access.token,
        refreshToken: refresh?.token || "",
        tokenExpMs: expMs,
      };
    }

    if (!clearedExpiredState && accessCandidates.some((candidate) => decodeJwtExp(candidate.token) > 0)) {
      console.log("All access tokens are expired. Clearing cookies/localStorage/sessionStorage for label.teksher.kg and reopening the login page.");
      await clearLabelAuthState(page, context);
      console.log("Please sign in again in the opened browser window.");
      clearedExpiredState = true;
      continue;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`LOGIN_TIMEOUT: не дождался ручного логина за ${Math.round(LOGIN_TIMEOUT_MS / 60000)} минут`);
}

async function main() {
  await ensureProfileDir();

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    acceptDownloads: false,
    viewport: { width: 1440, height: 1200 },
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    await page.waitForLoadState("networkidle", { timeout: DEFAULT_TIMEOUT }).catch(() => {});

    const result = await waitForManualLogin(context, page);
    if (!result.accessToken || !result.accessToken.trim()) {
      throw new Error("ACCESS_TOKEN_MISSING: login completed, but access_token was not found");
    }

    console.log("TOKEN_REFRESH_SUCCESS");
    console.log(`token exp: ${new Date(result.tokenExpMs).toISOString()}`);
    console.log(`current time: ${new Date().toISOString()}`);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
