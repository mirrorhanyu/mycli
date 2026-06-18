#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    let key;
    let value;
    if (eq >= 0) {
      key = body.slice(0, eq);
      value = body.slice(eq + 1);
    } else {
      key = body;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        value = true;
      } else {
        value = next;
        i += 1;
      }
    }
    options[key] = value;
  }
  return options;
}

function resolvePath(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    throw new Error("Missing path");
  }
  return path.resolve(value);
}

function readJsonArray(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(data)) {
    throw new Error(`JSON must be an array: ${filePath}`);
  }
  return data;
}

function skuIdFromUrl(url) {
  const text = String(url || "").trim();
  const match = text.match(/item\.jd\.com\/(\d+)\.html/i);
  return match ? match[1] : "";
}

function buildBilibiliIndex(items) {
  const index = new Map();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const skuId = String(item.mainSkuId || item.good_id || item.skuId || skuIdFromUrl(item.url)).trim();
    if (!skuId) continue;
    if (!index.has(skuId)) {
      index.set(skuId, item);
    }
  }
  return index;
}

function resolveBilibiliItem(hyperItem, index, bilibiliItems, bilibiliIndex) {
  const skuId = String(hyperItem?.mainSkuId || "").trim();
  const indexedItem = skuId ? bilibiliIndex.get(skuId) : undefined;
  if (indexedItem) {
    return { item: indexedItem, matchedBy: "sku", skuId };
  }
  const fallbackItem = bilibiliItems[index];
  if (fallbackItem) {
    return { item: fallbackItem, matchedBy: "index", skuId };
  }
  return { item: null, matchedBy: "none", skuId };
}

function formatPoints(item) {
  const points = Array.isArray(item?.sellPoints) ? item.sellPoints : [];
  const cleaned = points.map((point) => String(point || "").trim()).filter(Boolean);
  if (cleaned.length) {
    return cleaned.join(" + ");
  }
  const fallback = String(item?.title || "").trim();
  return fallback;
}

function formatCommentBlock(rank, hyperItem, bilibiliItem) {
  const short = String(hyperItem?.short || "").trim();
  const points = formatPoints(hyperItem);
  const url = String(bilibiliItem?.bilibili_short_url || bilibiliItem?.short_url || "").trim();
  if (!url) {
    const skuId = String(hyperItem?.mainSkuId || "").trim();
    throw new Error(`Missing bilibili_short_url for mainSkuId=${skuId || "(unknown)"}`);
  }
  const lines = [
    `【第${rank}名 - ${short}】`,
    points,
    url,
  ];
  return lines.join("\n");
}

function buildCommentMarkdownDetail(hyperItems, bilibiliItems) {
  const bilibiliIndex = buildBilibiliIndex(bilibiliItems);
  const blocks = [];
  const warnings = [];
  const total = hyperItems.length;
  for (let i = 0; i < hyperItems.length; i += 1) {
    const hyperItem = hyperItems[i];
    if (!hyperItem || typeof hyperItem !== "object") {
      throw new Error(`hyperframe item at index ${i} must be an object`);
    }
    const rank = total - i;
    const resolved = resolveBilibiliItem(hyperItem, i, bilibiliItems, bilibiliIndex);
    if (!resolved.item) {
      throw new Error(`Missing bilibili item for mainSkuId=${resolved.skuId || "(unknown)"} at index ${i}`);
    }
    if (resolved.matchedBy === "index" && resolved.skuId) {
      warnings.push(`fallback to index for mainSkuId=${resolved.skuId} at position ${i + 1}`);
    }
    blocks.push(formatCommentBlock(rank, hyperItem, resolved.item));
  }
  return {
    rendered: `${blocks.join("\n\n")}\n`,
    warnings,
  };
}

function buildCommentMarkdown(hyperItems, bilibiliItems) {
  return buildCommentMarkdownDetail(hyperItems, bilibiliItems).rendered;
}

function defaultOutputPath(hyperframeInputPath) {
  return path.join(path.dirname(hyperframeInputPath), "bilibili-comment.md");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const bilibiliArg = args["bilibili-json"] || args.bilibili;
  const hyperframeArg = args["hyperframe-input"] || args.hyperframe;
  if (!bilibiliArg || !hyperframeArg) {
    throw new Error("Usage: generate_bilibili_comment_md.js --bilibili-json <bilibili.json> --hyperframe-input <hyperframe-input.json> [--output <bilibili-comment.md>]");
  }

  const bilibiliPath = resolvePath(bilibiliArg);
  const hyperframePath = resolvePath(hyperframeArg);
  const outputPath = args.output && args.output !== true
    ? resolvePath(args.output)
    : defaultOutputPath(hyperframePath);

  if (!fs.existsSync(bilibiliPath)) {
    throw new Error(`bilibili JSON does not exist: ${bilibiliPath}`);
  }
  if (!fs.existsSync(hyperframePath)) {
    throw new Error(`hyperframe JSON does not exist: ${hyperframePath}`);
  }

  const bilibiliItems = readJsonArray(bilibiliPath);
  const hyperframeItems = readJsonArray(hyperframePath);
  const result = buildCommentMarkdownDetail(hyperframeItems, bilibiliItems);

  fs.writeFileSync(outputPath, result.rendered, "utf8");
  for (const warning of result.warnings) {
    console.error(`[warn] ${warning}`);
  }
  process.stdout.write(`wrote ${hyperframeItems.length} blocks to ${outputPath}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  buildBilibiliIndex,
  buildCommentMarkdown,
  buildCommentMarkdownDetail,
  defaultOutputPath,
  formatCommentBlock,
  formatPoints,
  resolveBilibiliItem,
  readJsonArray,
  skuIdFromUrl,
};
