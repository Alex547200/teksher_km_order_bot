const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] || fallback;
}

const source = arg("--source");
const from = Number(arg("--from", "3"));
const to = Number(arg("--to", "75"));
const outputName = arg("--name", `LP_RF_${from}_${to}_FINAL`);

if (!source) {
  console.error("ERROR: use --source <zip-or-folder>");
  process.exit(1);
}

const repo = process.cwd();
const desktop = path.join(os.homedir(), "Desktop");
const unzipDir = path.join(desktop, `${outputName}_UNZIP`);
const rangeDir = path.join(desktop, outputName);

fs.rmSync(unzipDir, { recursive: true, force: true });
fs.rmSync(rangeDir, { recursive: true, force: true });
fs.mkdirSync(unzipDir, { recursive: true });
fs.mkdirSync(rangeDir, { recursive: true });

let searchRoot = source;

if (source.toLowerCase().endsWith(".zip")) {
  console.log("unzip:", source);
  execFileSync("unzip", ["-q", source, "-d", unzipDir], { stdio: "inherit" });
  searchRoot = unzipDir;
}

function walk(dir) {
  let files = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) files = files.concat(walk(full));
    else files.push(full);
  }
  return files;
}

const files = walk(searchRoot)
  .filter(f => /^LP_RF_\d+\.csv$/i.test(path.basename(f)))
  .sort((a, b) => {
    const na = Number(path.basename(a).match(/\d+/)[0]);
    const nb = Number(path.basename(b).match(/\d+/)[0]);
    return na - nb;
  });

let copied = 0;
let expectedRows = 0;

for (const file of files) {
  const n = Number(path.basename(file).match(/\d+/)[0]);

  if (n >= from && n <= to) {
    const target = path.join(rangeDir, path.basename(file));
    fs.copyFileSync(file, target);
    copied++;

    const rows = fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean).length;

    expectedRows += rows;
    console.log(`${path.basename(file)} rows=${rows} total=${expectedRows}`);
  }
}

console.log("");
console.log("range dir:", rangeDir);
console.log("files copied:", copied);
console.log("expected rows:", expectedRows);

if (copied === 0) {
  console.error("ERROR: no LP_RF files copied");
  process.exit(1);
}

execFileSync("npm", ["run", "merge-km-correct", rangeDir], {
  cwd: repo,
  stdio: "inherit",
});

console.log("");
console.log("DONE");
console.log("output csv:", path.join(desktop, `${outputName}_KM_CORRECT.csv`));
console.log("output check:", path.join(desktop, `${outputName}_KM_CHECK.txt`));
