const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_WAIT_MS,
  downloadFromOptions,
  modeFromOptions,
  outputDirFromOptions,
  pickWaitMs,
  promptFromInputs,
  renameFromOptions,
} = require("../clis/chatgpt/image-lib.js");

test("ChatGPT image prompt accepts positional text, --text, or --file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mycli-chatgpt-"));
  const file = path.join(dir, "prompt.md");
  fs.writeFileSync(file, "from file", "utf8");
  assert.equal(promptFromInputs({}, ["draw", "a", "cat"]), "draw a cat");
  assert.equal(promptFromInputs({ text: "from text" }), "from text");
  assert.equal(promptFromInputs({ file }), "from file");
  assert.throws(() => promptFromInputs({}, []), /Missing prompt/);
  assert.throws(() => promptFromInputs({ file }, ["conflict"]), /one prompt source/);
});

test("ChatGPT image mode is case-insensitive and defaults to high", () => {
  assert.equal(modeFromOptions({}), "high");
  for (const mode of ["Instant", "medium", "HIGH"]) {
    assert.equal(modeFromOptions({ mode }), mode.toLowerCase());
  }
  assert.throws(() => modeFromOptions({ mode: "expert" }), /Expected Instant, Medium, or High/);
});

test("ChatGPT image download defaults on and supports explicit disabling", () => {
  assert.equal(downloadFromOptions({}), true);
  assert.equal(downloadFromOptions({ download: true }), true);
  assert.equal(downloadFromOptions({ download: "false" }), false);
  assert.equal(downloadFromOptions({ "no-download": true }), false);
});

test("ChatGPT image validates rename, output directory, and timeout", () => {
  assert.equal(renameFromOptions({ rename: "cover.png" }), "cover.png");
  assert.equal(renameFromOptions({}), null);
  assert.throws(() => renameFromOptions({ rename: true }), /Missing filename/);
  assert.equal(outputDirFromOptions({ "out-dir": "." }), process.cwd());
  assert.equal(pickWaitMs({}), DEFAULT_WAIT_MS);
  assert.equal(pickWaitMs({ wait: "1200" }), 1200);
  assert.throws(() => pickWaitMs({ wait: "0" }), /Invalid/);
});
