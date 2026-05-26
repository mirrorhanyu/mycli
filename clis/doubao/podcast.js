const fs = require("node:fs");
const path = require("node:path");
const { defineCommand } = require("../../src/registry.js");

const DEFAULT_WAIT_MS = 10 * 60 * 1000;
const MAX_ATTACHMENT_BYTES = 500 * 1024 * 1024;

function resolveAttachment(value) {
  if (!value || value === true) throw new Error("Missing --file");
  const filePath = path.resolve(String(value));
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
  if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment is too large: ${filePath}`);
  return { path: filePath, name: path.basename(filePath), size: stat.size };
}

defineCommand({
  site: "doubao",
  name: "podcast",
  description: "Upload a file to Doubao AI Podcast and save the generated audio.",
  async run({ options, sendCommand, site }) {
    const attachment = resolveAttachment(options.file || options.attach || options.attachment);

    const prompt =
      options.prompt && options.prompt !== true
        ? String(options.prompt)
        : options.text && options.text !== true
          ? String(options.text)
          : options["prompt-file"] && options["prompt-file"] !== true
            ? fs.readFileSync(path.resolve(String(options["prompt-file"])), "utf8")
            : "基于这个文件生成 AI 播客";

    const waitMs = options.wait && options.wait !== true ? Number(options.wait) : DEFAULT_WAIT_MS;
    if (!Number.isFinite(waitMs) || waitMs <= 0) {
      throw new Error(`Invalid --wait value: ${options.wait}`);
    }

    const outputDirOption = options["out-dir"] || options.out;
    const outputDir = outputDirOption && outputDirOption !== true ? path.resolve(String(outputDirOption)) : undefined;

    const result = await sendCommand({
      site,
      action: "podcast",
      args: {
        prompt,
        wait_ms: waitMs,
        attachment: { path: attachment.path, name: attachment.name, size: attachment.size },
        output_dir: outputDir,
      },
      timeoutMs: waitMs + 5000,
    });

    const text = typeof result === "string" ? result : (result && result.message) || JSON.stringify(result);
    process.stdout.write(text);
    if (text && !text.endsWith("\n")) process.stdout.write("\n");
  },
});
