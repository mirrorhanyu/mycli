const fs = require("node:fs");
const path = require("node:path");

const JD_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const JD_ITEM_RE = /item\.jd\.com\/(\d+)\.html/;
const GOOD_ID_PATTERNS = [
  /item\.jd\.com\/(\d+)\.html/,
  /wareId=(\d+)/,
  /skuId=(\d+)/,
];

function extractGoodId(url) {
  for (const pattern of GOOD_ID_PATTERNS) {
    const match = String(url).match(pattern);
    if (match) return match[1];
  }
  return null;
}

function normalizeToDesktopUrl(url) {
  const goodId = extractGoodId(url);
  if (!goodId) return url;
  return `https://item.jd.com/${goodId}.html`;
}

function normalizeMediaUrl(value) {
  value = String(value || "").trim().replace(/&amp;/g, "&");
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  return value;
}

function normalizeImageUrl(value) {
  value = String(value || "").trim();
  if (!value) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  const raw = value.replace(/^\/+/, "");
  return `https://img10.360buyimg.com/pcpubliccms/s1440x1440_${raw}`;
}

function upgradeJfsImageUrl(value) {
  const normalized = normalizeMediaUrl(value);
  if (normalized.includes("/jfs/t1/")) {
    return normalized.replace(
      /^https?:\/\/[^/]+\/(?:n\d(?:\/s\d+x\d+)?\/)?jfs\/t1\//,
      "https://img10.360buyimg.com/pcpubliccms/s1440x1440_jfs/t1/",
    );
  }
  if (normalized.startsWith("jfs/t1/")) {
    return `https://img10.360buyimg.com/pcpubliccms/s1440x1440_${normalized}`;
  }
  return normalized;
}

function uniqueUrls(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = normalizeMediaUrl(value);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

function extractImageUrlsFromDesktopHtml(html) {
  const urls = [];
  const imageListMatch = html.match(/imageList\s*:\s*(\[[^\]]+\])/);
  if (imageListMatch) {
    try {
      const rawList = JSON.parse(imageListMatch[1]);
      for (const item of rawList) {
        if (typeof item === "string" && item.trim()) {
          urls.push(normalizeImageUrl(item));
        }
      }
    } catch {}
  }
  if (!urls.length) {
    const dataOriginMatch = html.match(/data-origin="([^"]+)"/);
    if (dataOriginMatch) urls.push(normalizeImageUrl(dataOriginMatch[1]));
  }
  if (!urls.length) {
    const ogMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
    if (ogMatch) urls.push(normalizeImageUrl(ogMatch[1]));
  }
  return uniqueUrls(urls);
}

function extractBigimageUrls(html) {
  const match = html.match(/newOutputAllImages\.data\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!match) return [];
  let values;
  try {
    values = JSON.parse(match[1]);
  } catch {
    return [];
  }
  const urls = values
    .filter((item) => item && typeof item === "object" && String(item.img || "").trim())
    .map((item) => upgradeJfsImageUrl(item.img));
  return uniqueUrls(urls);
}

function extractMobileWareImageUrls(html) {
  for (const match of html.matchAll(/"image"\s*:\s*(\[[^\]]+\])/g)) {
    let values;
    try {
      values = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (!Array.isArray(values)) continue;
    const urls = values
      .filter((v) => typeof v === "string" && v.trim())
      .map((v) => normalizeImageUrl(v));
    if (urls.length) return uniqueUrls(urls);
  }
  return [];
}

function extractTitle(html) {
  const match = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  let title = match[1]
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  // Order matters: JD's real tail is "...【行情 报价 价格 评测】-京东", so drop
  // the "-京东" site suffix first, then the SEO bracket it exposes.
  title = title.replace(/[\s\-—|]*京东(商城)?\s*$/, "");
  // SEO bracket like "【行情 报价 价格 评测】" — strip a trailing bracket group
  // when it contains those keywords, but keep genuine marketing brackets.
  title = title.replace(
    /[【\[][^】\]]*(行情|报价|价格|评测|图片|参数|怎么样|多少钱|品牌)[^】\]]*[】\]]\s*$/,
    "",
  );
  title = title.replace(/[\s\-—|]+$/, "").trim();
  return title || null;
}

function extractMainVideoId(html) {
  const patterns = [
    /imageAndVideoJson\s*:\s*\{\s*"mainVideoId"\s*:\s*"([^"]+)"/,
    /"mainVideoId"\s*:\s*"([^"]+)"/,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1].trim()) return match[1].trim();
  }
  return null;
}

async function httpGetText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": JD_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Cache-Control": "no-cache",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { body: await res.text(), finalUrl: res.url };
}

async function downloadFile(url, destPath) {
  const res = await fetch(url, {
    headers: { "User-Agent": JD_UA, Accept: "*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
  return buffer.length;
}

function suffixFromUrl(url, fallback) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase();
    if (ext && ext.length <= 6) return ext;
  } catch {}
  return fallback;
}

function buildImageFilename(imageUrl, index, total) {
  const suffix = suffixFromUrl(imageUrl, ".jpg");
  if (total <= 1) return `首图${suffix}`;
  return index === 1 ? `首图${suffix}` : `图${String(index).padStart(2, "0")}${suffix}`;
}

// Detail-page (商品详情) long-description images live in a 详情页/ subfolder and
// are simply numbered in document order; their CDN ext (often .png.avif) is kept.
function buildDetailImageFilename(url, index, total) {
  const suffix = suffixFromUrl(url, ".jpg");
  const width = String(total).length;
  return `${String(index).padStart(Math.max(2, width), "0")}${suffix}`;
}

function buildVideoFilename(video, index, total, fallbackStem) {
  const videoId = String(video.mainVideoId || "").trim();
  const suffix = suffixFromUrl(String(video.mainUrl || ""), ".mp4");
  if (total === 1 && videoId) return `${videoId}${suffix}`;
  const stem = videoId || fallbackStem || "video";
  return `${String(index).padStart(2, "0")}-${stem}${suffix}`;
}

function randomDelay(minMs, maxMs) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run async `fn` over `items` with at most `limit` calls in flight at once.
// Results preserve input order. Used for CDN image downloads, which are safe to
// parallelize (static CDN, no anti-bot throttling like the item pages have).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  const size = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: size }, () => worker()));
  return results;
}

// --- Media identity + resource.json bookkeeping ---

// Stable identity for a media URL: scheme://host/path, query stripped. JD image
// paths and video mp4 paths are stable, while query strings carry size hints or
// signed tokens that rotate on every fetch.
function mediaKeyFromUrl(url) {
  const normalized = normalizeMediaUrl(url);
  try {
    const u = new URL(normalized);
    if (u.protocol && u.host && u.pathname) {
      return `${u.protocol}//${u.host}${u.pathname}`;
    }
  } catch {}
  return normalized;
}

function imageMediaKeys(urls) {
  return [...new Set(urls.map((u) => mediaKeyFromUrl(u)).filter(Boolean))].sort();
}

function videoMediaKey(video) {
  const mainUrl = String(video.mainUrl || video.url || "").trim();
  if (mainUrl) return mediaKeyFromUrl(mainUrl);
  const id = String(video.mainVideoId || "").trim();
  return id ? `id:${id}` : "";
}

function videoMediaKeys(videos) {
  return [...new Set(videos.map((v) => videoMediaKey(v)).filter(Boolean))].sort();
}

function sameKeys(a, b) {
  const sa = [...(a || [])].sort();
  const sb = [...(b || [])].sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

function resourceJsonPath(itemDir) {
  return path.join(itemDir, "resource.json");
}

function readResourceJson(itemDir) {
  try {
    const payload = JSON.parse(fs.readFileSync(resourceJsonPath(itemDir), "utf8"));
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

// Merge a partial section (e.g. { images } or { video }) into the existing
// resource.json so the image and video phases never clobber each other.
function writeResourceSection(itemDir, patch) {
  const existing = readResourceJson(itemDir);
  const merged = { ...existing, ...patch, updated_at: new Date().toISOString() };
  fs.mkdirSync(itemDir, { recursive: true });
  fs.writeFileSync(
    resourceJsonPath(itemDir),
    JSON.stringify(merged, null, 2) + "\n",
    "utf8",
  );
}

// Files are recorded by name (relative to itemDir) so the folder stays portable.
function recordedFilesExist(itemDir, files) {
  if (!Array.isArray(files) || !files.length) return false;
  return files.every(
    (f) => f && f.name && fs.existsSync(path.join(itemDir, f.name)),
  );
}

async function fetchImageUrls(url, goodId) {
  // Title comes from the desktop page; keep it even if we fall through to an
  // image-only fallback source below.
  let title = null;
  try {
    const { body } = await httpGetText(url);
    title = extractTitle(body);
    const urls = extractImageUrlsFromDesktopHtml(body);
    const mainVideoId = extractMainVideoId(body);
    if (urls.length) return { urls, source: "desktop_html", mainVideoId, title };
  } catch {}

  await randomDelay(500, 1000);
  try {
    const { body } = await httpGetText(`https://item.jd.com/bigimage.aspx?id=${goodId}`);
    const urls = extractBigimageUrls(body);
    if (urls.length) return { urls, source: "bigimage", mainVideoId: null, title };
  } catch {}

  await randomDelay(500, 1000);
  try {
    const { body } = await httpGetText(`https://item.m.jd.com/ware/view.action?wareId=${goodId}`);
    const urls = extractMobileWareImageUrls(body);
    if (urls.length) return { urls, source: "mobile_ware", mainVideoId: null, title };
  } catch {}

  return { urls: [], source: null, mainVideoId: null, title };
}

module.exports = {
  JD_UA,
  JD_ITEM_RE,
  extractGoodId,
  normalizeToDesktopUrl,
  normalizeMediaUrl,
  normalizeImageUrl,
  upgradeJfsImageUrl,
  extractTitle,
  fetchImageUrls,
  downloadFile,
  randomDelay,
  mapWithConcurrency,
  buildImageFilename,
  buildDetailImageFilename,
  buildVideoFilename,
  mediaKeyFromUrl,
  imageMediaKeys,
  videoMediaKey,
  videoMediaKeys,
  sameKeys,
  readResourceJson,
  writeResourceSection,
  recordedFilesExist,
};
