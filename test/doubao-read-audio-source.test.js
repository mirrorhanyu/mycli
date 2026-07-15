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

function loadExtractFloat32Arrays() {
  const file = path.resolve(__dirname, "../clis/doubao/userscript.user.js");
  const source = fs.readFileSync(file, "utf8");
  const match = source.match(/function extractFloat32Arrays\(value, output = \[\], seen = new Set\(\), depth = 0\) \{[\s\S]*?\n  \}/);
  if (!match) throw new Error("Could not find extractFloat32Arrays in userscript");
  return new Function(`${match[0]}; return extractFloat32Arrays;`)();
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

test("extractFloat32Arrays finds nested Doubao dataIn PCM payloads", () => {
  const extractFloat32Arrays = loadExtractFloat32Arrays();
  const pcm = new Float32Array([0.1, -0.2]);
  const chunks = extractFloat32Arrays({ data: { data: pcm } });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], pcm);
});

test("read audio quiet fallback does not depend on stale DOM playing state", () => {
  const file = path.resolve(__dirname, "../clis/doubao/userscript.user.js");
  const source = fs.readFileSync(file, "utf8");
  const match = source.match(/if \(playbackChunkCount && sawPlaying && quietFor > READ_AUDIO_QUIET_MS[\s\S]*?return `Read audio saved/);
  if (!match) throw new Error("Could not find read audio quiet fallback");
  assert.equal(match[0].includes("!playing"), false);
});

test("short read audio retry resets capture before replaying", () => {
  const file = path.resolve(__dirname, "../clis/doubao/userscript.user.js");
  const source = fs.readFileSync(file, "utf8");
  const match = source.match(/const retryShortCapture = async \(\) => \{[\s\S]*?\n    \};/);
  if (!match) throw new Error("Could not find retryShortCapture in userscript");
  assert.match(match[0], /resetReadAudioCapture\(\);[\s\S]*humanClick\(retryButton\)/);
});
