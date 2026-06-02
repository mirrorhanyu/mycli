const { defineCommand } = require("../../src/registry.js");

const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 5;
const DEFAULT_PAGE_SIZE = 30;
const DEFAULT_WEB_LOCATION = "333.1387";

const MixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

function parseInteger(raw, label, fallback = null) {
  if (raw === undefined || raw === true || raw === null || raw === "") {
    if (fallback !== null) return fallback;
    throw new Error(`Missing ${label}`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  return value;
}

function parseBoolean(raw) {
  return raw === true || raw === "true" || raw === "1" || raw === 1;
}

function parseMidList(options, positional) {
  const parts = [];
  if (options.mids && options.mids !== true) {
    parts.push(String(options.mids));
  }
  for (const value of positional) {
    parts.push(String(value));
  }

  const mids = parts
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((value) => Number.isInteger(value) && value > 0);

  return [...new Set(mids)];
}

function safeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function getMixinKey(orig) {
  return MixinKeyEncTab.map((index) => orig[index]).join("").slice(0, 32);
}

function sanitizeWbiValue(value) {
  return String(value ?? "").replace(/[!'()*]/g, "");
}

function buildWbiQuery(params, imgKey, subKey) {
  const wts = Math.floor(Date.now() / 1000);
  const entries = Object.entries({ ...params, wts })
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, sanitizeWbiValue(value)])
    .sort(([a], [b]) => a.localeCompare(b));

  const query = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  const mixinKey = getMixinKey(`${imgKey}${subKey}`);
  const wRid = require("node:crypto").createHash("md5").update(query + mixinKey).digest("hex");
  return `${query}&w_rid=${wRid}`;
}

function formatTimestamp(value) {
  if (!Number.isFinite(value)) return "";
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function normalizeEntry(entry) {
  const created = Number(entry?.created || 0);
  return {
    aid: Number(entry?.aid || 0),
    bvid: safeText(entry?.bvid),
    title: safeText(entry?.title),
    author: safeText(entry?.author),
    created,
    createdText: formatTimestamp(created),
    play: Number(entry?.play || 0),
    duration: Number(entry?.duration || 0),
    url: entry?.bvid ? `https://www.bilibili.com/video/${entry.bvid}` : "",
  };
}

function formatResult(results, days) {
  const lines = [];
  for (const item of results) {
    if (item.error) {
      lines.push(`[${item.mid}] 失败: ${item.error}`);
      continue;
    }
    if (!item.items?.length) {
      lines.push(`[${item.mid}] ${days} 天内没有更新`);
      continue;
    }
    const author = safeText(item.items[0]?.author);
    const header = author ? `[${item.mid}] [${author}]` : `[${item.mid}]`;
    lines.push(`${header} ${item.items.length} 条更新`);
    for (const entry of item.items) {
      lines.push(`  ${entry.createdText} ${entry.bvid} ${entry.title}`.trimEnd());
    }
  }
  return lines.join("\n");
}

defineCommand({
  site: "bilibili",
  name: "recent",
  description: "Fetch recent Bilibili uploads for multiple mids within a time window.",
  async run({ options, positional = [], sendCommand }) {
    const mids = parseMidList(options, positional);
    if (!mids.length) {
      throw new Error("Usage: mycli bilibili recent <mid> [mid...] --days <n>");
    }

    const days = parseInteger(options.days, "--days", DEFAULT_DAYS);
    const limit = parseInteger(options.limit, "--limit", DEFAULT_LIMIT);
    const pageSize = parseInteger(options["page-size"], "--page-size", DEFAULT_PAGE_SIZE);
    const webLocation = String(options["web-location"] || DEFAULT_WEB_LOCATION);
    const jsonOutput = parseBoolean(options.json);
    const customTimeout = Number(options["timeout-ms"] ?? options.timeout_ms);
    const timeoutMs = Number.isFinite(customTimeout) && customTimeout > 0
      ? customTimeout
      : Math.min(10 * 60 * 1000, 60000 + mids.length * 15000);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const prepare = await sendCommand({
      site: "bilibili",
      action: "prepare",
      args: {},
      timeoutMs: 20000,
    });

    const results = [];
    for (const mid of mids) {
      const items = [];
      let pn = 1;
      let hitCutoff = false;

      while (items.length < limit && !hitCutoff) {
        const query = buildWbiQuery({
          mid,
          token: "",
          index: 1,
          order: "pubdate",
          tid: 0,
          keyword: "",
          pn,
          ps: pageSize,
          platform: "web",
          order_avoided: "true",
          web_location: webLocation,
          dm_img_list: prepare.dm_img_list,
          dm_img_str: prepare.dm_img_str,
          dm_cover_img_str: prepare.dm_cover_img_str,
          dm_img_inter: prepare.dm_img_inter,
        }, prepare.img_key, prepare.sub_key);

        const url = `https://api.bilibili.com/x/space/wbi/arc/search?${query}`;
        const [response] = await sendCommand({
          site: "bilibili",
          action: "fetch",
          args: { urls: [url] },
          timeoutMs,
        });

        if (!response) {
          throw new Error(`mid ${mid}: empty response`);
        }
        if (!response.ok) {
          throw new Error(`mid ${mid}: ${response.error || "request failed"}`);
        }

        const payload = response.data;
        if (!payload || payload.code !== 0) {
          const message = payload?.message || payload?.msg || `code ${payload?.code ?? "?"}`;
          throw new Error(`mid ${mid}: ${message}`);
        }

        const vlist = payload?.data?.list?.vlist || [];
        if (!vlist.length) break;

        for (const entry of vlist) {
          const normalized = normalizeEntry(entry);
          if (!normalized.created || normalized.created * 1000 < cutoff) {
            hitCutoff = true;
            break;
          }
          items.push(normalized);
          if (items.length >= limit) break;
        }

        if (vlist.length < pageSize) break;
        pn += 1;
      }

      results.push({ mid, items });
    }

    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify({ days, mids: results }, null, 2)}\n`);
      return;
    }

    process.stdout.write(`${formatResult(results, days)}\n`);
  },
});
