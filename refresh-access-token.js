const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline/promises");

const TOKEN_URL = "http://10.242.17.100:8800/realms/mzkm_prod_realm/protocol/openid-connect/token";
const AUTH_TOKENS_JSON = path.join(__dirname, "auth_tokens.json");
const CLIENT_ID = "facade_client";

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

async function main() {
  let refreshToken = "";
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      refreshToken = normalizeToken(await rl.question("Paste refresh_token and press Enter: "));
    } finally {
      rl.close();
    }
  } else {
    refreshToken = normalizeToken(await readStdin());
  }

  if (!refreshToken) {
    throw new Error("refresh_token is empty");
  }

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
  console.log(`access token exp: ${accessExp ? new Date(accessExp).toISOString() : "n/a"}`);
  console.log(`current time: ${savedAt}`);
}

main().catch((error) => {
  const message = error?.responseText || error?.message || String(error);
  console.log(message);
  process.exitCode = 1;
});
