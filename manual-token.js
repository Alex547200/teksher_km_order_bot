const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline/promises");

const AUTH_TOKENS_JSON = path.join(__dirname, "auth_tokens.json");
const TOKEN_PROMPT = "Paste access_token and press Enter: ";

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

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const rawToken = await rl.question(TOKEN_PROMPT);
    const accessToken = normalizeToken(rawToken);
    const expMs = decodeJwtExp(accessToken);
    const nowMs = Date.now();

    if (!accessToken) {
      throw new Error("TOKEN_EXPIRED: access_token is empty");
    }

    if (!expMs) {
      throw new Error("TOKEN_EXPIRED: access_token is not a valid JWT");
    }

    if (expMs <= nowMs) {
      throw new Error("TOKEN_EXPIRED: access_token has expired");
    }

    await writeJson(AUTH_TOKENS_JSON, {
      access_token: accessToken,
      savedAt: new Date().toISOString(),
      source: "manual-token",
    });

    console.log("TOKEN_REFRESH_SUCCESS");
    console.log(`token exp: ${new Date(expMs).toISOString()}`);
    console.log(`current time: ${new Date(nowMs).toISOString()}`);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
