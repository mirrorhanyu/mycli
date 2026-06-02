const fs = require("node:fs");
const path = require("node:path");
const { defineCommand } = require("../../src/registry.js");
const {
  extractGoodId,
  normalizeToDesktopUrl,
  fetchImageUrls,
  downloadFile,
  randomDelay,
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

defineCommand({
  site: "jd",
  name: "download",
  description: "Download product images and videos from JD (京东) item pages.",
  async run({ options, positional = [], sendCommand }) {
    const urls = positional.filter((u) => u.includes("jd.com"));
    if (!urls.length) {
      throw new Error(
        "Usage: mycli jd download <url> [url2 ...] [--out-dir <dir>] [--all-videos] [--force]",
      );
    }

    const outDir = path.resolve(String(options["out-dir"] || "."));
    const allVideos = Boolean(options["all-videos"]);
    const force = Boolean(options.force);

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
        needExtract: false,
      });
    }

    if (!products.length) {
      throw new Error("没有可处理的京东商品 URL");
    }

    console.log(
      `共 ${products.length} 个商品，输出目录: ${outDir}${force ? " (--force 强制重下)" : ""}\n`,
    );

    // --- Phase 1: Images ---
    // We always fetch the page HTML (cheap) so we can detect updates; only the
    // image *file* downloads are skipped when nothing changed.
    for (let pi = 0; pi < products.length; pi += 1) {
      if (pi > 0) await randomDelay(2000, 4000);
      const product = products[pi];
      console.log(`[${product.goodId}] 正在提取图片...`);
      const { urls: imageUrls, source, mainVideoId } = await fetchImageUrls(
        product.desktopUrl,
        product.goodId,
      );
      product.htmlMainVideoId = mainVideoId;

      if (!imageUrls.length) {
        console.log(`[${product.goodId}] 未找到图片`);
        product.imageResult = { status: "error", count: 0, total: 0 };
        continue;
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
        continue;
      }

      console.log(
        `[${product.goodId}] 发现 ${imageUrls.length} 张图片 (${source})，开始下载...`,
      );
      fs.mkdirSync(product.itemDir, { recursive: true });

      const files = [];
      const total = imageUrls.length;
      for (let i = 0; i < total; i += 1) {
        if (i > 0) await randomDelay(300, 800);
        const imageUrl = imageUrls[i];
        const filename = buildImageFilename(imageUrl, i + 1, total);
        const destPath = path.join(product.itemDir, filename);
        try {
          const size = await downloadFile(imageUrl, destPath);
          files.push({ name: filename, media_key: mediaKeyFromUrl(imageUrl), size });
          process.stdout.write(`  ${filename} (${(size / 1024).toFixed(0)} KB)\n`);
        } catch (error) {
          console.error(`  ${filename} 失败: ${error.message}`);
        }
      }

      product.imageResult = {
        status: files.length ? "ok" : "error",
        count: files.length,
        total,
      };
      // Record keys of *successfully* downloaded files only, so a partial
      // failure forces a retry next run instead of being mistaken for complete.
      writeResourceSection(product.itemDir, {
        good_id: product.goodId,
        url: product.desktopUrl,
        images: {
          source,
          media_keys: [...new Set(files.map((f) => f.media_key))].sort(),
          files,
        },
      });
    }

    // --- Phase 2: decide which products still need browser video extraction ---
    // The iframe extraction is the slowest, most rate-limited step, so we skip
    // it entirely when the page's mainVideoId still matches what we recorded.
    const needExtraction = [];
    for (const product of products) {
      if (force) {
        product.needExtract = true;
        needExtraction.push(product);
        continue;
      }
      const videoRec = readResourceJson(product.itemDir).video || {};
      const htmlVid = product.htmlMainVideoId;

      if (videoRec.status === "no_video" && !htmlVid) {
        product.videoResult = { status: "skipped_no_video", count: 0 };
        continue;
      }
      const singleVideoUnchanged =
        videoRec.status === "ok" &&
        videoRec.main_video_id &&
        htmlVid &&
        videoRec.main_video_id === htmlVid &&
        Array.isArray(videoRec.files) &&
        videoRec.files.length === 1 &&
        recordedFilesExist(product.itemDir, videoRec.files);
      if (singleVideoUnchanged) {
        console.log(`[${product.goodId}] 视频未变化，跳过浏览器提取`);
        product.videoResult = { status: "skipped", count: 1 };
        continue;
      }

      product.needExtract = true;
      needExtraction.push(product);
    }

    let videoResults = null;
    if (needExtraction.length) {
      const videoTasks = needExtraction.map((p) => ({
        url: p.desktopUrl,
        good_id: p.goodId,
        mainVideoId: p.htmlMainVideoId || null,
      }));
      try {
        console.log(
          `\n正在通过浏览器提取视频 (${needExtraction.length} 个商品)...`,
        );
        const timeoutMs =
          videoTasks.length * VIDEO_TIMEOUT_PER_TASK_MS + VIDEO_BASE_TIMEOUT_MS;
        videoResults = await sendCommand({
          site: "jd",
          action: "extract_videos",
          args: { tasks: videoTasks },
          timeoutMs,
        });
      } catch (error) {
        console.error(`\n视频提取失败: ${error.message}`);
        console.error("请确保已安装京东 userscript 并打开了任意京东商品页面。");
        console.error(
          "安装地址: open http://127.0.0.1:17872/userscript/jd/mycli.user.js",
        );
      }
    } else {
      console.log("\n所有商品视频均已缓存，跳过浏览器提取。");
    }

    // --- Phase 3: Download videos ---
    if (Array.isArray(videoResults)) {
      const resultsByGoodId = new Map();
      for (const r of videoResults) {
        if (r.good_id) resultsByGoodId.set(r.good_id, r);
      }

      for (const product of needExtraction) {
        const result = resultsByGoodId.get(product.goodId);
        if (!result) {
          product.videoResult = { status: "no_result", count: 0 };
          continue;
        }
        if (result.status === "error") {
          product.videoResult = { status: "error", count: 0, error: result.error };
          continue;
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
          continue;
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
          continue;
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
              `  ${filename} (${(size / 1024 / 1024).toFixed(1)} MB)\n`,
            );
          } catch (error) {
            console.error(`  ${filename} 失败: ${error.message}`);
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
    }

    // --- Summary ---
    console.log("\n--- 下载完成 ---");
    let imageOk = 0;
    let imageSkip = 0;
    let imageFail = 0;
    let videoOk = 0;
    let videoSkip = 0;
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
      console.log(`  ${p.goodId}: ${imgLabel} | ${vidLine}`);
    }
    console.log(
      `\n图片: ${imageOk} 下载, ${imageSkip} 缓存, ${imageFail} 失败 | 视频: ${videoOk} 下载, ${videoSkip} 缓存/跳过`,
    );
  },
});
