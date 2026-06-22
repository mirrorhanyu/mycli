const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.resolve(__dirname, "../clis/deepseek/userscript.user.js"),
  "utf8",
);

function loadFunction(name) {
  const match = source.match(new RegExp(`  function ${name}\\([^]*?\\n  \\}`, "m"));
  if (!match) throw new Error(`Could not find ${name} in DeepSeek userscript`);
  return new Function(`${match[0]}; return ${name};`)();
}

test("DeepSeek userscript maps public modes to page model types", () => {
  const block = source.match(/const MODE_MODEL_TYPES = \{[\s\S]*?\n  \};/);
  assert.ok(block);
  const mapping = new Function(`${block[0]}; return MODE_MODEL_TYPES;`)();
  assert.deepEqual(mapping, {
    instant: "default",
    expert: "expert",
    vision: "vision",
  });
});

test("DeepSeek answer cleanup removes thought and control nodes", () => {
  assert.match(source, /readableNodeText/);
  assert.match(source, /["']\.ds-think-content["']/);
  assert.match(source, /["']\.md-code-block-banner-wrap["']/);
  assert.match(source, /ds-assistant-message-main-content/);
});

test("DeepSeek completion requires a response-specific disclaimer", () => {
  const answerIsDone = loadFunction("answerIsDone");
  const children = [{ innerText: "This response is AI-generated, for reference only." }];
  const element = {
    closest() {
      return {
        children,
      };
    },
  };
  global.normalizedText = (node) => node.innerText || "";
  assert.equal(answerIsDone(element), true);
  delete global.normalizedText;
});

test("DeepSeek completion accepts the completed-message action row", () => {
  const answerIsDone = loadFunction("answerIsDone");
  const message = { children: [], parentElement: null };
  const actionRow = {
    querySelectorAll() {
      return [{}, {}, {}, {}, {}];
    },
  };
  message.parentElement = { children: [message, actionRow] };
  global.normalizedText = () => "";
  assert.equal(answerIsDone({ closest: () => message }), true);
  delete global.normalizedText;
});

test("DeepSeek upload checks exclude the userscript status text", () => {
  assert.match(source, /function pageTextWithoutStatus\(\)/);
  assert.match(source, /fullText\.replace\(statusText, ""\)/);
  assert.match(source, /function attachmentCardVisible\(name\)/);
  assert.match(source, /expectedNames\.every\(attachmentCardVisible\)/);
});
