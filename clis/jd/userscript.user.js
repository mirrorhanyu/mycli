// ==UserScript==
// @name         mycli JD Bridge
// @namespace    local.mycli.jd
// @version      0.2.9
// @description  WebSocket bridge to the mycli micro-daemon. Extracts video URLs from JD item pages via hidden iframes.
// @match        https://item.jd.com/*
// @noframes
// @grant        none
// @downloadURL  http://127.0.0.1:17872/userscript/jd/mycli.user.js
// @updateURL    http://127.0.0.1:17872/userscript/jd/mycli.user.js
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const SITE = "jd";
  const VERSION = "0.2.9";
  const WS_URL = "ws://127.0.0.1:17872/ws";
  const TAB_ID = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const RECONNECT_MIN_MS = 1000;
  const RECONNECT_MAX_MS = 15000;

  let busy = false;
  let ws = null;
  let lastStatus = "";
  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_MIN_MS;

  // --- Status overlay (auto-tucks to the edge after 3s; click to toggle) ---

  const STATUS_COLLAPSE_MS = 3000;
  let statusCollapsed = false;
  let statusCollapseTimer = null;

  function renderStatus() {
    const box = document.getElementById("mycli-jd-status");
    if (!box) return;
    if (statusCollapsed) {
      box.textContent = "≡";
      box.style.transform = "translateX(14px)"; // hug the right edge
      box.style.opacity = "0.6";
    } else {
      box.textContent = box.dataset.full || "";
      box.style.transform = "none";
      box.style.opacity = "1";
    }
  }

  function collapseStatus() {
    statusCollapsed = true;
    renderStatus();
  }

  function expandStatus() {
    statusCollapsed = false;
    renderStatus();
    clearTimeout(statusCollapseTimer);
    statusCollapseTimer = setTimeout(collapseStatus, STATUS_COLLAPSE_MS);
  }

  function setStatus(text) {
    lastStatus = text;
    let box = document.getElementById("mycli-jd-status");
    if (!box) {
      box = document.createElement("div");
      box.id = "mycli-jd-status";
      box.style.cssText = [
        "position:fixed",
        "right:14px",
        "top:14px",
        "z-index:2147483647",
        "background:#111827",
        "color:#fff",
        "font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
        "padding:8px 10px",
        "border-radius:8px",
        "box-shadow:0 8px 24px rgba(0,0,0,.18)",
        "max-width:280px",
        "white-space:pre-wrap",
        "cursor:pointer",
        "user-select:none",
        "transition:opacity .2s ease, transform .2s ease",
      ].join(";");
      box.addEventListener("click", () => {
        if (statusCollapsed) expandStatus();
        else collapseStatus();
      });
      (document.body || document.documentElement).appendChild(box);
    }
    box.dataset.full = `mycli/${SITE} ${VERSION}\n${text}`;
    // Any status change re-expands briefly, then auto-collapses after 3s.
    expandStatus();
  }

  // --- WebSocket helpers ---

  function sendWs(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  function sendResult(id, ok, dataOrError) {
    sendWs(
      ok
        ? { type: "result", id, ok: true, data: dataOrError }
        : { type: "result", id, ok: false, error: dataOrError },
    );
  }

  function logRemote(msg) {
    sendWs({ type: "log", level: "info", msg: `[jd] ${msg}` });
  }

  // --- Iframe-based video extraction ---

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function ensureFrame() {
    let frame = document.getElementById("mycli-jd-frame");
    if (!frame) {
      frame = document.createElement("iframe");
      frame.id = "mycli-jd-frame";
      // Real (off-screen) size: a 1px iframe has no viewport, so viewport-lazy
      // sections (e.g. the spec table) never render. Keep it fully off-screen.
      frame.style.cssText =
        "width:1280px;height:4000px;position:fixed;left:-99999px;top:0;border:0";
      document.body.appendChild(frame);
    }
    return frame;
  }

  function loadInFrame(frame, url, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        frame.onload = null;
        frame.onerror = null;
        reject(new Error("frame load timeout"));
      }, timeoutMs);
      frame.onload = () => {
        clearTimeout(timer);
        frame.onload = null;
        frame.onerror = null;
        resolve();
      };
      frame.onerror = () => {
        clearTimeout(timer);
        frame.onload = null;
        frame.onerror = null;
        reject(new Error("frame load error"));
      };
      frame.src = url;
    });
  }

  async function clearFrame(frame) {
    try {
      await loadInFrame(frame, "about:blank", 5000);
    } catch {
      frame.removeAttribute("src");
    }
  }

  function normalizeUrl(value) {
    if (!value) return null;
    return String(value).replace(/&amp;/g, "&").trim() || null;
  }

  function getReactProps(node) {
    if (!node) return null;
    const key = Object.keys(node).find((k) => k.startsWith("__reactProps"));
    return key ? node[key] : null;
  }

  function collectVideosFromDoc(doc) {
    if (!doc) return [];
    const html = doc.documentElement?.outerHTML || "";
    const byTag = Array.from(doc.querySelectorAll("video")).map(
      (video, index) => ({
        index,
        mainUrl: normalizeUrl(video.currentSrc || video.src || ""),
        posterUrl: normalizeUrl(video.poster || ""),
        videoDuration: Number.isFinite(video.duration) ? video.duration : null,
        source: "video-tag",
      }),
    );
    const mp4Urls = (
      html.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/g) || []
    )
      .map((u) => normalizeUrl(u))
      .filter(Boolean);
    const byHtml = [...new Set(mp4Urls)].map((url) => ({
      mainUrl: url,
      posterUrl: null,
      videoDuration: null,
      source: "html-match",
    }));
    const merged = [...byTag, ...byHtml];
    const seen = new Set();
    return merged.filter((item) => {
      const key = item.mainUrl || "";
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function getVideoThumbItems(doc) {
    if (!doc) return [];
    return Array.from(
      doc.querySelectorAll(".image-carousel-track .item"),
    ).filter((item) => item.querySelector(".thumbnails-play-icon"));
  }

  async function activateVideoThumb(item) {
    if (!item) return;
    const props = getReactProps(item);
    if (props?.onMouseEnter) {
      props.onMouseEnter({
        type: "mouseenter",
        currentTarget: item,
        target: item,
      });
    } else {
      item.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    }
    await sleep(1400);
  }

  async function waitForNewVideos(frame, knownUrls) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const videos = collectVideosFromDoc(frame.contentDocument);
      if (videos.some((v) => v.mainUrl && !knownUrls.has(v.mainUrl))) {
        return videos;
      }
      await sleep(500);
    }
    return collectVideosFromDoc(frame.contentDocument);
  }

  function extractAttrsFromDoc(doc) {
    if (!doc) return {};
    const attrs = {};
    for (const item of doc.querySelectorAll(".attrs .item")) {
      const label = (item.querySelector(".label .text")?.textContent || "").trim();
      const valueEl = item.querySelector(".value .text");
      const value = (valueEl?.getAttribute("title") || valueEl?.textContent || "").trim();
      if (label && value) attrs[label] = value;
    }
    return attrs;
  }

  // The spec table (.attrs) is an empty placeholder until two things happen:
  // (1) the "商品详情" tab is clicked, and (2) the section scrolls into a
  // *painted* viewport (JD lazy-loads it via IntersectionObserver). An
  // off-screen iframe is never painted, so its IO never fires. So we briefly
  // bring the frame on-screen but fully transparent + click-through, scroll the
  // spec section into the iframe's own viewport, wait for rows, then hide again.
  async function revealAttrs(frame, goodId) {
    const doc = frame.contentDocument;
    if (!doc) return;
    if (doc.querySelectorAll(".attrs .item").length > 0) return;
    const tab =
      doc.querySelector("#SPXQ-tab-column") ||
      [...doc.querySelectorAll("div")].find(
        (el) => el.textContent.trim() === "商品详情",
      );
    if (!tab) {
      logRemote(`[${goodId}] 商品详情 tab not found`);
      return;
    }

    const savedStyle = frame.style.cssText;
    frame.style.cssText =
      `position:fixed;left:0;top:0;width:1100px;height:${window.innerHeight}px;` +
      "opacity:0;pointer-events:none;border:0;z-index:2147483646";
    try {
      tab.click();
      const win = doc.defaultView;
      for (let i = 0; i < 30; i += 1) {
        const attrsEl = doc.querySelector(".attrs");
        try {
          if (attrsEl) attrsEl.scrollIntoView({ block: "center" });
          else if (win) win.scrollTo(0, doc.body.scrollHeight);
        } catch {}
        if (doc.querySelectorAll(".attrs .item").length > 0) return;
        await sleep(300);
      }
      const attrsEl = doc.querySelector(".attrs");
      const dump = attrsEl
        ? attrsEl.outerHTML.replace(/\s+/g, " ").slice(0, 600)
        : "(none)";
      logRemote(`[${goodId}] attrs reveal failed; html=${dump}`);
    } finally {
      frame.style.cssText = savedStyle;
    }
  }

  async function collectAllVideos(frame, task) {
    const doc = frame.contentDocument;
    const found = [];
    const seen = new Set();

    function addVideos(videos, meta = {}) {
      for (const video of videos) {
        const mainUrl = normalizeUrl(
          video.mainUrl || video.src || video.currentSrc || "",
        );
        if (!mainUrl || seen.has(mainUrl)) continue;
        seen.add(mainUrl);
        found.push({
          mainUrl,
          posterUrl: normalizeUrl(video.posterUrl || video.poster || ""),
          videoDuration: video.videoDuration ?? video.duration ?? null,
          mainVideoId: task.mainVideoId || null,
          source: video.source || meta.source || "unknown",
        });
      }
    }

    addVideos(collectVideosFromDoc(doc), { source: "initial" });
    logRemote(`[${task.good_id}] initial videos=${found.length}`);

    const thumbs = getVideoThumbItems(doc);
    logRemote(`[${task.good_id}] video thumbs=${thumbs.length}`);
    for (let i = 0; i < thumbs.length; i += 1) {
      const tt = Date.now();
      await activateVideoThumb(thumbs[i]);
      const videos = await waitForNewVideos(frame, seen);
      logRemote(
        `[${task.good_id}] thumb-${i}: ${videos.length} visible (${Date.now() - tt}ms)`,
      );
      const thumbPoster = normalizeUrl(
        thumbs[i].querySelector(".image")?.getAttribute("src") || "",
      );
      addVideos(
        videos.map((v) => ({
          ...v,
          posterUrl: v.posterUrl || thumbPoster || null,
          source: `thumb-${i}`,
        })),
        { source: `thumb-${i}` },
      );
    }

    return found;
  }

  async function extractVideos(tasks) {
    const frame = ensureFrame();
    const results = [];

    for (let i = 0; i < tasks.length; i += 1) {
      const task = tasks[i];
      logRemote(`task ${i + 1}/${tasks.length}: ${task.good_id}`);
      setStatus(`提取视频 ${i + 1}/${tasks.length}\n${task.good_id}`);

      const t0 = Date.now();
      try {
        logRemote(`[${task.good_id}] loading iframe...`);
        await loadInFrame(frame, task.url);
        logRemote(`[${task.good_id}] loaded (${Date.now() - t0}ms)`);
        await sleep(1500);
        const videos = await collectAllVideos(frame, task);
        logRemote(
          `[${task.good_id}] videos=${videos.length} (${Date.now() - t0}ms)`,
        );
        await revealAttrs(frame, task.good_id);
        const attrs = extractAttrsFromDoc(frame.contentDocument);
        logRemote(
          `[${task.good_id}] DONE attrs=${Object.keys(attrs).length} (${Date.now() - t0}ms)`,
        );
        const first = videos[0] || null;
        results.push({
          good_id: task.good_id,
          url: task.url,
          status: videos.length > 0 ? "ok" : "no_video",
          videos,
          videoCount: videos.length,
          mainUrl: first?.mainUrl || null,
          posterUrl: first?.posterUrl || null,
          videoDuration: first?.videoDuration ?? null,
          attrs,
          error: null,
        });
      } catch (error) {
        logRemote(
          `[${task.good_id}] ERROR (${Date.now() - t0}ms): ${error.message || error}`,
        );
        results.push({
          good_id: task.good_id,
          url: task.url,
          status: "error",
          videos: [],
          videoCount: 0,
          mainUrl: null,
          posterUrl: null,
          videoDuration: null,
          attrs: {},
          error: String(error.message || error),
        });
      }
      // The CLI sends one product per command and enforces its own gap between
      // browser calls (--browser-gap), so there is no in-script inter-task wait.
    }

    await clearFrame(frame);
    try {
      frame.remove();
    } catch {}
    return results;
  }

  // --- Command handler ---

  async function handleCommand(cmd) {
    if (cmd.action === "extract_videos") {
      const tasks = cmd.args?.tasks;
      if (!Array.isArray(tasks) || !tasks.length) {
        throw new Error("extract_videos: missing tasks array");
      }
      return await extractVideos(tasks);
    }
    throw new Error(`Unknown action: ${cmd.action}`);
  }

  // --- WebSocket connection ---

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    setStatus(`已断开, ${Math.round(delay / 1000)}s 后重连`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    try {
      ws = new WebSocket(WS_URL);
    } catch (error) {
      setStatus(`连接失败\n${error.message || String(error)}`);
      scheduleReconnect();
      return;
    }

    ws.addEventListener("open", () => {
      reconnectDelay = RECONNECT_MIN_MS;
      setStatus("已连接，等待指令");
      sendWs({
        type: "hello",
        site: SITE,
        version: VERSION,
        contextId: TAB_ID,
      });
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "command" && msg.id) {
        if (busy) {
          sendResult(msg.id, false, "正在处理上一条命令，请稍后再试");
          return;
        }
        busy = true;
        handleCommand(msg)
          .then((result) => sendResult(msg.id, true, result))
          .catch((error) =>
            sendResult(msg.id, false, error.message || String(error)),
          )
          .finally(() => {
            busy = false;
            setStatus("已连接，等待指令");
          });
        return;
      }
      if (msg.type === "hello_ack") {
        setStatus("已连接，等待指令");
      }
    });

    ws.addEventListener("close", () => {
      ws = null;
      setStatus("已断开");
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      setStatus("连接错误");
    });
  }

  window.addEventListener("beforeunload", () => {
    try {
      ws && ws.close();
    } catch {}
  });

  setStatus("正在连接...");
  connect();
})();
