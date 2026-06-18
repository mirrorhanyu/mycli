const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function loadSelectReadAudioSource() {
  const file = path.resolve(__dirname, "../clis/doubao/userscript.user.js");
  const source = fs.readFileSync(file, "utf8");
  const match = source.match(/function selectReadAudioSource\(chunks, pcmChunks\) \{[\s\S]*?\n  \}/);
  if (!match) throw new Error("Could not find selectReadAudioSource in userscript");
  return new Function(`${match[0]}; return selectReadAudioSource;`)();
}

test("selectReadAudioSource prefers PCM when both taps have data", () => {
  const selectReadAudioSource = loadSelectReadAudioSource();
  assert.equal(selectReadAudioSource([new Uint8Array([1])], [new Float32Array([0.1])]), "pcm");
});

test("selectReadAudioSource falls back to encoded when PCM is unavailable", () => {
  const selectReadAudioSource = loadSelectReadAudioSource();
  assert.equal(selectReadAudioSource([new Uint8Array([1])], []), "encoded");
});

test("selectReadAudioSource reports none when nothing was captured", () => {
  const selectReadAudioSource = loadSelectReadAudioSource();
  assert.equal(selectReadAudioSource([], []), "none");
});
