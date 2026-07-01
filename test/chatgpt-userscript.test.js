const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.resolve(__dirname, "../clis/chatgpt/userscript.user.js"),
  "utf8",
);

test("ChatGPT userscript exposes the three intelligence modes", () => {
  const block = source.match(/const MODE_LABELS = \{[\s\S]*?\n  \};/);
  assert.ok(block);
  const mapping = new Function(`${block[0]}; return MODE_LABELS;`)();
  assert.deepEqual(mapping, {
    instant: "Instant",
    medium: "Medium",
    high: "High",
  });
});

test("ChatGPT userscript uses stable composer and image selectors", () => {
  assert.match(source, /form\[data-type="unified-composer"\]/);
  assert.match(source, /composer-intelligence-picker-content/);
  assert.match(source, /img\[alt\^="Generated image:"\]/);
  assert.match(source, /image-gen-overlay-actions/);
});

test("ChatGPT userscript downloads generated images through the local upload endpoint", () => {
  assert.match(source, /GM_xmlhttpRequest/);
  assert.match(source, /HTTP_API}\/upload/);
  assert.match(source, /saved_path/);
});

test("ChatGPT userscript uses the HTTP bridge instead of page WebSocket", () => {
  assert.match(source, /\/bridge\/poll/);
  assert.match(source, /\/bridge\/result/);
  assert.doesNotMatch(source, /new WebSocket/);
});

test("ChatGPT userscript runs once per top-level tab and keeps a stable tab id", () => {
  assert.match(source, /@noframes/);
  assert.match(source, /window\.top !== window\.self/);
  assert.match(source, /sessionStorage\.getItem\(TAB_ID_KEY\)/);
  assert.match(source, /sessionStorage\.setItem\(TAB_ID_KEY, id\)/);
});
