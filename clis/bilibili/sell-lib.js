const fs = require("node:fs");
const path = require("node:path");

const WRITABLE_FIELDS = [
  "bilibili_mid",
  "good_id",
  "bilibili_upload_itemId",
  "bilibili_short_url",
  "commissionRate",
  "commissionFee",
  "setAnotherName",
  "sell_status",
  "sell_error",
];

function safeText(value) {
  return String(value ?? "").trim();
}

function resolveJsonPath(raw) {
  const value = safeText(raw);
  if (!value) {
    throw new Error("Missing input JSON path");
  }
  return path.resolve(value);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function itemCollection(data) {
  if (Array.isArray(data)) {
    return { kind: "array", items: data };
  }
  if (data && typeof data === "object" && Array.isArray(data.links)) {
    return { kind: "links", items: data.links };
  }
  throw new Error("Input JSON must be an array or an object with a links array");
}

function itemUrl(item) {
  return safeText(item?.url || item?.pc_url);
}

function itemShort(item) {
  return safeText(item?.short || item?.title || item?.anotherName);
}

function normalizeCommissionValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const text = String(value).trim();
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : text;
}

function readCommissionValue(row, key) {
  const direct = normalizeCommissionValue(row?.[key]);
  if (direct !== null) return direct;

  const fromSelection = normalizeCommissionValue(row?.selection_raw?.[key]);
  if (fromSelection !== null) return fromSelection;

  const fromDistinguish = normalizeCommissionValue(row?.distinguish_raw?.[key]);
  if (fromDistinguish !== null) return fromDistinguish;

  const bestKey = key === "commissionRate" ? "bestCommissionRate" : "bestCommissionFee";
  const fromBest = normalizeCommissionValue(row?.distinguish_raw?.[bestKey]);
  if (fromBest !== null) return fromBest;

  return null;
}

function buildSellItems(data) {
  const { items } = itemCollection(data);
  return items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Input item at index ${index} must be an object`);
    }
    const url = itemUrl(item);
    if (!url) {
      throw new Error(`Input item at index ${index} is missing url`);
    }
    return {
      index,
      url,
      short: itemShort(item),
    };
  });
}

function isAlreadySold(item) {
  return safeText(item?.sell_status) === "ok";
}

function buildSellPlan(data, { force = false } = {}) {
  const { items } = itemCollection(data);
  const processItems = [];
  const skippedItems = [];

  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Input item at index ${index} must be an object`);
    }
    const url = itemUrl(item);
    if (!url) {
      throw new Error(`Input item at index ${index} is missing url`);
    }

    const normalized = {
      index,
      url,
      short: itemShort(item),
    };

    if (!force && isAlreadySold(item)) {
      skippedItems.push(normalized);
      continue;
    }

    processItems.push(normalized);
  }

  return { processItems, skippedItems };
}

function cloneJson(data) {
  return JSON.parse(JSON.stringify(data));
}

function mergeSellResults(data, rows) {
  const next = cloneJson(data);
  const { items } = itemCollection(next);
  const rowByUrl = new Map();

  for (const row of rows || []) {
    const url = safeText(row?.url);
    if (!url || rowByUrl.has(url)) continue;
    rowByUrl.set(url, row);
  }

  for (const item of items) {
    const url = itemUrl(item);
    const row = rowByUrl.get(url);
    if (!row) continue;

    for (const field of WRITABLE_FIELDS) {
      delete item[field];
    }

    if (safeText(row.mid)) item.bilibili_mid = safeText(row.mid);
    if (safeText(row.good_id)) item.good_id = safeText(row.good_id);
    if (safeText(row.item_id)) item.bilibili_upload_itemId = safeText(row.item_id);
    if (safeText(row.short_url)) item.bilibili_short_url = safeText(row.short_url);
    const commissionRate = readCommissionValue(row, "commissionRate");
    const commissionFee = readCommissionValue(row, "commissionFee");
    if (commissionRate !== null) item.commissionRate = commissionRate;
    if (commissionFee !== null) item.commissionFee = commissionFee;
    if (row.rename_ok === true) item.setAnotherName = true;

    item.sell_status = safeText(row.status) || "failed";
    if (safeText(row.error)) {
      item.sell_error = safeText(row.error);
    }
  }

  return next;
}

function summarizeSellRows(rows) {
  const summary = {
    total: 0,
    ok: 0,
    partial: 0,
    failed: 0,
  };

  for (const row of rows || []) {
    summary.total += 1;
    if (row?.status === "ok") {
      summary.ok += 1;
    } else if (row?.status === "partial") {
      summary.partial += 1;
    } else {
      summary.failed += 1;
    }
  }

  return summary;
}

function defaultDebugPath(outputPath) {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `${parsed.name}.sell-debug.json`);
}

function buildDebugArtifact({ inputPath, outputPath, browserResult, rows, skippedItems = [], force = false }) {
  return {
    input_path: inputPath,
    output_path: outputPath,
    generated_at: new Date().toISOString(),
    force,
    summary: summarizeSellRows(rows),
    skipped_items: skippedItems,
    rows: rows || [],
    browser_result: browserResult || null,
  };
}

module.exports = {
  buildDebugArtifact,
  buildSellItems,
  buildSellPlan,
  defaultDebugPath,
  itemCollection,
  mergeSellResults,
  readJsonFile,
  resolveJsonPath,
  summarizeSellRows,
  writeJsonFile,
};
