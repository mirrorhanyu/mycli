const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_WAIT_MS = 300000;
const MAX_ATTACHMENT_BYTES = 500 * 1024 * 1024;
const MODES = new Set(["instant", "expert", "vision"]);

function promptFromOptions(options) {
  if (options.text && options.file) {
    throw new Error("Use either --text or --file, not both");
  }
  if (options.text && options.text !== true) return String(options.text);
  if (options.file && options.file !== true) {
    return fs.readFileSync(path.resolve(String(options.file)), "utf8");
  }
  throw new Error("Missing --text or --file");
}

function modeFromOptions(options) {
  const raw = options.mode === undefined ? "instant" : options.mode;
  if (raw === true || !MODES.has(String(raw))) {
    throw new Error(`Invalid --mode value: ${raw}. Expected instant, expert, or vision`);
  }
  return String(raw);
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

function normalizeOptionList(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function resolveAttachment(value) {
  if (!value || value === true) {
    throw new Error("Missing value for --attach/--attachment");
  }
  const filePath = path.resolve(String(value));
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
  if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment is too large: ${filePath}`);
  return { path: filePath, name: path.basename(filePath), size: stat.size };
}

function attachmentsFromOptions(options) {
  const ordered = Array.isArray(options.__ordered)
    ? options.__ordered
        .filter((entry) => entry.key === "attach" || entry.key === "attachment")
        .map((entry) => entry.value)
    : [];
  const values =
    ordered.length > 0
      ? ordered
      : [...normalizeOptionList(options.attach), ...normalizeOptionList(options.attachment)];
  return values.map(resolveAttachment);
}

module.exports = {
  DEFAULT_WAIT_MS,
  MODES,
  attachmentsFromOptions,
  modeFromOptions,
  pickWaitMs,
  promptFromOptions,
};
