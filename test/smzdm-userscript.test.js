const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.join(__dirname, "..", "clis", "smzdm", "userscript.user.js"),
  "utf8",
);

test("SMZDM userscript generates native product cards from standalone JD links", () => {
  assert.match(source, /@version\s+0\.3\.13/);
  assert.match(source, /function productStepFromElement/);
  assert.match(source, /\/api\/editor\/card\/search/);
  assert.match(source, /storage\.saveCardData\(row\)/);
  assert.match(source, /storage\.fetchCardData\(\)/);
  assert.match(source, /class="insert-card-editor"/);
  assert.match(source, /generated_product_card_count/);
});

test("SMZDM batches the final long_article fetch after generating cards", () => {
  assert.match(source, /for \(const card of cardsByKey\.values\(\)\) storage\.setCardId/);
  assert.match(source, /await storage\.fetchCardData\(\)/);
  assert.doesNotMatch(source, /preserved_card_count/);
});
