const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.join(__dirname, "..", "clis", "bilibili", "userscript.user.js"),
  "utf8",
);

test("Bilibili userscript runs only in the top frame", () => {
  assert.match(source, /@noframes/);
});

test("Bilibili sell batches selection-cart add requests in groups of five", () => {
  assert.match(source, /const SELL_BATCH_SIZE = 5;/);
  assert.match(source, /goods: rawGoods/);
  assert.match(source, /chunkItems\(addRows, SELL_BATCH_SIZE\)/);
  assert.doesNotMatch(source, /goods: \[rawGood\]/);
});

test("Bilibili selection-cart queries use five rows per page", () => {
  assert.match(
    source,
    /fetchSelectionCartRows\(itemIds, referer, pageSize = SELL_BATCH_SIZE/,
  );
  assert.match(source, /itemIds,\s+referer,\s+SELL_BATCH_SIZE,\s+20,/);
});
