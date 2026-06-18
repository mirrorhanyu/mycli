const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildDebugArtifact,
  buildSellItems,
  buildSellPlan,
  defaultDebugPath,
  mergeSellResults,
  summarizeSellRows,
} = require("../clis/bilibili/sell-lib.js");

test("buildSellItems supports compact bilibili.json arrays", () => {
  const items = buildSellItems([
    { url: "https://item.jd.com/1.html", short: "Phone A" },
    { url: "https://item.jd.com/2.html", short: "Phone B" },
  ]);

  assert.deepEqual(items, [
    { index: 0, url: "https://item.jd.com/1.html", short: "Phone A" },
    { index: 1, url: "https://item.jd.com/2.html", short: "Phone B" },
  ]);
});

test("buildSellPlan skips sell_status ok rows unless forced", () => {
  const input = [
    { url: "https://item.jd.com/1.html", short: "Phone A", sell_status: "ok" },
    { url: "https://item.jd.com/2.html", short: "Phone B" },
  ];

  assert.deepEqual(buildSellPlan(input), {
    processItems: [
      { index: 1, url: "https://item.jd.com/2.html", short: "Phone B" },
    ],
    skippedItems: [
      { index: 0, url: "https://item.jd.com/1.html", short: "Phone A" },
    ],
  });

  assert.deepEqual(buildSellPlan(input, { force: true }), {
    processItems: [
      { index: 0, url: "https://item.jd.com/1.html", short: "Phone A" },
      { index: 1, url: "https://item.jd.com/2.html", short: "Phone B" },
    ],
    skippedItems: [],
  });
});

test("mergeSellResults rewrites compact fields only", () => {
  const input = [
    { url: "https://item.jd.com/1.html", short: "Phone A" },
    { url: "https://item.jd.com/2.html", short: "Phone B", bilibili_short_url: "old" },
  ];
  const merged = mergeSellResults(input, [
    {
      url: "https://item.jd.com/1.html",
      status: "ok",
      mid: "11",
      good_id: "22",
      item_id: "33",
      short_url: "https://b23.tv/abc",
      rename_ok: true,
    },
    {
      url: "https://item.jd.com/2.html",
      status: "failed",
      error: "distinguish failed",
    },
  ]);

  assert.deepEqual(merged, [
    {
      url: "https://item.jd.com/1.html",
      short: "Phone A",
      bilibili_mid: "11",
      good_id: "22",
      bilibili_upload_itemId: "33",
      bilibili_short_url: "https://b23.tv/abc",
      setAnotherName: true,
      sell_status: "ok",
    },
    {
      url: "https://item.jd.com/2.html",
      short: "Phone B",
      sell_status: "failed",
      sell_error: "distinguish failed",
    },
  ]);
});

test("mergeSellResults prefers selection_raw commission fields", () => {
  const input = [
    { url: "https://item.jd.com/1.html", short: "Phone A" },
  ];
  const merged = mergeSellResults(input, [
    {
      url: "https://item.jd.com/1.html",
      status: "ok",
      selection_raw: {
        commissionRate: 0.02,
        commissionFee: 88.88,
      },
      distinguish_raw: {
        commissionRate: 0.025,
        commissionFee: 117.6175,
        bestCommissionRate: 0.03,
        bestCommissionFee: 120,
      },
    },
  ]);

  assert.deepEqual(merged, [
    {
      url: "https://item.jd.com/1.html",
      short: "Phone A",
      commissionRate: 0.02,
      commissionFee: 88.88,
      sell_status: "ok",
    },
  ]);
});

test("defaultDebugPath appends sell-debug suffix beside the output file", () => {
  assert.equal(
    defaultDebugPath("/tmp/稿件/bilibili.json"),
    "/tmp/稿件/bilibili.sell-debug.json",
  );
});

test("summaries and debug artifact preserve stable top-level fields", () => {
  const rows = [
    { url: "a", status: "ok" },
    { url: "b", status: "partial" },
    { url: "c", status: "failed" },
  ];
  assert.deepEqual(summarizeSellRows(rows), {
    total: 3,
    ok: 1,
    partial: 1,
    failed: 1,
  });

  const artifact = buildDebugArtifact({
    inputPath: "/tmp/in.json",
    outputPath: "/tmp/out.json",
    rows,
    browserResult: { debug: { distinguish: [] } },
    skippedItems: [{ index: 1, url: "u", short: "s" }],
    force: true,
  });

  assert.equal(artifact.input_path, "/tmp/in.json");
  assert.equal(artifact.output_path, "/tmp/out.json");
  assert.equal(artifact.force, true);
  assert.deepEqual(artifact.skipped_items, [{ index: 1, url: "u", short: "s" }]);
  assert.deepEqual(artifact.summary, {
    total: 3,
    ok: 1,
    partial: 1,
    failed: 1,
  });
  assert.deepEqual(artifact.rows, rows);
  assert.deepEqual(artifact.browser_result, { debug: { distinguish: [] } });
  assert.match(artifact.generated_at, /^\d{4}-\d{2}-\d{2}T/);
});
