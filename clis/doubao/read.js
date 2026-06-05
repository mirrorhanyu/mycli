const fs = require("node:fs");
const path = require("node:path");
const { defineCommand } = require("../../src/registry.js");

const DEFAULT_WAIT_MS = 300000;
const DEFAULT_AUDIO_WAIT_MS = 30 * 60 * 1000;
const READ_PREFIX = "我需要你完整的一字不差的把下面的文字返回给我，其余的任何信息我都不要了。";

function textFromOptions(options) {
  if (options.text && options.file) {
    throw new Error("Use either --text or --file, not both");
  }
  if (options.text && options.text !== true) return String(options.text);
  if (options.file && options.file !== true) {
    return fs.readFileSync(path.resolve(String(options.file)), "utf8");
  }
  throw new Error("Missing --text or --file");
}

function pickPositiveNumber(options, keys, fallback) {
  for (const key of keys) {
    const raw = options[key];
    if (raw === undefined || raw === true) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid --${key} value: ${raw}`);
    }
    return value;
  }
  return fallback;
}

function promptFromText(text) {
  return `${READ_PREFIX}\n\n${text}`;
}

defineCommand({
  site: "doubao",
  name: "read",
  description: "Ask Doubao to repeat text, click read-aloud, and save the audio.",
  async run({ options, sendCommand, site }) {
    const text = textFromOptions(options);
    const waitMs = pickPositiveNumber(options, ["timeout_ms", "wait"], DEFAULT_WAIT_MS);
    const audioWaitMs = pickPositiveNumber(options, ["audio-wait", "audio_wait_ms"], DEFAULT_AUDIO_WAIT_MS);
    const outputDirOption = options["out-dir"] || options.out;
    const outputDir = outputDirOption && outputDirOption !== true ? path.resolve(String(outputDirOption)) : undefined;

    const result = await sendCommand({
      site,
      action: "read",
      args: {
        prompt: promptFromText(text),
        wait_ms: waitMs,
        audio_wait_ms: audioWaitMs,
        output_dir: outputDir,
      },
      timeoutMs: waitMs + audioWaitMs + 10000,
    });

    const message = typeof result === "string" ? result : (result && result.message) || JSON.stringify(result);
    process.stdout.write(message);
    if (message && !message.endsWith("\n")) process.stdout.write("\n");
  },
});
