const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_WAIT_MS = 15 * 60 * 1000;
const MODES = new Set(["instant", "medium", "high"]);

function promptFromInputs(options, positional = []) {
  const positionalPrompt = positional.length ? positional.join(" ") : "";
  const textPrompt = options.text && options.text !== true ? String(options.text) : "";
  const fileOption = options.file && options.file !== true ? String(options.file) : "";
  const supplied = [positionalPrompt, textPrompt, fileOption].filter(Boolean);
  if (supplied.length > 1) {
    throw new Error("Use one prompt source: positional text, --text, or --file");
  }
  if (fileOption) return fs.readFileSync(path.resolve(fileOption), "utf8");
  if (textPrompt) return textPrompt;
  if (positionalPrompt) return positionalPrompt;
  throw new Error('Missing prompt. Use mycli chatgpt image "prompt" or --file prompt.md');
}

function modeFromOptions(options) {
  const raw = options.mode === undefined ? "high" : options.mode;
  const mode = String(raw).toLowerCase();
  if (raw === true || !MODES.has(mode)) {
    throw new Error(`Invalid --mode value: ${raw}. Expected Instant, Medium, or High`);
  }
  return mode;
}

function pickWaitMs(options) {
  const raw =
    options.timeout_ms !== undefined && options.timeout_ms !== true
      ? options.timeout_ms
      : options.wait !== undefined && options.wait !== true
        ? options.wait
        : null;
  if (raw === null) return DEFAULT_WAIT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid --timeout_ms/--wait value: ${raw}`);
  }
  return value;
}

function booleanOption(value, defaultValue) {
  if (value === undefined) return defaultValue;
  if (value === true) return true;
  const normalized = String(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function downloadFromOptions(options) {
  if (options["no-download"] !== undefined) {
    return !booleanOption(options["no-download"], true);
  }
  return booleanOption(options.download, true);
}

function renameFromOptions(options) {
  const raw = options.rename === undefined ? options.name : options.rename;
  if (raw === undefined) return null;
  if (raw === true || !String(raw).trim()) {
    throw new Error("Missing filename for --rename");
  }
  return String(raw).trim();
}

function outputDirFromOptions(options) {
  const raw = options["out-dir"] === undefined ? options.output_dir : options["out-dir"];
  if (raw === undefined) return undefined;
  if (raw === true || !String(raw).trim()) {
    throw new Error("Missing directory for --out-dir");
  }
  return path.resolve(String(raw));
}

module.exports = {
  DEFAULT_WAIT_MS,
  MODES,
  downloadFromOptions,
  modeFromOptions,
  outputDirFromOptions,
  pickWaitMs,
  promptFromInputs,
  renameFromOptions,
};
