const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildBilibiliIndex,
  buildCommentMarkdown,
  buildCommentMarkdownDetail,
  defaultOutputPath,
  formatPoints,
  skuIdFromUrl,
} = require("../scripts/generate_bilibili_comment_md.js");

test("skuIdFromUrl extracts the JD sku", () => {
  assert.equal(skuIdFromUrl("https://item.jd.com/100278221408.html"), "100278221408");
});

test("formatPoints joins sell points with plus separators", () => {
  assert.equal(formatPoints({ sellPoints: ["165Hz护眼屏", "天玑8500", "9020mAh"] }), "165Hz护眼屏 + 天玑8500 + 9020mAh");
});

test("buildCommentMarkdown renders the last hyperframe item as the highest rank", () => {
  const hyperframeItems = [
    {
      mainSkuId: "1001",
      short: "Alpha",
      sellPoints: ["a1", "a2"],
    },
    {
      mainSkuId: "1002",
      short: "Beta",
      sellPoints: ["b1"],
    },
  ];
  const bilibiliItems = [
    { url: "https://item.jd.com/1001.html", bilibili_short_url: "https://b23.tv/a" },
    { url: "https://item.jd.com/1002.html", bilibili_short_url: "https://b23.tv/b" },
  ];

  assert.equal(
    buildCommentMarkdown(hyperframeItems, bilibiliItems),
    [
      "【第2名 - Alpha】",
      "a1 + a2",
      "https://b23.tv/a",
      "",
      "【第1名 - Beta】",
      "b1",
      "https://b23.tv/b",
      "",
    ].join("\n"),
  );
});

test("buildCommentMarkdownDetail falls back to order when sku changed", () => {
  const hyperframeItems = [
    {
      mainSkuId: "1001",
      short: "Alpha",
      sellPoints: ["a1"],
    },
  ];
  const bilibiliItems = [
    {
      url: "https://item.jd.com/1002.html",
      bilibili_short_url: "https://b23.tv/a",
    },
  ];

  const result = buildCommentMarkdownDetail(hyperframeItems, bilibiliItems);
  assert.equal(result.rendered, [
    "【第1名 - Alpha】",
    "a1",
    "https://b23.tv/a",
    "",
  ].join("\n"));
  assert.deepEqual(result.warnings, ["fallback to index for mainSkuId=1001 at position 1"]);
});

test("defaultOutputPath writes bilibili-comment.md next to hyperframe input", () => {
  assert.equal(
    defaultOutputPath("/tmp/稿件/20260608-122739/hyperframe-input.json"),
    "/tmp/稿件/20260608-122739/bilibili-comment.md",
  );
});
