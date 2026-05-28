const fs = require("node:fs");
const path = require("node:path");
const { defineCommand } = require("../../src/registry.js");

const DEFAULT_WAIT_MS = 300000;

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

function pickWaitMs(options) {
  // Accept both --timeout_ms (long form, matches daemon API) and --wait
  // (short form). --timeout_ms wins if both are given. Default 5 min.
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

defineCommand({
  site: "doubao",
  name: "ask",
  description: "Send a prompt to Doubao and print the answer.",
  async run({ options, sendCommand, site }) {
    const prompt = promptFromOptions(options);
    const waitMs = pickWaitMs(options);

    const result = await sendCommand({
      site,
      action: "ask",
      args: { prompt, wait_ms: waitMs },
      timeoutMs: waitMs + 5000,
    });

    const answer = typeof result === "string" ? result : (result && result.answer) || "";
    process.stdout.write(answer);
    if (answer && !answer.endsWith("\n")) process.stdout.write("\n");
  },
});
