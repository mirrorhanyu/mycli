const { defineCommand } = require("../../src/registry.js");

const DEFAULT_WAIT_MS = 30000;

defineCommand({
  site: "toutiao",
  name: "ping",
  description:
    "Smoke-test the daemon → userscript → main-world bridge on the Toutiao publish page.",
  async run({ options, sendCommand, site }) {
    const waitMs =
      options.wait && options.wait !== true ? Number(options.wait) : DEFAULT_WAIT_MS;
    if (!Number.isFinite(waitMs) || waitMs <= 0) {
      throw new Error(`Invalid --wait value: ${options.wait}`);
    }

    const result = await sendCommand({
      site,
      action: "ping",
      args: { message: options.message && options.message !== true ? String(options.message) : "hello" },
      timeoutMs: waitMs,
    });

    process.stdout.write(JSON.stringify(result, null, 2));
    process.stdout.write("\n");
  },
});
