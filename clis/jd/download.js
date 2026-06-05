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
  mediaKeyFromUrl,
  imageMediaKeys,
  sameKeys,
  readResourceJson,
  writeResourceSection,
  recordedFilesExist,
} = require("./jd-utils.js");

const IMAGE_CONCURRENCY = 6;

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

defineCommand({
  site: "jd",
  name: "download",
  description: "Download product images from JD (京东) item pages.",
  async run({ options, positional = [] }) {
    const urls = positional.filter((u) => u.includes("jd.com"));
    if (!urls.length) {
      throw new Error(
        "Usage: mycli jd download <url> [url2 ...] [--out-dir <dir>] [--force]",
      );
    }

    const outDir = path.resolve(String(options["out-dir"] || "."));
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
      });
    }

    if (!products.length) {
      throw new Error("没有可处理的京东商品 URL");
    }

    console.log(
      `共 ${products.length} 个商品，输出目录: ${outDir}${force ? " (--force 强制重下)" : ""}\n`,
    );

    const productsWithVideo = [];

    for (let pi = 0; pi < products.length; pi += 1) {
      if (pi > 0) await randomDelay(500, 1200);
      const product = products[pi];

      // 1. Fetch page HTML: image URLs, title, mainVideoId
      console.log(`[${product.goodId}] 正在读取页面...`);
      const { urls: imageUrls, source, mainVideoId, title } = await fetchImageUrls(
        product.desktopUrl,
        product.goodId,
      );
      product.imageUrls = imageUrls;
      product.imageSource = source;
      product.htmlMainVideoId = mainVideoId;
      product.title = title;

      writeResourceSection(product.itemDir, {
        good_id: product.goodId,
        url: product.desktopUrl,
        ...(title ? { title } : {}),
        ...(mainVideoId ? { main_video_id: mainVideoId } : {}),
      });

      if (mainVideoId) {
        productsWithVideo.push(product);
      }

      // 2. Download images
      await downloadImagesForProduct(product, force);
    }

    // --- Summary ---
    console.log("\n--- 下载完成 ---");
    let imageOk = 0;
    let imageSkip = 0;
    let imageFail = 0;
    for (const p of products) {
      const imgStatus = p.imageResult?.status;
      if (imgStatus === "ok") imageOk += 1;
      else if (imgStatus === "skipped") imageSkip += 1;
      else imageFail += 1;
      const imgLabel =
        imgStatus === "skipped"
          ? `图片 ${p.imageResult.count} (缓存)`
          : `图片 ${p.imageResult?.count || 0}/${p.imageResult?.total || 0}`;
      const vidLabel = p.htmlMainVideoId
        ? `有视频 (id: ${p.htmlMainVideoId})`
        : "无视频";
      console.log(`  ${p.goodId}: ${imgLabel} | ${vidLabel}`);
    }
    console.log(
      `\n图片: ${imageOk} 下载, ${imageSkip} 缓存, ${imageFail} 失败`,
    );
    if (productsWithVideo.length) {
      console.log(
        `\n⚠ ${productsWithVideo.length} 个商品有视频，需在浏览器中获取视频地址：`,
      );
      for (const p of productsWithVideo) {
        console.log(`  ${p.desktopUrl}`);
      }
    }
  },
});
