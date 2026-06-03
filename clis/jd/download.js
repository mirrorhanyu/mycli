const fs = require("node:fs");
const path = require("node:path");
const { defineCommand } = require("../../src/registry.js");
const {
  extractGoodId,
  normalizeToDesktopUrl,
  fetchImageUrls,
  downloadFile,
  randomDelay,
  mapWithConcurrency,
  buildImageFilename,
  buildVideoFilename,
  mediaKeyFromUrl,
  imageMediaKeys,
  videoMediaKey,
  videoMediaKeys,
  sameKeys,
  readResourceJson,
  writeResourceSection,
  recordedFilesExist,
} = require("./jd-utils.js");

const VIDEO_TIMEOUT_PER_TASK_MS = 30_000;
const VIDEO_BASE_TIMEOUT_MS = 30_000;
const IMAGE_CONCURRENCY = 6;
// Minimum gap between two *browser* navigations (the cookie-bearing, risk-control
// -tracked requests). The CLI's anonymous HTML/CDN work in between counts toward
// this, so we rarely sleep the full amount.
const DEFAULT_BROWSER_GAP_MS = 15_000;

// Download one product's images from the CDN in parallel, then record them.
// Expects product.imageUrls / product.imageSource from the page-fetch phase.
async function downloadImagesForProduct(product, force) {
  const imageUrls = product.imageUrls || [];
  if (!imageUrls.length) {
    console.log(`[${product.goodId}] 未找到图片`);
    product.imageResult = { status: "error", count: 0, total: 0 };
    return;
  }

  const expectedKeys = imageMediaKeys(imageUrls);
  const imgRec = readResourceJson(product.itemDir).images || {};
  if (
    !force &&
    sameKeys(imgRec.media_keys, expectedKeys) &&
    recordedFilesExist(product.itemDir, imgRec.files)
  ) {
    const count = imgRec.files.length;
    console.log(`[${product.goodId}] 图片未变化，跳过 (${count} 张)`);
    product.imageResult = { status: "skipped", count, total: count };
    return;
  }

  console.log(
    `[${product.goodId}] 发现 ${imageUrls.length} 张图片 (${product.imageSource})，开始下载...`,
  );
  fs.mkdirSync(product.itemDir, { recursive: true });

  const total = imageUrls.length;
  const downloaded = await mapWithConcurrency(
    imageUrls,
    IMAGE_CONCURRENCY,
    async (imageUrl, i) => {
      const filename = buildImageFilename(imageUrl, i + 1, total);
      const destPath = path.join(product.itemDir, filename);
      try {
        const size = await downloadFile(imageUrl, destPath);
        process.stdout.write(
          `  [${product.goodId}] ${filename} (${(size / 1024).toFixed(0)} KB)\n`,
        );
        return { name: filename, media_key: mediaKeyFromUrl(imageUrl), size };
      } catch (error) {
        console.error(`  [${product.goodId}] ${filename} 失败: ${error.message}`);
        return null;
      }
    },
  );
  const files = downloaded.filter(Boolean);

  product.imageResult = {
    status: files.length ? "ok" : "error",
    count: files.length,
    total,
  };
  // Record keys of *successfully* downloaded files only, so a partial failure
  // forces a retry next run instead of being mistaken for complete.
  writeResourceSection(product.itemDir, {
    good_id: product.goodId,
    url: product.desktopUrl,
    images: {
      source: product.imageSource,
      media_keys: [...new Set(files.map((f) => f.media_key))].sort(),
      files,
    },
  });
}

// Decide whether a product still needs a browser round-trip. Returns the
// videoResult to record when it can be skipped, or null when the browser is
// needed. Browser is needed only when: forced, attrs are missing, or the page
// advertises a video we have not already captured.
function videoSkipResult(product, force) {
  if (force) return null;
  const resource = readResourceJson(product.itemDir);
  const videoRec = resource.video || {};
  const hasAttrs = resource.attrs && Object.keys(resource.attrs).length > 0;
  const htmlVid = product.htmlMainVideoId;

  if (!hasAttrs) return null; // attrs only come from the browser
  if (!htmlVid) return { status: "skipped_no_video", count: 0 };

  const alreadyCaptured =
    videoRec.status === "ok" &&
    videoRec.main_video_id === htmlVid &&
    Array.isArray(videoRec.files) &&
    videoRec.files.length === 1 &&
    recordedFilesExist(product.itemDir, videoRec.files);
  if (alreadyCaptured) return { status: "skipped", count: videoRec.files.length };

  return null; // new / not-yet-downloaded video → browser
}

// Download the videos for one product from an extraction result.
async function downloadVideosForProduct(product, result, { force, allVideos }) {
  if (!result) {
    product.videoResult = { status: "no_result", count: 0 };
    return;
  }

  const attrs =
    result.attrs && Object.keys(result.attrs).length ? result.attrs : null;
  if (attrs) {
    writeResourceSection(product.itemDir, { attrs });
  }

  if (result.status === "error") {
    product.videoResult = { status: "error", count: 0, error: result.error };
    return;
  }

  const videos = Array.isArray(result.videos) ? result.videos : [];
  if (!videos.length) {
    product.videoResult = { status: "no_video", count: 0 };
    console.log(`[${product.goodId}] 无视频`);
    writeResourceSection(product.itemDir, {
      video: {
        status: "no_video",
        main_video_id: product.htmlMainVideoId || null,
        media_keys: [],
        files: [],
      },
    });
    return;
  }

  const toDownload = allVideos ? videos : videos.slice(0, 1);
  const expectedKeys = videoMediaKeys(toDownload);
  const videoRec = readResourceJson(product.itemDir).video || {};
  if (
    !force &&
    sameKeys(videoRec.media_keys, expectedKeys) &&
    recordedFilesExist(product.itemDir, videoRec.files)
  ) {
    const count = videoRec.files.length;
    console.log(`[${product.goodId}] 视频未变化，跳过 (${count} 个)`);
    product.videoResult = { status: "skipped", count };
    return;
  }

  console.log(
    `[${product.goodId}] 发现 ${videos.length} 个视频，下载 ${toDownload.length} 个...`,
  );
  fs.mkdirSync(product.itemDir, { recursive: true });

  const files = [];
  const total = toDownload.length;
  for (let i = 0; i < total; i += 1) {
    if (i > 0) await randomDelay(2000, 3000);
    const video = toDownload[i];
    const mainUrl = String(video.mainUrl || "").trim();
    if (!mainUrl) continue;
    const filename = buildVideoFilename(video, i + 1, total, product.goodId);
    const destPath = path.join(product.itemDir, filename);
    try {
      const size = await downloadFile(mainUrl, destPath);
      files.push({ name: filename, media_key: videoMediaKey(video), size });
      process.stdout.write(
        `  [${product.goodId}] ${filename} (${(size / 1024 / 1024).toFixed(1)} MB)\n`,
      );
    } catch (error) {
      console.error(`  [${product.goodId}] ${filename} 失败: ${error.message}`);
    }
  }

  product.videoResult = {
    status: files.length ? "ok" : "error",
    count: files.length,
    total: toDownload.length,
    available: videos.length,
  };
  writeResourceSection(product.itemDir, {
    video: {
      status: files.length ? "ok" : "error",
      main_video_id: product.htmlMainVideoId || null,
      media_keys: [...new Set(files.map((f) => f.media_key))].sort(),
      files,
    },
  });
}

// Ask the browser to extract a single product's video URLs + attrs. Reuses the
// userscript's tasks-array protocol with one task; its per-task delay never
// fires (length 1), so the gap between products is controlled by mycli instead.
async function extractVideoForProduct(product, sendCommand) {
  const results = await sendCommand({
    site: "jd",
    action: "extract_videos",
    args: {
      tasks: [
        {
          url: product.desktopUrl,
          good_id: product.goodId,
          mainVideoId: product.htmlMainVideoId || null,
        },
      ],
    },
    timeoutMs: VIDEO_TIMEOUT_PER_TASK_MS + VIDEO_BASE_TIMEOUT_MS,
  });
  if (!Array.isArray(results)) return null;
  return results.find((r) => r.good_id === product.goodId) || results[0] || null;
}

defineCommand({
  site: "jd",
  name: "download",
  description: "Download product images and videos from JD (京东) item pages.",
  async run({ options, positional = [], sendCommand }) {
    const urls = positional.filter((u) => u.includes("jd.com"));
    if (!urls.length) {
      throw new Error(
        "Usage: mycli jd download <url> [url2 ...] [--out-dir <dir>] [--all-videos] [--force] [--browser-gap <seconds>]",
      );
    }

    const outDir = path.resolve(String(options["out-dir"] || "."));
    const allVideos = Boolean(options["all-videos"]);
    const force = Boolean(options.force);
    // Minimum spacing between risk-control-tracked browser navigations, in
    // seconds (--browser-gap). HTML/image/video CLI work counts toward it.
    const browserGapMs = (() => {
      const v = Number(options["browser-gap"]);
      return Number.isFinite(v) && v >= 0 ? v * 1000 : DEFAULT_BROWSER_GAP_MS;
    })();

    const products = [];
    for (const rawUrl of urls) {
      const goodId = extractGoodId(rawUrl);
      if (!goodId) {
        console.error(`  跳过: 无法提取商品 ID: ${rawUrl}`);
        continue;
      }
      products.push({
        rawUrl,
        desktopUrl: normalizeToDesktopUrl(rawUrl),
        goodId,
        itemDir: path.join(outDir, goodId),
        htmlMainVideoId: null,
        imageResult: null,
        videoResult: null,
      });
    }

    if (!products.length) {
      throw new Error("没有可处理的京东商品 URL");
    }

    console.log(
      `共 ${products.length} 个商品，输出目录: ${outDir}${force ? " (--force 强制重下)" : ""}\n`,
    );

    // Process products one at a time: read page → download images → (if needed)
    // browser-extract video → download video. The CLI work between two browser
    // navigations (HTML fetch, image download, video download) is "free" gap
    // time toward browserGapMs, so spacing out the risk-control-tracked
    // browser calls costs almost no extra wall-clock time.
    let lastBrowserAt = 0;
    let browserUnavailable = false;

    for (let pi = 0; pi < products.length; pi += 1) {
      if (pi > 0) await randomDelay(500, 1200);
      const product = products[pi];

      // 1. Read the page (anonymous CLI fetch): title, image URLs, mainVideoId.
      console.log(`[${product.goodId}] 正在读取页面...`);
      const { urls, source, mainVideoId, title } = await fetchImageUrls(
        product.desktopUrl,
        product.goodId,
      );
      product.imageUrls = urls;
      product.imageSource = source;
      product.htmlMainVideoId = mainVideoId;
      product.title = title;
      // Persist title up front so it is recorded even if images/video are skipped.
      writeResourceSection(product.itemDir, {
        good_id: product.goodId,
        url: product.desktopUrl,
        ...(title ? { title } : {}),
      });

      // 2. Download images (parallel within the product, from the static CDN).
      await downloadImagesForProduct(product, force);

      // 3. Decide whether this product needs a browser round-trip.
      const skip = videoSkipResult(product, force);
      if (skip) {
        product.videoResult = skip;
        if (skip.status === "skipped") {
          console.log(`[${product.goodId}] 视频未变化，跳过浏览器提取`);
        }
        continue;
      }
      if (browserUnavailable) {
        product.videoResult = { status: "no_result", count: 0 };
        continue;
      }

      // 4. Enforce the minimum gap between browser navigations. Time already
      //    spent on this product's HTML + images counts toward it.
      if (lastBrowserAt) {
        const waitMs = browserGapMs - (Date.now() - lastBrowserAt);
        if (waitMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }

      // 5. Browser extraction for this single product.
      console.log(`[${product.goodId}] 通过浏览器提取视频...`);
      let result = null;
      try {
        result = await extractVideoForProduct(product, sendCommand);
      } catch (error) {
        lastBrowserAt = Date.now();
        product.videoResult = { status: "error", count: 0, error: error.message };
        console.error(`[${product.goodId}] 视频提取失败: ${error.message}`);
        if (/userscript|disconnect|connected/i.test(error.message)) {
          browserUnavailable = true;
          console.error("请确保已安装京东 userscript 并打开了任意京东商品页面。");
          console.error(
            "安装地址: open http://127.0.0.1:17872/userscript/jd/mycli.user.js",
          );
          console.error("后续商品将只下载图片，跳过视频提取。");
        }
        continue;
      }
      lastBrowserAt = Date.now();

      // 6. Download this product's video(s).
      await downloadVideosForProduct(product, result, { force, allVideos });
    }

    // --- Summary ---
    console.log("\n--- 下载完成 ---");
    let imageOk = 0;
    let imageSkip = 0;
    let imageFail = 0;
    let videoOk = 0;
    let videoSkip = 0;
    let attrsOk = 0;
    let attrsFail = 0;
    for (const p of products) {
      const imgStatus = p.imageResult?.status;
      if (imgStatus === "ok") imageOk += 1;
      else if (imgStatus === "skipped") imageSkip += 1;
      else imageFail += 1;
      const imgLabel =
        imgStatus === "skipped"
          ? `图片 ${p.imageResult.count} (缓存)`
          : `图片 ${p.imageResult?.count || 0}/${p.imageResult?.total || 0}`;

      let vidLine;
      const vidStatus = p.videoResult?.status;
      if (vidStatus === "ok") {
        vidLine = `视频 ${p.videoResult.count} 个`;
        videoOk += 1;
      } else if (vidStatus === "skipped") {
        vidLine = `视频 ${p.videoResult.count} (缓存)`;
        videoSkip += 1;
      } else if (vidStatus === "no_video" || vidStatus === "skipped_no_video") {
        vidLine = "无视频";
      } else if (!p.videoResult || vidStatus === "no_result") {
        vidLine = "视频跳过";
        videoSkip += 1;
      } else {
        vidLine = `视频失败: ${p.videoResult.error || ""}`;
        videoSkip += 1;
      }

      // Attrs are required: a product with no spec attrs counts as a failure.
      const recordedAttrs = readResourceJson(p.itemDir).attrs;
      const attrCount =
        recordedAttrs && typeof recordedAttrs === "object"
          ? Object.keys(recordedAttrs).length
          : 0;
      const attrLabel = attrCount ? `属性 ${attrCount}` : "属性 缺失✗";
      if (attrCount) attrsOk += 1;
      else attrsFail += 1;

      console.log(`  ${p.goodId}: ${imgLabel} | ${vidLine} | ${attrLabel}`);
    }
    console.log(
      `\n图片: ${imageOk} 下载, ${imageSkip} 缓存, ${imageFail} 失败` +
        ` | 视频: ${videoOk} 下载, ${videoSkip} 缓存/跳过` +
        ` | 属性: ${attrsOk} 成功, ${attrsFail} 失败`,
    );
  },
});
