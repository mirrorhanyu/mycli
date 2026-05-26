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

defineCommand({
  site: "doubao",
  name: "ask",
  description: "Send a prompt to Doubao and print the answer.",
  async run({ options, sendCommand, site }) {
    const prompt = promptFromOptions(options);
    const waitMs = options.wait && options.wait !== true ? Number(options.wait) : DEFAULT_WAIT_MS;
    if (!Number.isFinite(waitMs) || waitMs <= 0) {
      throw new Error(`Invalid --wait value: ${options.wait}`);
    }

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
