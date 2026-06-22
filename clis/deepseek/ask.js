const { defineCommand } = require("../../src/registry.js");
const {
  attachmentsFromOptions,
  modeFromOptions,
  pickWaitMs,
  promptFromOptions,
} = require("./ask-lib.js");

defineCommand({
  site: "deepseek",
  name: "ask",
  description: "Send a prompt to DeepSeek and print the final answer.",
  async run({ options, sendCommand, site }) {
    const prompt = promptFromOptions(options);
    const mode = modeFromOptions(options);
    const waitMs = pickWaitMs(options);
    const attachments = attachmentsFromOptions(options);

    const result = await sendCommand({
      site,
      action: "ask",
      args: { prompt, mode, wait_ms: waitMs, attachments },
      timeoutMs: waitMs + 5000,
    });

    const answer = typeof result === "string" ? result : (result && result.answer) || "";
    process.stdout.write(answer);
    if (answer && !answer.endsWith("\n")) process.stdout.write("\n");
  },
});
