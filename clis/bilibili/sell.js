const path = require("node:path");
const { defineCommand } = require("../../src/registry.js");
const {
  buildDebugArtifact,
  buildSellItems,
  buildSellPlan,
  defaultDebugPath,
  mergeSellResults,
  readJsonFile,
  resolveJsonPath,
  summarizeSellRows,
  writeJsonFile,
} = require("./sell-lib.js");

const DEFAULT_TIMEOUT_BASE_MS = 60000;
const DEFAULT_TIMEOUT_PER_ITEM_MS = 10000;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;

function parseBoolean(raw) {
  return raw === true || raw === "true" || raw === "1" || raw === 1;
}

function customTimeout(options, itemCount) {
  const raw = Number(options["timeout-ms"] ?? options.timeout_ms);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return Math.min(
    MAX_TIMEOUT_MS,
    DEFAULT_TIMEOUT_BASE_MS + Math.max(1, itemCount) * DEFAULT_TIMEOUT_PER_ITEM_MS,
  );
}

defineCommand({
  site: "bilibili",
  name: "sell",
  description: "Upload commerce items from a JSON file and rewrite compact Bilibili sell fields.",
  async run({ options, positional = [], sendCommand, site }) {
    const inputArg = positional[0] || options.file || options.input;
    if (!inputArg || inputArg === true) {
      throw new Error("Usage: mycli bilibili sell <path/to/bilibili.json>");
    }

    const inputPath = resolveJsonPath(inputArg);
    const sourceData = readJsonFile(inputPath);
    const force = parseBoolean(options.force);
    const items = buildSellItems(sourceData);
    if (!items.length) {
      throw new Error(`No sell items found in ${inputPath}`);
    }
    const { processItems, skippedItems } = buildSellPlan(sourceData, { force });

    const outputPath = options.output && options.output !== true
      ? path.resolve(String(options.output))
      : inputPath;
    const debugPath = options["debug-file"] && options["debug-file"] !== true
      ? path.resolve(String(options["debug-file"]))
      : defaultDebugPath(outputPath);
    const timeoutMs = customTimeout(options, processItems.length || 1);

    let browserResult = null;
    let rows = [];
    if (processItems.length) {
      browserResult = await sendCommand({
        site,
        action: "sell",
        args: {
          items: processItems,
          skip_rename: parseBoolean(options["skip-rename"]),
        },
        timeoutMs,
      });

      rows = Array.isArray(browserResult?.items) ? browserResult.items : [];
      if (!rows.length) {
        throw new Error("Bilibili sell returned no item results");
      }
    }

    const updated = mergeSellResults(sourceData, rows);
    writeJsonFile(outputPath, updated);
    writeJsonFile(debugPath, buildDebugArtifact({
      inputPath,
      outputPath,
      browserResult,
      rows,
      skippedItems,
      force,
    }));

    const summary = summarizeSellRows(rows);
    const result = {
      input_path: inputPath,
      output_path: outputPath,
      debug_path: debugPath,
      summary: {
        total: items.length,
        attempted: processItems.length,
        skipped: skippedItems.length,
        ok: summary.ok + skippedItems.length,
        partial: summary.partial,
        failed: summary.failed,
      },
    };

    if (parseBoolean(options.json)) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    const lines = [];
    lines.push(`输入: ${inputPath}`);
    lines.push(`回写: ${outputPath}`);
    lines.push(`调试: ${debugPath}`);
    lines.push(`总数: ${result.summary.total}`);
    lines.push(`尝试上传: ${result.summary.attempted}`);
    lines.push(`跳过: ${result.summary.skipped}`);
    lines.push(`成功: ${result.summary.ok}`);
    lines.push(`部分成功: ${result.summary.partial}`);
    lines.push(`失败: ${result.summary.failed}`);
    process.stdout.write(`${lines.join("\n")}\n`);
  },
});
