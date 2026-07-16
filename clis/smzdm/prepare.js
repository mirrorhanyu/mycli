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

function jdSkuFromUrl(value) {
  let candidate = decodeHtml(value).trim();
  for (let i = 0; i < 2; i += 1) {
    const match = candidate.match(/(?:https?:\/\/)?item\.jd\.com\/(\d+)\.html(?:[?#]|$)/i);
    if (match) return match[1];
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

function extractProductLinks(html) {
  const links = [];
  for (const match of String(html).matchAll(STANDALONE_LINK_RE)) {
    const url = decodeHtml(match.groups.href);
    const sku = jdSkuFromUrl(url);
    if (!sku) continue;
    links.push({
      index: links.length,
      platform: "jd",
      sku,
      key: `jd:${sku}`,
      url,
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
};
