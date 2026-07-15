const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function loadReadActionLabelMatches() {
  const file = path.resolve(__dirname, "../clis/doubao/userscript.user.js");
  const source = fs.readFileSync(file, "utf8");
  const forbiddenMatch = source.match(/function readActionLabelForbidden\(text\) \{[\s\S]*?\n  \}/);
  const match = source.match(/function readActionLabelMatches\(text\) \{[\s\S]*?\n  \}/);
  if (!forbiddenMatch) throw new Error("Could not find readActionLabelForbidden in userscript");
  if (!match) throw new Error("Could not find readActionLabelMatches in userscript");
  return new Function(`${forbiddenMatch[0]}; ${match[0]}; return readActionLabelMatches;`)();
}

function loadUserMessageClassMatches() {
  const file = path.resolve(__dirname, "../clis/doubao/userscript.user.js");
  const source = fs.readFileSync(file, "utf8");
  const match = source.match(/function userMessageClassMatches\(className\) \{[\s\S]*?\n  \}/);
  if (!match) throw new Error("Could not find userMessageClassMatches in userscript");
  return new Function(`${match[0]}; return userMessageClassMatches;`)();
}

test("readActionLabelMatches recognizes 播放 and 朗读 labels", () => {
  const readActionLabelMatches = loadReadActionLabelMatches();
  assert.equal(readActionLabelMatches("播放"), true);
  assert.equal(readActionLabelMatches("朗读"), true);
  assert.equal(readActionLabelMatches("Read aloud"), true);
});

test("readActionLabelMatches rejects stop and pause controls", () => {
  const readActionLabelMatches = loadReadActionLabelMatches();
  assert.equal(readActionLabelMatches("暂停朗读"), false);
  assert.equal(readActionLabelMatches("停止"), false);
  assert.equal(readActionLabelMatches("自动播报"), false);
});

test("readActionLabelMatches rejects body text and download controls", () => {
  const readActionLabelMatches = loadReadActionLabelMatches();
  assert.equal(readActionLabelMatches("这是一段正文，里面提到了播放按钮，但它不是按钮标签"), false);
  assert.equal(readActionLabelMatches("下载音频"), false);
  assert.equal(readActionLabelMatches("播放 下载"), false);
});

test("userMessageClassMatches identifies Doubao send-message bubbles", () => {
  const userMessageClassMatches = loadUserMessageClassMatches();
  assert.equal(userMessageClassMatches("content rounded bg-g-send-msg-bubble-bg text-g-send-msg-bubble-text"), true);
  assert.equal(userMessageClassMatches("flex flex-row w-full justify-end"), true);
  assert.equal(userMessageClassMatches("relative grid w-full grid-cols-[minmax(0,1fr)_auto]"), false);
});
