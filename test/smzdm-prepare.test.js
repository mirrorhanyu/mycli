const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  extractProductLinks,
  jdSkuFromUrl,
  parseJdProductUrl,
  prepareDraftPayload,
} = require("../clis/smzdm/prepare.js");

test("SMZDM extracts standalone JD links as product-card markers", () => {
  const html = [
    '<p><a href="https://item.jd.com/100349663228.html">去京东看看 →</a></p>',
    '<p><a href="https://u.jd.com/9g8ZUlR">京东短链 →</a></p>',
    '<p>正文里的<a href="https://item.jd.com/100349257480.html">内联链接</a>不算卡片</p>',
    '<p><a href="https://notjd.com/item">不是京东</a></p>',
  ].join("\n");
  assert.deepEqual(extractProductLinks(html), [
    {
      index: 0,
      platform: "jd",
      sku: "100349663228",
      key: "jd:100349663228",
      url: "https://item.jd.com/100349663228.html",
      label: "去京东看看 →",
    },
    {
      index: 1,
      platform: "jd",
      sku: null,
      key: "jd-url:u.jd.com/9g8ZUlR",
      url: "https://u.jd.com/9g8ZUlR",
      label: "京东短链 →",
    },
  ]);
});

test("SMZDM recognizes encoded JD URLs", () => {
  assert.equal(
    jdSkuFromUrl("https%3A%2F%2Fitem.jd.com%2F100349663228.html"),
    "100349663228",
  );
});

test("SMZDM accepts HTTPS links on JD subdomains only", () => {
  assert.deepEqual(parseJdProductUrl("https://u.jd.com/9g8ZUlR"), {
    sku: null,
    key: "jd-url:u.jd.com/9g8ZUlR",
    url: "https://u.jd.com/9g8ZUlR",
  });
  assert.deepEqual(
    parseJdProductUrl(
      "https://jingfen.jd.com/detail/xPQvgvvEXOVxvRAQGXXUxvRSNW1DvQ_3LZQVeaNjjbvFcKe6q.html",
    ),
    {
      sku: null,
      key:
        "jd-url:jingfen.jd.com/detail/xPQvgvvEXOVxvRAQGXXUxvRSNW1DvQ_3LZQVeaNjjbvFcKe6q.html",
      url:
        "https://jingfen.jd.com/detail/xPQvgvvEXOVxvRAQGXXUxvRSNW1DvQ_3LZQVeaNjjbvFcKe6q.html",
    },
  );
  assert.equal(parseJdProductUrl("http://u.jd.com/9g8ZUlR"), null);
  assert.equal(parseJdProductUrl("https://eviljd.com/9g8ZUlR"), null);
  assert.equal(parseJdProductUrl("https://jd.com.evil.example/9g8ZUlR"), null);
});

test("SMZDM draft preparation tolerates literal percent signs in image paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mycli-smzdm-"));
  const imageDir = path.join(root, "100% DCI-P3 (RTX5060");
  fs.mkdirSync(imageDir);
  fs.writeFileSync(path.join(imageDir, "cover.png"), "png");
  const markdown = path.join(root, "draft.md");
  fs.writeFileSync(
    markdown,
    [
      "# 标题",
      "",
      "![](<100% DCI-P3 (RTX5060/cover.png>)",
      "",
      "[去京东看看 →](https://item.jd.com/100349663228.html)",
    ].join("\n"),
  );

  const payload = prepareDraftPayload(markdown);
  assert.equal(payload.image_occurrence_count, 1);
  assert.equal(payload.product_link_count, 1);
  assert.equal(payload.product_links[0].key, "jd:100349663228");
});
