const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline/promises");

const BASE_URL = "https://label.teksher.kg";
const TOKEN_URL = `${BASE_URL}/realms/mzkm_prod_realm/protocol/openid-connect/token`;
const AUTH_TOKENS_JSON = path.join(__dirname, "auth_tokens.json");
const REFRESH_TOKEN_TXT = path.join(__dirname, "refresh_token.txt");
const CLIENT_ID = "facade_client";
const INPUT_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 15_000;

function looksLikeJwt(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.trim());
}

function normalizeToken(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "").trim();
}

function decodeJwtExp(token) {
  if (!looksLikeJwt(token)) return 0;
  const parts = token.split(".");
  if (parts.length < 2) return 0;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    );
    return Number(payload.exp || 0) * 1000;
  } catch {
    return 0;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function readRefreshTokenFromFile() {
  try {
    const content = await fs.readFile(REFRESH_TOKEN_TXT, "utf8");
    const refreshToken = normalizeToken(content);
    if (refreshToken) {
      console.log("refresh token loaded from refresh_token.txt");
      return refreshToken;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  return "";
}

async function readRefreshTokenWithTimeout() {
  const fileRefreshToken = await readRefreshTokenFromFile();
  if (fileRefreshToken) {
    return fileRefreshToken;
  }

  let refreshToken = "";

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const questionPromise = rl.question("Paste refresh_token and press Enter: ");
      const timeoutPromise = new Promise((_, reject) => {
        const timer = setTimeout(() => {
          clearTimeout(timer);
          reject(new Error(`refresh token input timeout after ${INPUT_TIMEOUT_MS}ms`));
        }, INPUT_TIMEOUT_MS);
      });
      refreshToken = normalizeToken(await Promise.race([questionPromise, timeoutPromise]));
    } finally {
      rl.close();
    }
  } else {
    const timeoutPromise = new Promise((_, reject) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        reject(new Error(`stdin timeout after ${INPUT_TIMEOUT_MS}ms`));
      }, INPUT_TIMEOUT_MS);
    });
    refreshToken = normalizeToken(await Promise.race([readStdin(), timeoutPromise]));
  }

  console.log("refresh token received");
  return refreshToken;
}

function serializeError(error) {
  const cause = error?.cause;
  let causeJson = null;
  try {
    causeJson = cause == null ? null : JSON.stringify(cause, Object.getOwnPropertyNames(cause), 2);
  } catch {
    causeJson = String(cause);
  }

  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || "",
    cause: causeJson,
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
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

async function probeGet(url) {
  console.log(`probe GET: ${url}`);
  try {
    const response = await fetchWithTimeout(url, { method: "GET" }, FETCH_TIMEOUT_MS);
    const body = await response.text().catch(() => "");
    console.log(`probe status: ${response.status}`);
    console.log(`probe body snippet: ${body.slice(0, 300)}`);
    return {
      ok: response.ok,
      status: response.status,
      body,
    };
  } catch (error) {
    const diag = serializeError(error);
    console.log(`probe error name: ${diag.name}`);
    console.log(`probe error message: ${diag.message}`);
    console.log(`probe error stack: ${diag.stack}`);
    console.log(`probe error cause: ${diag.cause}`);
    return { ok: false, error: diag };
  }
}

async function fetchRefreshToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });

  console.log(`refresh endpoint: ${TOKEN_URL}`);
  console.log("request method: POST");
  console.log("sending refresh request");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error(`refresh request timeout after ${FETCH_TIMEOUT_MS}ms`)), FETCH_TIMEOUT_MS);
  try {
    return await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    const diag = serializeError(error);
    console.log(`endpoint url: ${TOKEN_URL}`);
    console.log(`request method: POST`);
    console.log(`error.name: ${diag.name}`);
    console.log(`error.message: ${diag.message}`);
    console.log(`error.stack: ${diag.stack}`);
    console.log(`error.cause: ${diag.cause}`);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function main() {
  const refreshToken = await readRefreshTokenWithTimeout();

  if (!refreshToken) {
    throw new Error("refresh_token is empty");
  }

  let response;
  try {
    await probeGet(`${BASE_URL}/`);
    await probeGet("https://109.71.231.11/");
    response = await fetchRefreshToken(refreshToken);
  } catch (error) {
    const diag = serializeError(error);
    console.log(`endpoint url: ${TOKEN_URL}`);
    console.log(`request method: POST`);
    console.log(`error.name: ${diag.name}`);
    console.log(`error.message: ${diag.message}`);
    console.log(`error.stack: ${diag.stack}`);
    console.log(`error.cause: ${diag.cause}`);
    process.exitCode = 1;
    return;
  }

  const responseText = await response.text();
  console.log(`response status: ${response.status}`);
  console.log(`response body snippet: ${responseText.slice(0, 500)}`);

  if (!response.ok) {
    console.log(responseText);
    process.exitCode = 1;
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    console.log(responseText);
    process.exitCode = 1;
    return;
  }

  const accessToken = normalizeToken(parsed.access_token || parsed.accessToken || "");
  const nextRefreshToken = normalizeToken(parsed.refresh_token || parsed.refreshToken || refreshToken);

  if (!accessToken) {
    throw new Error("access_token missing in refresh response");
  }

  const savedAt = new Date().toISOString();
  await writeJson(AUTH_TOKENS_JSON, {
    access_token: accessToken,
    refresh_token: nextRefreshToken,
    savedAt,
    source: "refresh-token",
  });

  const accessExp = decodeJwtExp(accessToken);
  console.log("REFRESH_SUCCESS");
  console.log(`expiresAt: ${accessExp ? new Date(accessExp).toISOString() : "n/a"}`);
  console.log(`current time: ${savedAt}`);
}

main().catch((error) => {
  const diag = serializeError(error);
  console.log(`error.name: ${diag.name}`);
  console.log(`error.message: ${diag.message}`);
  console.log(`error.stack: ${diag.stack}`);
  console.log(`error.cause: ${diag.cause}`);
  process.exitCode = 1;
});
