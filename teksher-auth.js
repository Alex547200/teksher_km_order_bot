const fs = require("node:fs/promises");

const DEFAULT_TOKEN_URL = "https://label.teksher.kg/realms/mzkm_prod_realm/protocol/openid-connect/token";
const DEFAULT_CLIENT_ID = "facade_client";

function looksLikeJwt(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.trim());
}

function normalizeToken(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "").trim();
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

function collectTokenCandidates(value, source, out = []) {
  if (value == null) return out;
  if (typeof value === "string") {
    const trimmed = value.trim();
    const bearer = trimmed.match(/Bearer\s+([A-Za-z0-9_.-]+)/i);
    if (bearer) out.push({ token: bearer[1], source });
    if (looksLikeJwt(trimmed)) out.push({ token: trimmed, source });
    if (/(access|auth|authorization|jwt|token)/i.test(source) && !/refresh/i.test(source) && trimmed.length > 20 && !/\s/.test(trimmed)) {
      out.push({ token: trimmed.replace(/^Bearer\s+/i, ""), source });
    }
    try {
      const parsed = JSON.parse(trimmed);
      collectTokenCandidates(parsed, source, out);
    } catch {}
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTokenCandidates(item, source, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      collectTokenCandidates(nested, `${source}.${key}`, out);
    }
  }
  return out;
}

async function extractBearerToken(page, context, { logCandidates = true } = {}) {
  const storage = await page.evaluate(() => {
    const readStorage = (store) => {
      const values = {};
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        values[key] = store.getItem(key);
      }
      return values;
    };
    return {
      localStorage: readStorage(window.localStorage),
      sessionStorage: readStorage(window.sessionStorage),
    };
  }).catch(() => ({ localStorage: {}, sessionStorage: {} }));

  const candidates = [];
  collectTokenCandidates(storage.localStorage, "localStorage", candidates);
  collectTokenCandidates(storage.sessionStorage, "sessionStorage", candidates);

  const cookies = await context.cookies().catch(() => []);
  for (const cookie of cookies) {
    collectTokenCandidates(cookie.value, `cookie.${cookie.name}`, candidates);
  }

  const unique = candidates.filter((candidate, index, arr) => arr.findIndex((item) => item.token === candidate.token) === index);
  unique.sort((a, b) => {
    const rank = (candidate) => {
      if (/authorization|access/i.test(candidate.source)) return 0;
      if (/jwt|token/i.test(candidate.source)) return 1;
      if (/refresh/i.test(candidate.source)) return 9;
      return 5;
    };
    return rank(a) - rank(b);
  });

  if (logCandidates) {
    console.log("auth token candidates:");
    console.table(unique.map((candidate, index) => ({
      index,
      source: candidate.source,
      preview: `${candidate.token.slice(0, 12)}...${candidate.token.slice(-8)}`,
    })));
  }

  return unique[0] || null;
}

function chooseAccessToken(candidates) {
  const unique = candidates
    .map((item) => ({ ...item, token: normalizeToken(item.token) }))
    .filter((item) => item.token && !/refresh/i.test(item.source));
  unique.sort((a, b) => (decodeJwtExpMs(b.token) || 0) - (decodeJwtExpMs(a.token) || 0));
  return unique.find((item) => !isExpired(item.token)) || unique[0] || null;
}

function chooseRefreshToken(candidates) {
  const unique = candidates
    .map((item) => ({ ...item, token: normalizeToken(item.token) }))
    .filter((item) => item.token && /refresh/i.test(item.source));
  return unique.find((item) => /refresh/i.test(item.source) && item.token) || unique[0] || null;
}

function isExpired(token, skewMs = 60 * 1000) {
  const exp = decodeJwtExpMs(token);
  return !exp || exp <= Date.now() + skewMs;
}

async function readJsonIfExists(filePath, fallback = null) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err && err.code === "ENOENT") return fallback;
    return fallback;
  }
}

async function readAuthCandidatesFromFiles(fileSpecs) {
  const candidates = [];
  for (const spec of fileSpecs) {
    const data = await readJsonIfExists(spec.path, null);
    if (data != null) collectTokenCandidates(data, spec.source, candidates);
  }
  return candidates;
}

async function refreshAuthToken(refreshToken, {
  tokenUrl = DEFAULT_TOKEN_URL,
  clientId = DEFAULT_CLIENT_ID,
  authTokensPath = "",
  source = "refresh-token",
} = {}) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: normalizeToken(refreshToken),
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const responseText = await response.text();
  if (!response.ok) {
    const error = new Error(responseText || `refresh failed with HTTP ${response.status}`);
    error.responseText = responseText;
    error.status = response.status;
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    const error = new Error("refresh response is not JSON");
    error.responseText = responseText;
    throw error;
  }

  const accessToken = normalizeToken(parsed.access_token || parsed.accessToken || "");
  const nextRefreshToken = normalizeToken(parsed.refresh_token || parsed.refreshToken || refreshToken);
  if (!accessToken) {
    throw new Error("access_token missing in refresh response");
  }

  const savedAt = new Date().toISOString();
  const authRecord = {
    access_token: accessToken,
    refresh_token: nextRefreshToken,
    savedAt,
    source,
  };
  if (authTokensPath) {
    await fs.writeFile(authTokensPath, `${JSON.stringify(authRecord, null, 2)}\n`, "utf8");
  }

  return {
    accessToken,
    refreshToken: nextRefreshToken,
    tokenExpiresAt: decodeJwtExpMs(accessToken) ? new Date(decodeJwtExpMs(accessToken)).toISOString() : "",
    hasAccessToken: true,
    isExpired: false,
    savedAt,
    source,
    authHeaders: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  };
}

async function resolveAuth(page, context, {
  fileSpecs = [],
  authTokensPath = "",
  tokenUrl = DEFAULT_TOKEN_URL,
  clientId = DEFAULT_CLIENT_ID,
  logCandidates = false,
  source = "auth-helper",
} = {}) {
  const fileCandidates = await readAuthCandidatesFromFiles(fileSpecs);
  const sessionCandidates = [];
  const sessionCandidate = await extractBearerToken(page, context, { logCandidates });
  if (sessionCandidate) sessionCandidates.push(sessionCandidate);

  const candidates = [...fileCandidates, ...sessionCandidates];
  const accessCandidate = chooseAccessToken(candidates);
  const refreshCandidate = chooseRefreshToken(candidates);

  let accessToken = normalizeToken(accessCandidate?.token || "");
  let refreshToken = normalizeToken(refreshCandidate?.token || "");
  let tokenExpiresAt = accessToken ? (decodeJwtExpMs(accessToken) ? new Date(decodeJwtExpMs(accessToken)).toISOString() : "") : "";
  let hasAccessToken = Boolean(accessToken);
  let isExpired = !accessToken || isExpiredToken(accessToken);

  if ((!hasAccessToken || isExpired) && refreshToken) {
    const refreshed = await refreshAuthToken(refreshToken, {
      tokenUrl,
      clientId,
      authTokensPath,
      source,
    });
    accessToken = refreshed.accessToken;
    refreshToken = refreshed.refreshToken;
    tokenExpiresAt = refreshed.tokenExpiresAt;
    hasAccessToken = refreshed.hasAccessToken;
    isExpired = refreshed.isExpired;
  }

  const diagnostic = {
    generatedAt: new Date().toISOString(),
    hasAccessToken,
    tokenExpiresAt,
    isExpired,
    accessTokenSource: accessCandidate?.source || "",
    refreshTokenSource: refreshCandidate?.source || "",
  };

  return {
    accessToken,
    refreshToken,
    authHeaders: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    diagnostic,
  };
}

function isExpiredToken(token) {
  return isExpired(token);
}

module.exports = {
  looksLikeJwt,
  normalizeToken,
  decodeJwtPayload,
  decodeJwtExpMs,
  collectTokenCandidates,
  extractBearerToken,
  chooseAccessToken,
  chooseRefreshToken,
  readJsonIfExists,
  readAuthCandidatesFromFiles,
  refreshAuthToken,
  resolveAuth,
};
