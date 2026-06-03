// ==UserScript==
// @name         mycli Bilibili Bridge
// @namespace    local.mycli.bilibili
// @version      0.1.1
// @description  WebSocket bridge to the mycli micro-daemon for Bilibili recent-upload lookups.
// @match        https://*.bilibili.com/*
// @match        https://bilibili.com/*
// @downloadURL  http://127.0.0.1:17872/userscript/bilibili/mycli.user.js
// @updateURL    http://127.0.0.1:17872/userscript/bilibili/mycli.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @connect      *.bilibili.com
// @connect      bilibili.com
// ==/UserScript==

(function () {
  "use strict";

  const HTTP_API = "http://127.0.0.1:17872";
  const WS_URL = "ws://127.0.0.1:17872/ws";
  const SITE = "bilibili";
  const VERSION = "0.1.1";
  const TAB_ID = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const LOCK_KEY = "mycli-bilibili-worker-lock";
  const LOCK_TTL_MS = 5000;
  const RECONNECT_MIN_MS = 1000;
  const RECONNECT_MAX_MS = 15000;
  const DEFAULT_WEB_LOCATION = "333.1387";

  let ws = null;
  let busy = false;
  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  let lastStatus = "";

  // --- Status overlay (auto-tucks to the edge after 3s; click to toggle) ---
  const STATUS_COLLAPSE_MS = 3000;
  let statusCollapsed = false;
  let statusCollapseTimer = null;
  let statusBox = null;

  function renderStatus() {
    if (!statusBox) return;
    if (statusCollapsed) {
      statusBox.textContent = "\u2261"; // collapsed handle: ≡
      statusBox.style.transform = "translateX(14px)";
      statusBox.style.opacity = "0.6";
    } else {
      statusBox.textContent = statusBox.dataset.full || "";
      statusBox.style.transform = "none";
      statusBox.style.opacity = "1";
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
    let box = document.getElementById("mycli-bilibili-status");
    if (!box) {
      box = document.createElement("div");
      box.id = "mycli-bilibili-status";
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
      document.documentElement.appendChild(box);
    }
    statusBox = box;
    box.onclick = () => {
      if (statusCollapsed) expandStatus();
      else collapseStatus();
    };
    box.dataset.full = `mycli/${SITE} ${VERSION}\n${text}`;
    expandStatus();
  }

  function sendWs(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  function lockSnapshot() {
    try {
      return JSON.parse(GM_getValue(LOCK_KEY, "null") || "null");
    } catch {
      return null;
    }
  }

  function becomeWorker() {
    const current = lockSnapshot();
    const now = Date.now();
    if (current && current.id !== TAB_ID && current.expires_at > now) {
      return false;
    }
    GM_setValue(LOCK_KEY, JSON.stringify({ id: TAB_ID, expires_at: now + LOCK_TTL_MS }));
    return lockSnapshot()?.id === TAB_ID;
  }

  function releaseWorker() {
    const current = lockSnapshot();
    if (current?.id === TAB_ID) {
      GM_deleteValue(LOCK_KEY);
    }
  }

  function encodeBase64NoPad(value) {
    return btoa(String(value)).slice(0, -2);
  }

  function getWebglInfo() {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) {
      return {
        dm_img_str: encodeBase64NoPad("no webgl"),
        dm_cover_img_str: encodeBase64NoPad("no webgl"),
      };
    }
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const version = String(gl.getParameter(gl.VERSION) || "no webgl");
    const vendor = ext ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || "no webgl") : "no webgl";
    const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "no webgl") : "no webgl";
    return {
      dm_img_str: encodeBase64NoPad(version),
      dm_cover_img_str: encodeBase64NoPad(`${renderer}${vendor}`),
    };
  }

  function buildDmImgInter() {
    const dpr = Number(window.devicePixelRatio || 1) || 1;
    const screenWidth = Math.max(1, Math.round((window.screen?.width || window.innerWidth || 1) * dpr));
    const screenHeight = Math.max(1, Math.round((window.screen?.height || window.innerHeight || 1) * dpr));
    const outerWidth = Math.max(1, Math.round((window.outerWidth || window.innerWidth || 1) * dpr / 2));
    const outerHeight = Math.max(1, Math.round((window.outerHeight || window.innerHeight || 1) * dpr / 2));
    const depth = Math.max(1, Math.round(dpr * 64));
    return JSON.stringify({
      ds: [],
      wh: [screenWidth, screenHeight, depth],
      of: [outerWidth, outerHeight, outerWidth],
    });
  }

  function gmRequestJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        headers: {
          Referer: location.href,
          Origin: location.origin,
        },
        timeout: 30000,
        withCredentials: true,
        onload(response) {
          try {
            resolve({
              status: response.status,
              text: response.responseText || "",
              url: response.finalUrl || url,
            });
          } catch (error) {
            reject(error);
          }
        },
        onerror() {
          reject(new Error(`Request failed: ${url}`));
        },
        ontimeout() {
          reject(new Error(`Request timed out: ${url}`));
        },
      });
    });
  }

  async function requestText(url) {
    const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    if (typeof pageWindow.fetch === "function") {
      try {
        const response = await pageWindow.fetch(url, {
          credentials: "include",
          cache: "no-store",
        });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${text.slice(0, 180)}`);
        }
        return text;
      } catch (error) {
        if (typeof GM_xmlhttpRequest !== "function") throw error;
      }
    }

    const response = await gmRequestJson(url);
    if (response.status < 200 || response.status >= 400) {
      throw new Error(`HTTP ${response.status}: ${response.text.slice(0, 180)}`);
    }
    return response.text;
  }

  async function requestJson(url) {
    const text = await requestText(url);
    try {
      return JSON.parse(text || "{}");
    } catch {
      throw new Error(`Non-JSON response: ${text.slice(0, 180)}`);
    }
  }

  async function prepare() {
    const nav = await requestJson("https://api.bilibili.com/x/web-interface/nav");
    if (nav.code !== 0) {
      throw new Error(nav.message || `nav failed (${nav.code})`);
    }
    if (!nav?.data?.isLogin) {
      throw new Error("Not logged in on Bilibili");
    }
    const wbiImg = nav?.data?.wbi_img || {};
    const imgUrl = String(wbiImg.img_url || "");
    const subUrl = String(wbiImg.sub_url || "");
    const imgKey = imgUrl.slice(imgUrl.lastIndexOf("/") + 1, imgUrl.lastIndexOf("."));
    const subKey = subUrl.slice(subUrl.lastIndexOf("/") + 1, subUrl.lastIndexOf("."));
    if (!imgKey || !subKey) {
      throw new Error("Could not extract WBI keys from nav response");
    }

    const webgl = getWebglInfo();
    return {
      img_key: imgKey,
      sub_key: subKey,
      dm_img_list: "[]",
      dm_img_str: webgl.dm_img_str,
      dm_cover_img_str: webgl.dm_cover_img_str,
      dm_img_inter: buildDmImgInter(),
      web_location: DEFAULT_WEB_LOCATION,
    };
  }

  async function fetchUrls(cmd) {
    const urls = Array.isArray(cmd?.args?.urls) ? cmd.args.urls : [];
    if (!urls.length) {
      throw new Error("Missing urls");
    }

    const results = [];
    for (const url of urls) {
      try {
        const data = await requestJson(url);
        results.push({ ok: true, url, data });
      } catch (error) {
        results.push({ ok: false, url, error: error.message || String(error) });
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return results;
  }

  async function runCommand(cmd) {
    if (cmd.action === "prepare") {
      return prepare();
    }
    if (cmd.action === "fetch") {
      return fetchUrls(cmd);
    }
    throw new Error(`Unknown action: ${cmd.action}`);
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    setStatus(`disconnected, retry in ${Math.round(delay / 1000)}s`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  async function handleCommand(cmd) {
    if (busy) {
      sendWs({ type: "result", id: cmd.id, ok: false, error: "Userscript is busy with another command" });
      return;
    }
    busy = true;
    try {
      const data = await runCommand(cmd);
      sendWs({ type: "result", id: cmd.id, ok: true, data });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      setStatus(`error\n${message}`);
      sendWs({ type: "result", id: cmd.id, ok: false, error: message });
    } finally {
      busy = false;
    }
  }

  function connect() {
    if (!becomeWorker()) {
      if (lastStatus !== "standby, another tab is worker") {
        setStatus("standby, another tab is worker");
      }
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, LOCK_TTL_MS);
      return;
    }

    try {
      ws = new WebSocket(WS_URL);
    } catch (error) {
      setStatus(`ws error\n${error.message || String(error)}`);
      scheduleReconnect();
      return;
    }

    ws.addEventListener("open", () => {
      reconnectDelay = RECONNECT_MIN_MS;
      setStatus("connected, waiting");
      sendWs({ type: "hello", site: SITE, version: VERSION, contextId: TAB_ID });
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "command") {
        becomeWorker();
        handleCommand(msg);
      }
    });

    ws.addEventListener("close", () => {
      ws = null;
      if (!busy) setStatus("disconnected");
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      setStatus("ws error");
    });
  }

  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) becomeWorker();
  }, Math.max(1000, Math.floor(LOCK_TTL_MS / 2)));

  window.addEventListener("beforeunload", () => {
    releaseWorker();
    try {
      ws && ws.close();
    } catch {}
  });

  setStatus("starting");
  connect();
})();
