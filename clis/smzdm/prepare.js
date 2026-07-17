const {
  prepareDraftPayload: prepareBaseDraftPayload,
  markdownToHtml,
} = require("../toutiao/prepare.js");

const STANDALONE_LINK_RE =
  /<p>\s*<a href="(?<href>[^"]+)">(?<label>[\s\S]*?)<\/a>\s*<\/p>/g;

function decodeHtml(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseJdProductUrl(value) {
  let candidate = decodeHtml(value).trim();
  for (let i = 0; i < 2; i += 1) {
    try {
      const parsed = new URL(candidate);
      const hostname = parsed.hostname.toLowerCase();
      if (
        parsed.protocol !== "https:" ||
        (hostname !== "jd.com" && !hostname.endsWith(".jd.com"))
      ) {
        return null;
      }
      parsed.hash = "";
      const skuMatch =
        hostname === "item.jd.com" && /^\/(\d+)\.html\/?$/.exec(parsed.pathname);
      const sku = skuMatch?.[1] || null;
      return {
        sku,
        key: sku
          ? `jd:${sku}`
          : `jd-url:${hostname}${parsed.pathname}${parsed.search}`,
        url: parsed.toString(),
      };
    } catch {}
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) break;
      candidate = decoded;
    } catch {
      break;
    }
  }
  return null;
}

function jdSkuFromUrl(value) {
  return parseJdProductUrl(value)?.sku || null;
}

function extractProductLinks(html) {
  const links = [];
  for (const match of String(html).matchAll(STANDALONE_LINK_RE)) {
    const product = parseJdProductUrl(match.groups.href);
    if (!product) continue;
    links.push({
      index: links.length,
      platform: "jd",
      sku: product.sku,
      key: product.key,
      url: product.url,
      label: decodeHtml(match.groups.label).replace(/<[^>]+>/g, "").trim(),
    });
  }
  return links;
}

function prepareDraftPayload(markdownPath) {
  const payload = prepareBaseDraftPayload(markdownPath);
  const productLinks = extractProductLinks(payload.html);
  return {
    ...payload,
    product_links: productLinks,
    product_link_count: productLinks.length,
  };
}

module.exports = {
  prepareDraftPayload,
  markdownToHtml,
  extractProductLinks,
  jdSkuFromUrl,
  parseJdProductUrl,
};
