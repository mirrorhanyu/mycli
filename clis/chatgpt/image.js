const { defineCommand } = require("../../src/registry.js");
const {
  downloadFromOptions,
  modeFromOptions,
  outputDirFromOptions,
  pickWaitMs,
  promptFromInputs,
  renameFromOptions,
} = require("./image-lib.js");

defineCommand({
  site: "chatgpt",
  name: "image",
  description: "Generate an image with ChatGPT and save it locally.",
  async run({ options, positional, sendCommand, site }) {
    const prompt = promptFromInputs(options, positional);
    const mode = modeFromOptions(options);
    const waitMs = pickWaitMs(options);
    const download = downloadFromOptions(options);
    const rename = renameFromOptions(options);
    const outputDir = outputDirFromOptions(options);

    if (rename && !download) {
      throw new Error("--rename requires downloading the generated image");
    }

    const result = await sendCommand({
      site,
      action: "image",
      args: {
        prompt,
        mode,
        wait_ms: waitMs,
        download,
        rename,
        output_dir: outputDir,
      },
      timeoutMs: waitMs + 10000,
    });

    const images = Array.isArray(result?.images) ? result.images : [];
    if (!images.length) throw new Error("ChatGPT returned no generated images");
    for (const image of images) {
      process.stdout.write(`${image.saved_path || image.url}\n`);
    }
  },
});
