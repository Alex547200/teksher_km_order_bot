const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const readline = require("node:readline/promises");

const PROJECT_DIR = __dirname;
const BATCH_FILE = path.join(PROJECT_DIR, "batch.txt");

function printHelp() {
  console.log(`Usage:
  node teksher.js create
  node teksher.js status
  node teksher.js export
  node teksher.js help

Commands:
  create  Create KM orders using the existing order-km.js workflow.
  status  Check operation statuses using the existing audit-today.js workflow.
  export  Export CSV/PDF for 2026-05-15 using the existing export-2026-05-15.js workflow.
  help    Show this help.
`);
}

async function readBatchItems(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const items = [];

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
    items.push({ gtin, quantity });
  }

  return items;
}

async function confirmCreate() {
  const items = await readBatchItems(BATCH_FILE);
  if (items.length === 0) {
    throw new Error(`No GTINs found in ${BATCH_FILE}`);
  }

  console.log(`Create will use ${items.length} GTINs from ${path.basename(BATCH_FILE)}:`);
  console.table(items);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = (await rl.question('Type YES to continue: ')).trim();
    if (answer !== "YES") {
      console.log("Cancelled.");
      process.exitCode = 1;
      return false;
    }
  } finally {
    rl.close();
  }

  return true;
}

function runNodeScript(scriptPath, extraEnv = {}) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number") {
    process.exitCode = result.status;
  }
}

async function main() {
  const command = String(process.argv[2] || "help").trim().toLowerCase();

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "create") {
    const confirmed = await confirmCreate();
    if (!confirmed) return;
    runNodeScript(path.join(PROJECT_DIR, "order-km.js"), { ORDER_KM_MODE: "single" });
    return;
  }

  if (command === "status") {
    runNodeScript(path.join(PROJECT_DIR, "audit-today.js"));
    return;
  }

  if (command === "export") {
    runNodeScript(path.join(PROJECT_DIR, "export-2026-05-15.js"));
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
