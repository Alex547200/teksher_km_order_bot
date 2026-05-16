const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const PROJECT_DIR = __dirname;
const OPERATIONS_URL = "https://label.teksher.kg/operations";
const LOGIN_URL = "https://label.teksher.kg/login";
const SESSION_PROFILE_DIR = path.join(PROJECT_DIR, "teksher-session-profile");
const TMP_DIR = path.join(PROJECT_DIR, "tmp");
const DEBUG_DIR = path.join(PROJECT_DIR, "debug", "download-teksher-print-pdfs-16may");
const OUTPUT_DIR = path.join(os.homedir(), "Desktop", "Текшер PDF", "16.05.2026");
const LOG_PATH = path.join(OUTPUT_DIR, "downloads_16may_log.json");
const TARGET_TYPE = "Заказ на эмиссию КМ";
const TARGET_DATE = "16.05.2026";
const TARGET_DATE_ISO = "2026-05-16";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT = 30000;
const DOWNLOAD_TIMEOUT = 60000;
const DEBUG_DATE_ONLY = false;
const DEBUG_DATE_DISCOVERY_ONLY = false;
const PRINT_TEMPLATE = "Data Matrix код — горизонтальный с описанием товара";
const PRINT_TEMPLATE_VARIANTS = [
  "Data Matrix код — горизонтальный с описанием товара",
  "Data Matrix код - горизонтальный с описанием товара",
  "Data Matrix код горизонтальный с описанием товара",
  "Data Matrix код — горизонтальный",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStatus(value) {
  return normalizeText(value).toUpperCase();
}

function sanitizeFilePart(value) {
  return normalizeText(value)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

async function waitForNoTmpDownloads(dir) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const files = await fs.readdir(dir).catch(() => []);
    if (!files.some((name) => name.endsWith(".crdownload"))) return true;
    await sleep(1000);
  }
  return false;
}

function uniqueByPair(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${row.operationId}|${row.gtin || row.code || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function getFilterPanel(page) {
  const heading = page.locator("h4:has-text('Фильтрация')").first();
  if (!(await heading.isVisible().catch(() => false))) return null;
  const panel = heading.locator("xpath=ancestor::div[contains(@class,'_content')][1]").first();
  if (!(await panel.count().catch(() => 0))) return null;
  return panel;
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function extractControls(page) {
  return page
    .locator("button,input,select,option,textarea,a,[role='button'],[role='option'],[role='menuitem'],[role='combobox']")
    .evaluateAll((els) => {
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
        value: el.tagName.toLowerCase() === "input" ? el.value || "" : "",
        placeholder: el.getAttribute("placeholder") || "",
        name: el.getAttribute("name") || "",
        id: el.id || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        title: el.getAttribute("title") || "",
        disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
      }));
    });
}

async function saveDebugArtifacts(page, step, extra = {}) {
  await ensureDir(DEBUG_DIR);
  const stamp = `${Date.now()}_${sanitizeFilePart(step) || "step"}`;
  const screenshotPath = path.join(DEBUG_DIR, `${stamp}.png`);
  const htmlPath = path.join(DEBUG_DIR, `${stamp}.html`);
  const controlsPath = path.join(DEBUG_DIR, `${stamp}.controls.json`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  await fs.writeFile(htmlPath, await page.content(), "utf8").catch(() => {});
  const controls = await extractControls(page).catch(() => []);
  await fs.writeFile(
    controlsPath,
    JSON.stringify(
      {
        url: page.url(),
        title: await page.title().catch(() => ""),
        ...extra,
        controls,
      },
      null,
      2,
    ),
    "utf8",
  ).catch(() => {});
  console.error(`DEBUG ${step}:`);
  console.error(`  screenshot: ${screenshotPath}`);
  console.error(`  html: ${htmlPath}`);
  console.error(`  controls: ${controlsPath}`);
  if (controls.length) {
    console.table(
      controls.slice(0, 20).map((c) => ({
        index: c.index,
        tag: c.tag,
        type: c.type,
        role: c.role,
        text: c.text.slice(0, 80),
        placeholder: c.placeholder.slice(0, 40),
        name: c.name,
        id: c.id,
      })),
    );
  }
  return { screenshotPath, htmlPath, controlsPath, controls };
}

async function failWithDebug(page, step, message, error) {
  await saveDebugArtifacts(page, step, {
    message,
    error: error ? { name: error.name, message: error.message, stack: error.stack } : null,
  });
  const suffix = error?.message ? `: ${error.message}` : "";
  throw new Error(`${message}${suffix}`);
}

async function clickVisible(locator) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) {
      await item.click({ timeout: DEFAULT_TIMEOUT });
      return true;
    }
  }
  return false;
}

async function clickText(page, texts, step) {
  const candidates = Array.isArray(texts) ? texts : [texts];
  const locators = [];
  for (const text of candidates) {
    locators.push(
      page.getByRole("button", { name: text, exact: false }),
      page.getByRole("link", { name: text, exact: false }),
      page.getByRole("option", { name: text, exact: false }),
      page.getByRole("menuitem", { name: text, exact: false }),
      page.getByText(text, { exact: false }),
      page.locator(`button:has-text("${text}")`),
      page.locator(`a:has-text("${text}")`),
      page.locator(`[role='button']:has-text("${text}")`),
      page.locator(`[role='option']:has-text("${text}")`),
    );
  }

  for (const locator of locators) {
    if (await clickVisible(locator)) return true;
  }

  if (step) {
    await saveDebugArtifacts(page, step, { missingText: candidates });
  }
  return false;
}

async function clickExactButton(page, name, step) {
  const locator = page.getByRole("button", { name, exact: true });
  if (await clickVisible(locator)) return true;
  const fallback = page.locator(`button:has-text("${name}")`).filter({ hasText: name });
  if (await clickVisible(fallback)) return true;
  if (step) await saveDebugArtifacts(page, step, { missingButton: name });
  return false;
}

async function setNativeSelectByTexts(page, texts) {
  const normalized = texts.map((text) => normalizeText(text).toLowerCase());
  const selects = page.locator("select");
  const count = await selects.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const select = selects.nth(index);
    if (!(await select.isVisible().catch(() => false))) continue;
    const options = await select.locator("option").evaluateAll((nodes) =>
      nodes.map((node) => ({
        text: (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim(),
        value: node.value || "",
      })),
    ).catch(() => []);
    for (const option of options) {
      const hay = normalizeText(`${option.text} ${option.value}`).toLowerCase();
      if (!normalized.some((needle) => hay.includes(needle))) continue;
      await select.selectOption({ value: option.value }).catch(async () => {
        await select.selectOption({ label: option.text }).catch(() => {});
      });
      return true;
    }
  }
  return false;
}

async function setInputByHints(page, hints, value) {
  return page.evaluate(
    ({ hints: rawHints, nextValue, isoValue }) => {
      const hints = rawHints.map((hint) => String(hint).toLowerCase());
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
      };
      const extractHay = (el) => {
        const chunks = [
          el.getAttribute("placeholder"),
          el.getAttribute("aria-label"),
          el.getAttribute("name"),
          el.getAttribute("id"),
          el.getAttribute("title"),
          el.getAttribute("data-testid"),
          el.labels && el.labels.length ? Array.from(el.labels).map((label) => label.innerText || label.textContent || "").join(" ") : "",
          el.closest("label") ? (el.closest("label").innerText || el.closest("label").textContent || "") : "",
          el.closest("[class*='field'],[class*='input'],[role='group']") ? (el.closest("[class*='field'],[class*='input'],[role='group']").innerText || el.closest("[class*='field'],[class*='input'],[role='group']").textContent || "") : "",
        ];
        return chunks.filter(Boolean).join(" ").toLowerCase();
      };
      const setValue = (el) => {
        const isDate = String(el.type || "").toLowerCase() === "date";
        const targetValue = isDate ? isoValue : nextValue;
        const proto = Object.getPrototypeOf(el);
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        if (descriptor?.set) {
          descriptor.set.call(el, targetValue);
        } else {
          el.value = targetValue;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      };
      const elements = Array.from(document.querySelectorAll("input,textarea,[contenteditable='true']")).filter(visible);
      for (const el of elements) {
        const hay = extractHay(el);
        if (!hints.some((hint) => hay.includes(hint))) continue;
        if (el.isContentEditable) {
          el.textContent = nextValue;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        if ("value" in el) return setValue(el);
      }
      return false;
    },
    {
      hints,
      nextValue: value,
      isoValue: TARGET_DATE_ISO,
    },
  );
}

async function setInputByLabelText(page, labelText, value) {
  const input = page
    .locator(`xpath=//span[normalize-space()="${labelText}"]/following::input[1]`)
    .first();
  if (!(await input.count().catch(() => 0))) return false;
  if (!(await input.isVisible().catch(() => false))) return false;
  await input.click({ timeout: DEFAULT_TIMEOUT }).catch(() => {});
  await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await input.fill(value, { timeout: DEFAULT_TIMEOUT }).catch(async () => {
    await input.evaluate((el, nextValue) => {
      const proto = Object.getPrototypeOf(el);
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor?.set) {
        descriptor.set.call(el, nextValue);
      } else {
        el.value = nextValue;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
  });
  return true;
}

async function selectOperationType(page) {
  const primary = page.locator('input[aria-autocomplete="list"][role="combobox"]').first();
  const fallback = page.locator("#react-select-operationFilter-operationType-input").first();
  const opInput = (await primary.count().catch(() => 0)) ? primary : fallback;
  if (!(await opInput.count().catch(() => 0))) return false;
  if (!(await opInput.isVisible().catch(() => false))) return false;

  await opInput.click({ timeout: DEFAULT_TIMEOUT }).catch(() => {});
  await sleep(300);
  await opInput.fill("Заказ на эмиссию КМ").catch(async () => {
    await opInput.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
    await opInput.type("Заказ на эмиссию КМ", { delay: 25 }).catch(() => {});
  });
  await sleep(300);

  const optionLocators = [
    page.getByText("Заказ на эмиссию КМ", { exact: true }),
    page.locator('[id*="option"]').filter({ hasText: "Заказ на эмиссию КМ" }),
    page.locator('[role="option"]').filter({ hasText: "Заказ на эмиссию КМ" }),
    page.locator("div").filter({ hasText: "Заказ на эмиссию КМ" }),
  ];

  for (const locator of optionLocators) {
    if (await clickVisible(locator)) return true;
  }

  return false;
}

async function getFilterValues(page) {
  const panel = await getFilterPanel(page);
  const operationType = panel
    ? await panel.locator("#react-select-operationFilter-operationType-input").evaluate((el) => {
        const value = el.parentElement?.querySelector(".react-select__single-value");
        return value ? value.textContent || "" : "";
      }).catch(() => "")
    : "";
  const inputs = panel ? panel.locator("input.rs-input") : page.locator("input.rs-input");
  const dateFrom = await inputs.nth(0).inputValue().catch(() => "");
  const dateTo = await inputs.nth(1).inputValue().catch(() => "");
  return {
    operationType: normalizeText(operationType),
    dateFrom: normalizeText(dateFrom),
    dateTo: normalizeText(dateTo),
  };
}

async function setDateFields(page) {
  const panel = await getFilterPanel(page);
  const dateInputs = panel ? panel.locator('input.rs-input, input[placeholder="dd.MM.yyyy"]') : page.locator('input.rs-input, input[placeholder="dd.MM.yyyy"]');
  const count = await dateInputs.count().catch(() => 0);
  if (count < 2) return false;

  const fromInput = dateInputs.nth(0);
  const toInput = dateInputs.nth(1);

  const setDateInput = async (input) => {
    await input.click({ timeout: DEFAULT_TIMEOUT }).catch(() => {});
    await input.fill(TARGET_DATE, { timeout: DEFAULT_TIMEOUT }).catch(async () => {
      await input.evaluate((el, nextValue) => {
        const proto = Object.getPrototypeOf(el);
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        if (descriptor?.set) descriptor.set.call(el, nextValue);
        else el.value = nextValue;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, TARGET_DATE);
    });
    await input.press("Tab").catch(() => {});
    await sleep(400);
    const value = await input.inputValue().catch(() => "");
    return value;
  };

  const fromValue = await setDateInput(fromInput);
  await saveDebugArtifacts(page, "before_confirm_date_state", { fromValue, toValue: await toInput.inputValue().catch(() => "") });
  const toValue = await setDateInput(toInput);

  console.log(fromValue);
  console.log(toValue);
  if (fromValue !== TARGET_DATE) throw new Error("DATE_FROM_NOT_SET");
  if (toValue !== TARGET_DATE) throw new Error("DATE_TO_NOT_SET");

  return { fromValue, toValue };
}

async function openDatepickerDebugOnly(page) {
  const dumpDir = path.join(PROJECT_DIR, "debug", "debug-date-filter");
  const dumpPath = path.join(dumpDir, "date_button_and_calendar_dump.txt");
  fsSync.mkdirSync(path.dirname(dumpPath), { recursive: true });
  const dateButton = page.getByText("Дата от: 16.04.2026", { exact: false }).first();
  const buttonVisible = await dateButton.isVisible().catch(() => false);
  if (!buttonVisible) {
    const fallbackButton = page.locator("button").filter({ hasText: "Дата от: 16.04.2026" }).first();
    if (!(await fallbackButton.isVisible().catch(() => false))) {
      const dump = [
        "DATE_BUTTON_NOT_FOUND",
        "",
        "availableButtons:",
        JSON.stringify(await page.locator("button").evaluateAll((els) => els.map((el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim())).catch(() => []), null, 2),
      ].join("\n");
      fsSync.writeFileSync(dumpPath, `${dump}\n`, "utf8");
      console.log(`node dump: ${path.resolve(dumpPath)}`);
      console.log(dump);
      if (!fsSync.existsSync(dumpPath)) throw new Error(`Could not create ${dumpPath}`);
      await saveDebugArtifacts(page, "datepicker_opened_again");
      throw new Error("DATE_BUTTON_NOT_FOUND");
    }
  }

  const button = buttonVisible ? dateButton : page.locator("button").filter({ hasText: "Дата от: 16.04.2026" }).first();
  const buttonOuter = await button.evaluate((el) => ({
    outerHTML: el.outerHTML,
    parentOuterHTML: el.parentElement ? el.parentElement.outerHTML : "",
    grandParentOuterHTML: el.parentElement && el.parentElement.parentElement ? el.parentElement.parentElement.outerHTML : "",
    previousOuterHTML: el.previousElementSibling ? el.previousElementSibling.outerHTML : "",
    nextOuterHTML: el.nextElementSibling ? el.nextElementSibling.outerHTML : "",
  })).catch(() => ({ outerHTML: "", parentOuterHTML: "", grandParentOuterHTML: "", previousOuterHTML: "", nextOuterHTML: "" }));

  await button.click({ force: true, timeout: DEFAULT_TIMEOUT }).catch(async () => {
    await button.click({ timeout: DEFAULT_TIMEOUT }).catch(() => {});
  });
  await sleep(500);

  const calendarTexts = ["16", "Май", "Апрель", "2026", "Следующий", "Предыдущий"];
  const calendarDump = await page.evaluate((texts) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    };
    const nodes = Array.from(document.querySelectorAll("*")).filter(visible);
    return texts.map((needle) => {
      const matches = nodes.filter((node) => (node.innerText || node.textContent || "").includes(needle));
      return {
        needle,
        count: matches.length,
        snippets: matches.slice(0, 20).map((node) => ({
          text: (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim(),
          outerHTML: node.outerHTML,
        })),
      };
    });
  }, calendarTexts).catch(() => []);

  const dump = [
    "DATE_BUTTON_OUTER_HTML:",
    buttonOuter.outerHTML,
    "",
    "DATE_BUTTON_PARENT_OUTER_HTML:",
    buttonOuter.parentOuterHTML,
    "",
    "DATE_BUTTON_GRANDPARENT_OUTER_HTML:",
    buttonOuter.grandParentOuterHTML,
    "",
    "DATE_BUTTON_PREVIOUS_SIBLING_OUTER_HTML:",
    buttonOuter.previousOuterHTML,
    "",
    "DATE_BUTTON_NEXT_SIBLING_OUTER_HTML:",
    buttonOuter.nextOuterHTML,
    "",
    "CALENDAR_DUMP:",
    JSON.stringify(calendarDump, null, 2),
  ].join("\n");

  fsSync.writeFileSync(dumpPath, `${dump}\n`, "utf8");
  console.log(`node dump: ${path.resolve(dumpPath)}`);
  console.log(dump);
  if (!fsSync.existsSync(dumpPath)) {
    throw new Error(`Could not create ${dumpPath}`);
  }

  await saveDebugArtifacts(page, "datepicker_opened_again");
  throw new Error("DATEPICKER_OPENED_DEBUG_ONLY");
}

async function assertFilters(page) {
  const values = await getFilterValues(page);
  const ok =
    values.operationType.includes(TARGET_TYPE) &&
    values.dateFrom === TARGET_DATE &&
    values.dateTo === TARGET_DATE;
  return { ok, values };
}

async function assertFilterPanelOpen(page) {
  const panel = await getFilterPanel(page);
  const hasHeading = Boolean(panel);
  const inputs = panel ? panel.locator("input.rs-input") : page.locator("input.rs-input");
  const hasDates = (await inputs.nth(0).isVisible().catch(() => false)) && (await inputs.nth(1).isVisible().catch(() => false));
  const confirmButton = panel ? panel.getByRole("button", { name: "Подтвердить", exact: true }).first() : page.getByRole("button", { name: "Подтвердить", exact: true }).first();
  const hasConfirm = await confirmButton.isVisible().catch(() => false);
  return {
    ok: hasHeading && hasDates && hasConfirm,
    details: {
      hasHeading,
      hasDates,
      hasConfirm,
    },
  };
}

async function dumpFilterPanel(page, stepName) {
  const panel = (await getFilterPanel(page)) || page.locator("body").first();
  const panelText = await panel.innerText().catch(() => "");
  const controls = await panel.locator("input,select,button,[role='button'],[role='combobox'],textarea").evaluateAll((els) =>
    els.map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || "",
      role: el.getAttribute("role") || "",
      text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
      value: el.tagName.toLowerCase() === "input" ? el.value || "" : "",
      placeholder: el.getAttribute("placeholder") || "",
      name: el.getAttribute("name") || "",
      id: el.id || "",
      ariaLabel: el.getAttribute("aria-label") || "",
    })),
  ).catch(() => []);
  await saveDebugArtifacts(page, stepName, {
    panelText,
    panelControls: controls,
  });
  console.error(`FILTER PANEL TEXT (${stepName}):\n${panelText}`);
  console.table(controls);
  return { panelText, controls };
}

async function dumpPanelInputs(page) {
  const dumpDir = path.join(PROJECT_DIR, "debug", "debug-date-filter");
  const dumpPath = path.join(dumpDir, "panel_inputs_dump.txt");
  fsSync.mkdirSync(dumpDir, { recursive: true });

  const panel = await getFilterPanel(page);
  const panelHtml = panel ? await panel.evaluate((el) => el.outerHTML).catch(() => "") : "";
  const inputs = panel
    ? await panel.locator("input").evaluateAll((els) =>
        els.map((el, index) => ({
          index,
          outerHTML: el.outerHTML,
          value: el.value || "",
          placeholder: el.getAttribute("placeholder") || "",
          name: el.getAttribute("name") || "",
          role: el.getAttribute("role") || "",
          ariaLabel: el.getAttribute("aria-label") || "",
          ariaAutocomplete: el.getAttribute("aria-autocomplete") || "",
          ariaExpanded: el.getAttribute("aria-expanded") || "",
          ariaHaspopup: el.getAttribute("aria-haspopup") || "",
        })),
      ).catch(() => [])
    : [];

  const payload = [
    "PANEL_HTML:",
    panelHtml || "PANEL_NOT_FOUND",
    "",
    "INPUTS:",
    JSON.stringify(inputs, null, 2),
  ].join("\n");

  fsSync.writeFileSync(dumpPath, `${payload}\n`, "utf8");
  console.log(`panel inputs dump: ${path.resolve(dumpPath)}`);
  console.table(inputs);
  if (!fsSync.existsSync(dumpPath)) throw new Error(`Could not create ${dumpPath}`);
  await saveDebugArtifacts(page, "panel_inputs_debug", { inputsCount: inputs.length });
  return { dumpPath, inputs, panelHtml };
}

async function assertDateFromSet(page) {
  const controls = await extractControls(page).catch(() => []);
  const hasExact = controls.some((control) => {
    const text = normalizeText(`${control.text}${control.value ? ` ${control.value}` : ""}`);
    return text.includes(`Дата от: ${TARGET_DATE}`);
  });
  if (!hasExact) throw new Error("DATE_FROM_NOT_SET");
  return true;
}

async function assertDateFiltersApplied(page) {
  const controls = await extractControls(page).catch(() => []);
  const hasFrom = controls.some((control) => normalizeText(`${control.text} ${control.value}`).includes(`Дата от: ${TARGET_DATE}`));
  const hasTo = controls.some((control) => normalizeText(`${control.text} ${control.value}`).includes(`Дата до: ${TARGET_DATE}`));
  if (!hasFrom) throw new Error("DATE_FROM_NOT_SET");
  if (!hasTo) throw new Error("DATE_TO_NOT_SET");
  return { hasFrom, hasTo, controls };
}

async function setOperationTypeFilter(page) {
  if (await setNativeSelectByTexts(page, [TARGET_TYPE])) return true;

  const comboboxes = page.locator("[role='combobox'], [aria-haspopup='listbox'], input");
  const count = await comboboxes.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const box = comboboxes.nth(index);
    if (!(await box.isVisible().catch(() => false))) continue;
    await box.click({ timeout: DEFAULT_TIMEOUT }).catch(() => {});
    if (await clickText(page, [TARGET_TYPE], "select_operation_type_option")) return true;
    await box.fill(TARGET_TYPE).catch(() => {});
    const matched = await clickText(page, [TARGET_TYPE], "select_operation_type_text");
    if (matched) return true;
  }

  return await clickText(page, [TARGET_TYPE], "select_operation_type_fallback");
}

async function applyFilters(page) {
  const clicked = await clickText(page, ["Подтвердить", "Применить", "Применить фильтр", "Сохранить", "Фильтровать"], "apply_filters");
  if (!clicked) return false;
  await page.waitForLoadState("networkidle", { timeout: DEFAULT_TIMEOUT }).catch(() => {});
  await sleep(1500);
  return true;
}

function extractOperationId(text) {
  const match = String(text || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0] : "";
}

function normalizeDateOnly(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const ddmmyyyy = text.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (ddmmyyyy) return `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  return text.slice(0, 10);
}

function extractFieldFromText(text, labels) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  const normalizedLabels = labels.map((label) => normalizeText(label).toLowerCase());
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lower = line.toLowerCase();
    for (const label of normalizedLabels) {
      if (!lower.includes(label)) continue;
      const parts = line.split(/[:\-–]/);
      if (parts.length > 1) {
        const tail = normalizeText(parts.slice(1).join(":"));
        if (tail) return tail;
      }
      const nextLine = lines[index + 1];
      if (nextLine && !nextLine.toLowerCase().includes(label)) return nextLine;
    }
  }
  for (const label of normalizedLabels) {
    const regex = new RegExp(`${escapeRegex(label)}\\s*[:\\-–]?\\s*(.+)`, "i");
    for (const line of lines) {
      const match = line.toLowerCase().match(regex);
      if (match?.[1]) return normalizeText(match[1]);
    }
  }
  return "";
}

function extractProductInfoFromText(text) {
  const code = extractFieldFromText(text, ["Код товара", "Артикул", "Модель/Артикул", "GTIN", "Код"]);
  const title = extractFieldFromText(text, ["Наименование товара", "Наименование", "Название", "Товар"]);
  const article = extractFieldFromText(text, ["Модель/Артикул", "Артикул", "Модель"]);
  const color = extractFieldFromText(text, ["Цвет"]);
  const size = extractFieldFromText(text, ["Размер"]);
  return {
    code: code || article || "",
    title,
    article,
    color,
    size,
  };
}

async function openOperationFromRow(page, row, operationId) {
  const hrefLink = row.locator("a[href*='/operations/'], a[href*='operationId=']");
  const hrefCount = await hrefLink.count().catch(() => 0);
  if (hrefCount > 0) {
    const first = hrefLink.first();
    if (await first.isVisible().catch(() => false)) {
      await first.click({ timeout: DEFAULT_TIMEOUT });
      return true;
    }
  }

  const clickables = row.locator("button,[role='button'],a,svg");
  const count = await clickables.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = clickables.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    await item.click({ timeout: DEFAULT_TIMEOUT }).catch(async () => {
      await row.click({ timeout: DEFAULT_TIMEOUT });
    });
    return true;
  }

  await row.click({ timeout: DEFAULT_TIMEOUT });
  return true;
}

async function collectOrders(page) {
  const rows = page.locator("table tbody tr, [role='row'], .operation, .operations-row, li, article");
  const count = await rows.count().catch(() => 0);
  const out = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if (!(await row.isVisible().catch(() => false))) continue;
    const text = normalizeText(await row.innerText().catch(() => ""));
    const operationId = extractOperationId(text) || (await row.getAttribute("data-operation-id").catch(() => "")) || "";
    const createdAt = normalizeDateOnly(text.match(/\d{4}-\d{2}-\d{2}[^\s]*/)?.[0] || "");
    if (!operationId) continue;
    out.push({
      rowIndex: index,
      operationId,
      createdAt,
      text,
    });
  }
  return out;
}

async function ensureAuthorizedSession(page) {
  await page.goto(OPERATIONS_URL, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: DEFAULT_TIMEOUT }).catch(() => {});

  if (page.url().includes("/login") || page.url().includes("/sign-in")) {
    console.log("Session is not authorized. Waiting for manual login in the browser window.");
    if (!page.url().includes("/login")) {
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT }).catch(() => {});
    }
    await saveDebugArtifacts(page, "login_required");
    const ok = await page
      .waitForURL(
        (url) => {
          try {
            const parsed = new URL(String(url));
            return parsed.pathname.includes("/operations") && !parsed.pathname.includes("/login") && !parsed.pathname.includes("/sign-in");
          } catch {
            return false;
          }
        },
        { timeout: LOGIN_TIMEOUT_MS },
      )
      .then(() => true)
      .catch(() => false);
    if (!ok) {
      await failWithDebug(page, "login_timeout", "LOGIN_REQUIRED");
    }
    await page.waitForLoadState("networkidle", { timeout: DEFAULT_TIMEOUT }).catch(() => {});
  }

  await saveDebugArtifacts(page, "authorized_operations_page");
}

async function goToPrintFlow(page) {
  const clickedPrintAndApply = await clickText(page, ["Печать и нанесение"], "missing_print_and_nanesenie");
  if (!clickedPrintAndApply) {
    throw new Error('Could not find "Печать и нанесение"');
  }
  await page.waitForLoadState("networkidle", { timeout: DEFAULT_TIMEOUT }).catch(() => {});

  const clickedPrint = await clickText(page, ["Печать"], "missing_print_button_initial");
  if (!clickedPrint) {
    throw new Error('Could not find initial "Печать"');
  }
  await sleep(1000);

  const templateChosen = await setNativeSelectByTexts(page, PRINT_TEMPLATE_VARIANTS);
  if (!templateChosen) {
    const clickedTemplate = await clickText(page, PRINT_TEMPLATE_VARIANTS, "missing_print_template");
    if (!clickedTemplate) {
      throw new Error(`Could not choose print template "${PRINT_TEMPLATE}"`);
    }
  }

  const pdfChosen =
    (await clickText(page, ["PDF файл", "Файл PDF", "PDF", "Документ PDF", "PDF файл"], "missing_pdf_format")) ||
    (await setNativeSelectByTexts(page, ["PDF", "PDF файл", "Файл PDF"]));
  if (!pdfChosen) {
    throw new Error('Could not choose PDF format');
  }

  const finalPrintClicked = await clickText(page, ["Печать"], "missing_final_print_button");
  if (!finalPrintClicked) {
    throw new Error('Could not find final "Печать" button');
  }

  await sleep(500);
}

async function saveDownloadedPdf(download, fileBase, outputDir) {
  const base = sanitizeFilePart(fileBase) || "document";
  let targetPath = path.join(outputDir, `${base}.pdf`);
  let suffix = 2;
  while (await fileExists(targetPath)) {
    targetPath = path.join(outputDir, `${base}_${suffix}.pdf`);
    suffix += 1;
  }
  await download.saveAs(targetPath);
  await waitForNoTmpDownloads(outputDir);
  if (!(await fileExists(targetPath))) {
    throw new Error(`Downloaded PDF not found: ${targetPath}`);
  }
  const stat = await fs.stat(targetPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Downloaded PDF is empty: ${targetPath}`);
  }
  return targetPath;
}

async function main() {
  await ensureDir(OUTPUT_DIR);
  await ensureDir(DEBUG_DIR);
  await ensureDir(TMP_DIR);

  const context = await chromium.launchPersistentContext(SESSION_PROFILE_DIR, {
    headless: false,
    acceptDownloads: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1200 },
    env: {
      ...process.env,
      CHROME_CONFIG_HOME: TMP_DIR,
      XDG_CACHE_HOME: TMP_DIR,
      XDG_CONFIG_HOME: TMP_DIR,
      TMPDIR: TMP_DIR,
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

  const page = context.pages()[0] || (await context.newPage());
  const logs = [];
  const resultRows = [];
  const counts = { total: 0, downloaded: 0, skipped: 0, failed: 0 };

  try {
    await ensureAuthorizedSession(page);

    const clearButton = await clickExactButton(page, "Очистить фильтр", "clear_filter_button").catch(() => false)
      || await clickExactButton(page, "Очистить", "clear_filter_button_alt").catch(() => false);
    if (clearButton) {
      await page.waitForFunction(() => {
        const text = document.body?.innerText || "";
        return !text.includes("Дата от:") && !text.includes("Дата до:");
      }, { timeout: DEFAULT_TIMEOUT }).catch(() => {});
    }

    const filterOpened = await clickExactButton(page, "Фильтры", "missing_filters_button");
    if (!filterOpened) {
      throw new Error('Could not find "Фильтры" button');
    }
    await sleep(1800);
    await saveDebugArtifacts(page, "after_open_filters");

    const filterPanelState = await assertFilterPanelOpen(page);
    if (!filterPanelState.ok) {
      await saveDebugArtifacts(page, "wrong_filter_menu_opened", filterPanelState.details);
      throw new Error(`Wrong panel opened instead of filters: ${JSON.stringify(filterPanelState.details)}`);
    }

    if (!filterPanelState.details.hasDates) {
      await dumpFilterPanel(page, "filters_no_dates");
      const possibleAccordion = await clickText(
        page,
        ["Период", "Дата", "Дополнительно", "Расширить", "Показать", "Развернуть"],
        "filters_try_expand",
      );
      if (possibleAccordion) {
        await sleep(1200);
        await dumpFilterPanel(page, "filters_after_expand");
      }
      const retryState = await assertFilterPanelOpen(page);
      if (!retryState.details.hasDates) {
        await dumpFilterPanel(page, "filters_no_dates_after_retry");
        throw new Error(`Filter panel opened but date fields were not found: ${JSON.stringify(retryState.details)}`);
      }
    }

    await dumpPanelInputs(page);
    throw new Error("PANEL_INPUTS_DEBUG_ONLY");

    const filterState = await assertFilters(page);
    console.log("Found filter values:", filterState.values);
    if (!filterState.ok) {
      await saveDebugArtifacts(page, "filter_values_not_verified", { values: filterState.values });
      throw new Error(`Filter values not verified: ${JSON.stringify(filterState.values)}`);
    }

    await saveDebugArtifacts(page, "after_filter_set", { values: filterState.values });

    const applied = await applyFilters(page);
    if (!applied) {
      await saveDebugArtifacts(page, "filter_apply_not_clicked");
      throw new Error('Could not apply filters with "Подтвердить"/"Применить"');
    }

    await saveDebugArtifacts(page, "after_filters_applied");
    await assertDateFiltersApplied(page);

    await writeJson(LOG_PATH, {
      generatedAt: new Date().toISOString(),
      outputDir: OUTPUT_DIR,
      targetDate: TARGET_DATE,
      targetType: TARGET_TYPE,
      counts,
      logs,
    });

    console.table(
      resultRows.map((row) => ({
        GTIN: row.GTIN,
        operationId: row.operationId,
        status: row.status,
        filePath: row.filePath,
      })),
    );

    console.log(`total orders: ${counts.total}`);
    console.log(`downloaded PDFs: ${counts.downloaded}`);
    console.log(`skipped: ${counts.total - counts.downloaded - counts.failed}`);
    console.log(`failed: ${counts.failed}`);
    console.log(`output folder: ${OUTPUT_DIR}`);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(async (error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
