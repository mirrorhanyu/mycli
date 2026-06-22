const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_WAIT_MS,
  attachmentsFromOptions,
  modeFromOptions,
  pickWaitMs,
  promptFromOptions,
} = require("../clis/deepseek/ask-lib.js");

test("DeepSeek mode defaults to instant", () => {
  assert.equal(modeFromOptions({}), "instant");
});

test("DeepSeek accepts only instant, expert, and vision modes", () => {
  for (const mode of ["instant", "expert", "vision"]) {
    assert.equal(modeFromOptions({ mode }), mode);
  }
  assert.throws(() => modeFromOptions({ mode: "deep" }), /Expected instant, expert, or vision/);
  assert.throws(() => modeFromOptions({ mode: "Expert" }), /Invalid --mode/);
  assert.throws(() => modeFromOptions({ mode: true }), /Invalid --mode/);
});

test("DeepSeek prompt accepts text or a UTF-8 file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mycli-deepseek-"));
  const file = path.join(dir, "prompt.md");
  fs.writeFileSync(file, "from file", "utf8");
  assert.equal(promptFromOptions({ text: "from text" }), "from text");
  assert.equal(promptFromOptions({ file }), "from file");
  assert.throws(() => promptFromOptions({}), /Missing --text or --file/);
  assert.throws(() => promptFromOptions({ text: "a", file }), /either --text or --file/);
});

test("DeepSeek timeout follows timeout_ms, wait, then default precedence", () => {
  assert.equal(pickWaitMs({}), DEFAULT_WAIT_MS);
  assert.equal(pickWaitMs({ wait: "1200" }), 1200);
  assert.equal(pickWaitMs({ wait: "1200", timeout_ms: "2400" }), 2400);
  assert.throws(() => pickWaitMs({ wait: "0" }), /Invalid/);
  assert.throws(() => pickWaitMs({ timeout_ms: "nope" }), /Invalid/);
});

test("DeepSeek attachments preserve mixed option order", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mycli-deepseek-"));
  const one = path.join(dir, "one.png");
  const two = path.join(dir, "two.jpg");
  fs.writeFileSync(one, "one");
  fs.writeFileSync(two, "two");
  const options = {};
  Object.defineProperty(options, "__ordered", {
    value: [
      { key: "attachment", value: two },
      { key: "attach", value: one },
    ],
  });
  assert.deepEqual(
    attachmentsFromOptions(options).map((item) => item.name),
    ["two.jpg", "one.png"],
  );
});
