const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function loadPodcastComposerLabelActive() {
  const file = path.resolve(__dirname, "../clis/doubao/userscript.user.js");
  const source = fs.readFileSync(file, "utf8");
  const match = source.match(/function podcastComposerLabelActive\(text\) \{[\s\S]*?\n  \}/);
  if (!match) throw new Error("Could not find podcastComposerLabelActive in userscript");
  return new Function(`${match[0]}; return podcastComposerLabelActive;`)();
}

test("podcastComposerLabelActive recognizes the active composer label", () => {
  const podcastComposerLabelActive = loadPodcastComposerLabelActive();
  assert.equal(podcastComposerLabelActive("输入主题或添加网页、文档"), true);
});

test("podcastComposerLabelActive rejects normal chat labels", () => {
  const podcastComposerLabelActive = loadPodcastComposerLabelActive();
  assert.equal(podcastComposerLabelActive("发消息..."), false);
});
