const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline/promises");

const AUTH_TOKENS_JSON = path.join(__dirname, "auth_tokens.json");
const ACCESS_TOKEN_PROMPT = "Paste access_token and press Enter: ";
const REFRESH_TOKEN_PROMPT = "Paste refresh_token and press Enter: ";

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
    return Number(payload.exp || 0);
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
    const rawAccessToken = await rl.question(ACCESS_TOKEN_PROMPT);
    const accessToken = normalizeToken(rawAccessToken);
    const expUnix = decodeJwtExp(accessToken);
    const nowUnix = Math.floor(Date.now() / 1000);
    const secondsLeft = expUnix - nowUnix;
    const expISO = expUnix ? new Date(expUnix * 1000).toISOString() : "n/a";
    const nowISO = new Date().toISOString();

    if (!accessToken) {
      throw new Error("TOKEN_EXPIRED: access_token is empty");
    }

    if (!expUnix) {
      throw new Error("TOKEN_EXPIRED: access_token is not a valid JWT");
    }

    console.log(`nowUnix: ${nowUnix}`);
    console.log(`expUnix: ${expUnix}`);
    console.log(`secondsLeft: ${secondsLeft}`);
    console.log(`expISO: ${expISO}`);
    console.log(`nowISO: ${nowISO}`);

    if (secondsLeft <= 30) {
      throw new Error("TOKEN_EXPIRED: access_token has expired");
    }

    const rawRefreshToken = await rl.question(REFRESH_TOKEN_PROMPT);
    const refreshToken = normalizeToken(rawRefreshToken);
    if (!refreshToken) {
      throw new Error("TOKEN_EXPIRED: refresh_token is empty");
    }

    await writeJson(AUTH_TOKENS_JSON, {
      access_token: accessToken,
      refresh_token: refreshToken,
      savedAt: new Date().toISOString(),
      source: "manual-token",
    });

    console.log("TOKEN_REFRESH_SUCCESS");
    console.log(`token exp: ${expISO}`);
    console.log(`current time: ${nowISO}`);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
