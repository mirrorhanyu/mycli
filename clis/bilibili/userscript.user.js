// ==UserScript==
// @name         mycli Bilibili Bridge
// @namespace    local.mycli.bilibili
// @version      0.2.1
// @description  WebSocket bridge to the mycli micro-daemon for Bilibili recent-upload and sell jobs.
// @match        https://*.bilibili.com/*
// @match        https://bilibili.com/*
// @noframes
// @downloadURL  http://127.0.0.1:17872/userscript/bilibili/mycli.user.js
// @updateURL    http://127.0.0.1:17872/userscript/bilibili/mycli.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
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
  const VERSION = "0.2.1";
  const TAB_ID = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  // accountId -> { accountId, accountName, lockedAt }; a map so that several
  // accounts (e.g. containers or incognito sharing GM storage) can stay locked
  // at the same time. The daemon keeps one page per account.
  const ACCOUNT_LOCKS_KEY = "mycli-bilibili-account-locks";
  const LEGACY_ACCOUNT_LOCK_KEY = "mycli-bilibili-account-lock";
  const ACCOUNT_REFRESH_MS = 30000;
  const RECONNECT_MIN_MS = 1000;
  const RECONNECT_MAX_MS = 15000;
  const DEFAULT_WEB_LOCATION = "333.1387";
  const DEFAULT_SELL_REFERER = "https://cm.bilibili.com/";
  const SELL_BATCH_SIZE = 5;

  let ws = null;
  let busy = false;
  let superseded = false;
  let standby = false;
  let takeoverRequested = false;
  let connectedAccountId = "";
  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  let accountRefreshTimer = null;
  let lastStatus = "";
  let currentAccount = {
    loaded: false,
    valid: false,
    isLogin: false,
    accountId: "",
    accountName: "",
    url: "",
  };
  let accountLocks = {};
  let connectionNote = "";

  // Unified mycli status box style (keep in sync across all userscripts).
  const STATUS_COLLAPSE_MS = 3000;
  const STATUS_PEEK_PX = 18;
  const STATUS_SWIPE_PX = 48;
  const STATUS_BOX_CSS = [
    "position:fixed",
    "right:0",
    "top:72px",
    "z-index:2147483647",
    "background:rgba(17,24,39,.92)",
    "color:#fff",
    "font:12px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    "padding:8px 10px",
    "border-radius:10px 0 0 10px",
    "border-left:3px solid #3b82f6",
    "box-shadow:0 8px 24px rgba(0,0,0,.18)",
    "max-width:320px",
    "white-space:pre-wrap",
    "cursor:pointer",
    "user-select:none",
    "touch-action:none",
    "transition:transform .25s ease, opacity .25s ease",
  ].join(";");
  let statusBox = null;
  let statusContent = null;
  let statusHeader = null;
  let statusLockLine = null;
  let statusStateLine = null;
  let statusActionButton = null;
  let statusCollapsed = false;
  let statusCollapseTimer = null;

  function readAccountLocks() {
    try {
      const parsed = JSON.parse(GM_getValue(ACCOUNT_LOCKS_KEY, "{}") || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeAccountLocks(locks) {
    GM_setValue(ACCOUNT_LOCKS_KEY, JSON.stringify(locks || {}));
  }

  function migrateLegacyAccountLock() {
    try {
      const legacy = JSON.parse(GM_getValue(LEGACY_ACCOUNT_LOCK_KEY, "null") || "null");
      if (legacy && legacy.accountId) {
        const locks = readAccountLocks();
        if (!locks[String(legacy.accountId)]) {
          locks[String(legacy.accountId)] = legacy;
          writeAccountLocks(locks);
        }
      }
    } catch {}
    try { GM_deleteValue(LEGACY_ACCOUNT_LOCK_KEY); } catch {}
  }

  function currentLock() {
    if (!currentAccount.accountId) return null;
    return accountLocks[currentAccount.accountId] || null;
  }

  function currentPageLabel() {
    if (!currentAccount.loaded) return "正在获取账号信息";
    if (!currentAccount.valid) return "账号状态异常";
    if (!currentAccount.isLogin) return "未登录";
    return String(currentAccount.accountName || "").trim() || "未命名账号";
  }

  function lockDisplayName(lock) {
    return String(lock?.accountName || "").trim() || "未锁定";
  }

  function isLockedToCurrentAccount() {
    return Boolean(
      currentAccount.loaded &&
      currentAccount.isLogin &&
      currentAccount.accountId &&
      currentLock(),
    );
  }

  function isConnected() {
    return Boolean(ws && ws.readyState === WebSocket.OPEN);
  }

  function primaryActionLabel() {
    if (!currentAccount.loaded) {
      return "请先登录";
    }
    if (!currentAccount.valid) {
      return "账号状态异常";
    }
    if (!currentAccount.isLogin) {
      return "请先登录";
    }
    if (isLockedToCurrentAccount()) {
      if (isConnected()) return `退出${lockDisplayName(currentLock())}`;
      return "在本页接管";
    }
    return `切换为${currentPageLabel()}`;
  }

  function primaryActionDisabled() {
    return !currentAccount.loaded || !currentAccount.valid || !currentAccount.isLogin;
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

  function applyStatusTransform() {
    if (!statusBox) return;
    if (statusCollapsed) {
      statusBox.style.transform = `translateX(calc(100% - ${STATUS_PEEK_PX}px))`;
      statusBox.style.opacity = "0.7";
    } else {
      statusBox.style.transform = "none";
      statusBox.style.opacity = "1";
    }
  }

  function attachStatusGestures(box) {
    let suppressClick = false;

    box.addEventListener("click", () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if (statusCollapsed) expandStatus();
      else collapseStatus();
    });

    // Two-finger trackpad swipe right tucks the box away, like a macOS notification.
    let wheelAccum = 0;
    let wheelResetTimer = null;
    box.addEventListener("wheel", (event) => {
      if (statusCollapsed || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      wheelAccum = Math.max(0, wheelAccum + event.deltaX);
      clearTimeout(wheelResetTimer);
      if (wheelAccum >= STATUS_SWIPE_PX) {
        wheelAccum = 0;
        collapseStatus();
        return;
      }
      box.style.transform = `translateX(${wheelAccum}px)`;
      wheelResetTimer = setTimeout(() => {
        wheelAccum = 0;
        applyStatusTransform();
      }, 250);
    }, { passive: false });

    // Dragging the box to the right also tucks it away.
    let dragPointerId = null;
    let dragStartX = 0;
    let dragDx = 0;
    const endStatusDrag = (event) => {
      if (dragPointerId !== event.pointerId) return;
      dragPointerId = null;
      box.style.transition = "transform .25s ease, opacity .25s ease";
      if (dragDx > 4) suppressClick = true;
      if (dragDx >= STATUS_SWIPE_PX) collapseStatus();
      else applyStatusTransform();
      dragDx = 0;
    };
    box.addEventListener("pointerdown", (event) => {
      if (statusCollapsed || event.button !== 0) return;
      dragPointerId = event.pointerId;
      dragStartX = event.clientX;
      dragDx = 0;
    });
    box.addEventListener("pointermove", (event) => {
      if (dragPointerId !== event.pointerId) return;
      dragDx = event.clientX - dragStartX;
      if (dragDx > 4) {
        try { box.setPointerCapture(event.pointerId); } catch {}
        box.style.transition = "none";
        box.style.transform = `translateX(${dragDx}px)`;
      }
    });
    box.addEventListener("pointerup", endStatusDrag);
    box.addEventListener("pointercancel", endStatusDrag);
  }

  function ensureStatusBox() {
    if (statusBox) return;
    statusBox = document.createElement("div");
    statusBox.id = "mycli-bilibili-status";
    statusBox.style.cssText = STATUS_BOX_CSS;

    statusContent = document.createElement("div");
    statusHeader = document.createElement("div");
    statusLockLine = document.createElement("div");
    statusStateLine = document.createElement("div");
    const actionWrap = document.createElement("div");
    actionWrap.style.cssText = [
      "margin-top:8px",
    ].join(";");

    statusActionButton = document.createElement("button");
    statusActionButton.type = "button";
    statusActionButton.style.cssText = [
      "appearance:none",
      "border:0",
      "border-radius:8px",
      "padding:6px 10px",
      "background:#2563eb",
      "color:#fff",
      "cursor:pointer",
      "font:inherit",
    ].join(";");
    statusActionButton.onclick = (event) => {
      event.stopPropagation();
      if (primaryActionDisabled()) return;
      if (isLockedToCurrentAccount() && isConnected()) {
        unlockAccount();
      } else {
        lockCurrentAccount().catch((error) => {
          connectionNote = error?.message || String(error);
          renderStatus();
        });
      }
    };

    actionWrap.appendChild(statusActionButton);
    statusContent.appendChild(statusHeader);
    statusContent.appendChild(statusLockLine);
    statusContent.appendChild(statusStateLine);
    statusContent.appendChild(actionWrap);
    statusBox.appendChild(statusContent);
    // When expanded, clicks inside the content should not collapse the box;
    // when collapsed, let them bubble so the peeking sliver expands it.
    statusContent.onclick = (event) => {
      if (!statusCollapsed) event.stopPropagation();
    };
    attachStatusGestures(statusBox);
    document.documentElement.appendChild(statusBox);
  }

  function renderStatus() {
    ensureStatusBox();
    const lockedName = lockDisplayName(currentLock());
    statusHeader.textContent = `mycli/${SITE} ${VERSION}`;
    statusLockLine.textContent = `已锁定：${lockedName}${isConnected() ? "（已连接）" : ""}`;
    if (!currentAccount.loaded) {
      statusStateLine.textContent = "";
      statusStateLine.style.display = "none";
    } else if (!currentAccount.valid) {
      statusStateLine.textContent = "状态：账号状态异常";
      statusStateLine.style.display = "block";
    } else if (!currentAccount.isLogin) {
      statusStateLine.textContent = "状态：未登录";
      statusStateLine.style.display = "block";
    } else if (connectionNote) {
      statusStateLine.textContent = `状态：${connectionNote}`;
      statusStateLine.style.display = "block";
    } else {
      statusStateLine.textContent = "";
      statusStateLine.style.display = "none";
    }
    statusActionButton.textContent = primaryActionLabel();
    statusActionButton.disabled = primaryActionDisabled();
    statusActionButton.style.background = primaryActionDisabled() ? "#374151" : "#2563eb";
    applyStatusTransform();
    if (!statusCollapsed) {
      clearTimeout(statusCollapseTimer);
      statusCollapseTimer = setTimeout(collapseStatus, STATUS_COLLAPSE_MS);
    }
  }

  function setStatus(text) {
    lastStatus = text;
    connectionNote = text;
    renderStatus();
  }

  function sendWs(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  function sendSellLog(jobId, message, level = "info") {
    sendWs({
      type: "log",
      level,
      msg: `[sell ${jobId}] ${message}`,
    });
  }

  function closeSocket() {
    if (!ws) return;
    try {
      ws.close();
    } catch {}
    ws = null;
  }

  function handleSuperseded(msg) {
    // Only another page of the SAME account can supersede this one (the user
    // clicked takeover there). Different accounts coexist on the daemon now,
    // so keep the lock and just stand down until the user takes back over.
    const byName = String(msg?.by?.accountName || "").trim() || "其他页面";
    superseded = true;
    closeSocket();
    connectionNote = `已被「${byName}」的页面接管`;
    renderStatus();
  }

  function scheduleReconnect() {
    if (reconnectTimer || superseded || standby || !isLockedToCurrentAccount()) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    connectionNote = `断开连接，${Math.round(delay / 1000)}秒后重试`;
    renderStatus();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function publishSessionState() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    sendWs({
      type: "session_update",
      site: SITE,
      contextId: TAB_ID,
      data: {
        accountId: currentAccount.accountId,
        accountName: currentAccount.accountName,
        isLogin: currentAccount.isLogin,
        url: location.href,
      },
    });
  }

  async function fetchAccountState() {
    const nav = await requestJson("https://api.bilibili.com/x/web-interface/nav");
    if (nav.code !== 0) {
      throw new Error(nav.message || `nav failed (${nav.code})`);
    }
    const data = nav?.data || {};
    currentAccount = {
      loaded: true,
      valid: true,
      isLogin: Boolean(data.isLogin),
      accountId: data.mid == null ? "" : String(data.mid),
      accountName: String(data.uname || "").trim(),
      url: location.href,
    };
    if (!superseded && !standby) connectionNote = "";
    publishSessionState();
    renderStatus();
    return currentAccount;
  }

  function syncConnection() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (!isLockedToCurrentAccount()) {
      closeSocket();
      reconnectDelay = RECONNECT_MIN_MS;
      renderStatus();
      return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (connectedAccountId && connectedAccountId !== currentAccount.accountId) {
        // The page switched accounts under an open socket; re-register.
        closeSocket();
      } else {
        publishSessionState();
        renderStatus();
        return;
      }
    }
    connect();
  }

  async function lockCurrentAccount() {
    if (!currentAccount.loaded) {
      await fetchAccountState();
    }
    if (!currentAccount.isLogin) {
      throw new Error("当前页未登录，无法锁定账号");
    }
    accountLocks = readAccountLocks();
    accountLocks[currentAccount.accountId] = {
      accountId: currentAccount.accountId,
      accountName: currentAccount.accountName,
      lockedAt: Date.now(),
    };
    writeAccountLocks(accountLocks);
    superseded = false;
    standby = false;
    takeoverRequested = true;
    connectionNote = "";
    renderStatus();
    closeSocket();
    syncConnection();
  }

  function unlockAccount() {
    accountLocks = readAccountLocks();
    delete accountLocks[currentAccount.accountId];
    writeAccountLocks(accountLocks);
    superseded = false;
    standby = false;
    connectionNote = "";
    closeSocket();
    renderStatus();
  }

  async function refreshAccountAndSync() {
    try {
      await fetchAccountState();
    } catch (error) {
      currentAccount = {
        loaded: true,
        valid: false,
        isLogin: false,
        accountId: "",
        accountName: "",
        url: location.href,
      };
      connectionNote = error?.message || String(error);
      renderStatus();
    }
    syncConnection();
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

  function gmRequest(options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: options.method || "GET",
        url: options.url,
        headers: options.headers || {},
        data: options.data,
        timeout: options.timeout || 30000,
        withCredentials: options.withCredentials !== false,
        onload(response) {
          resolve({
            status: response.status,
            text: response.responseText || "",
            url: response.finalUrl || options.url,
          });
        },
        onerror() {
          reject(new Error(`Request failed: ${options.url}`));
        },
        ontimeout() {
          reject(new Error(`Request timed out: ${options.url}`));
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

  function readCsrfToken() {
    const match = String(document.cookie || "").match(/(?:^|;\s*)bili_jct=([^;]+)/);
    if (!match) {
      throw new Error("Missing bili_jct in browser cookies");
    }
    return decodeURIComponent(match[1]);
  }

  async function postMallJson(url, payload, referer = DEFAULT_SELL_REFERER) {
    const response = await gmRequest({
      method: "POST",
      url,
      data: JSON.stringify(payload || {}),
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Origin": "https://cm.bilibili.com",
        "Referer": referer,
        "csrf-token": readCsrfToken(),
        "DNT": "1",
      },
    });
    if (response.status < 200 || response.status >= 400) {
      throw new Error(`HTTP ${response.status}: ${response.text.slice(0, 180)}`);
    }
    try {
      return JSON.parse(response.text || "{}");
    } catch {
      throw new Error(`Non-JSON response: ${response.text.slice(0, 180)}`);
    }
  }

  function chunkUrls(urls, maxLen = 12000, maxItems = SELL_BATCH_SIZE) {
    const batches = [];
    let current = [];
    let currentLen = 0;
    for (const url of urls) {
      const extra = url.length + (current.length ? 1 : 0);
      if (current.length && (currentLen + extra > maxLen || current.length >= maxItems)) {
        batches.push(current);
        current = [url];
        currentLen = url.length;
      } else {
        current.push(url);
        currentLen += extra;
      }
    }
    if (current.length) batches.push(current);
    return batches;
  }

  function chunkItems(items, maxItems = SELL_BATCH_SIZE) {
    const batches = [];
    for (let index = 0; index < items.length; index += maxItems) {
      batches.push(items.slice(index, index + maxItems));
    }
    return batches;
  }

  function flattenDistinguishPayload(payload) {
    const data = payload?.data || {};
    const success = Array.isArray(data.successList) ? data.successList : [];
    const fail = Array.isArray(data.failList) ? data.failList : [];
    const rows = new Map();

    for (const item of success) {
      const url = String(item?.url || "").trim();
      if (!url) continue;
      rows.set(url, {
        status: "distinguish_ok",
        url,
        mid: item?.mid == null ? "" : String(item.mid),
        item_id: item?.itemId == null ? "" : String(item.itemId),
        good_id: item?.outerId == null ? "" : String(item.outerId),
        goods_name: String(item?.goodsName || ""),
        shop_name: String(item?.shopName || ""),
        raw: item,
      });
    }

    for (const item of fail) {
      const url = String(item?.url || "").trim();
      if (!url) continue;
      rows.set(url, {
        status: "distinguish_failed",
        url,
        mid: item?.mid == null ? "" : String(item.mid),
        item_id: item?.itemId == null ? "" : String(item.itemId),
        good_id: item?.outerId == null ? "" : String(item.outerId),
        goods_name: String(item?.goodsName || ""),
        shop_name: String(item?.shopName || ""),
        error: String(item?.distinguishTips || item?.message || "distinguish failed"),
        raw: item,
      });
    }

    return rows;
  }

  async function distinguishUrls(items, referer, logStep = null) {
    const uniqueUrls = [...new Set(items.map((item) => String(item.url || "").trim()).filter(Boolean))];
    const rowByUrl = new Map();
    const debug = [];
    const batches = chunkUrls(uniqueUrls);

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      const payload = { itemUrls: batch.join(",") };
      logStep?.(`distinguish ${batchIndex + 1}/${batches.length} start items=${batch.length}`);
      let response;
      try {
        response = await postMallJson(
          "https://mall.bilibili.com/mall-cbp/web/cmc/goods/distinguish/urls",
          payload,
          referer,
        );
      } catch (error) {
        logStep?.(`distinguish ${batchIndex + 1}/${batches.length} failed: ${String(error?.message || error).slice(0, 180)}`, "error");
        throw error;
      }
      if (Number(response?.code || 0) !== 0) {
        logStep?.(`distinguish ${batchIndex + 1}/${batches.length} rejected: code=${response?.code ?? "?"} message=${response?.message || ""}`.trim(), "error");
        throw new Error(`识别失败: code=${response?.code ?? "?"}, message=${response?.message || ""}`.trim());
      }
      debug.push({ batch, response });
      const batchRows = flattenDistinguishPayload(response);
      for (const [url, row] of batchRows.entries()) {
        rowByUrl.set(url, row);
      }
      logStep?.(`distinguish ${batchIndex + 1}/${batches.length} done rows=${batchRows.size}`);
    }

    return { rowByUrl, debug };
  }

  async function addGoodsToSelectionCart(rawGoods, referer) {
    const response = await postMallJson(
      "https://mall.bilibili.com/mall-cbp/web/selectionCart/item/add",
      {
        goods: rawGoods,
        operateSource: 2,
        bizExtraInfo: "",
        fromType: 12,
      },
      referer,
    );
    return response;
  }

  async function setAnotherName(itemId, anotherName, referer) {
    return postMallJson(
      "https://mall.bilibili.com/mall-cbp/web/selection/plan/item/setAnotherName",
      {
        itemId: String(itemId || "").trim(),
        anotherName: String(anotherName || "").trim(),
      },
      referer,
    );
  }

  async function selectionCartPage(page, size, referer) {
    return postMallJson(
      "https://mall.bilibili.com/mall-cbp/web/selectionCart/item/page",
      {
        page,
        size,
        sourceType: -1,
        promotionCampaigns: "",
        selectionCarItemType: 1,
        windowShelveStatus: -1,
        goodsName: "",
        requestFrom: -1,
      },
      referer,
    );
  }

  async function fetchSelectionCartRows(itemIds, referer, pageSize = SELL_BATCH_SIZE, maxPages = 20, logStep = null) {
    const wanted = new Set(itemIds.map((itemId) => String(itemId || "").trim()).filter(Boolean));
    const found = new Map();
    const debug = [];

    for (let page = 1; page <= maxPages; page += 1) {
      logStep?.(`selection page ${page}/${maxPages} start found=${found.size}/${wanted.size}`);
      const response = await selectionCartPage(page, pageSize, referer);
      if (Number(response?.code || 0) !== 0 || response?.success !== true) {
        throw new Error(
          `selection cart query failed: success=${response?.success} code=${response?.code} message=${response?.message || ""}`,
        );
      }
      debug.push({ page, response });
      const data = response?.data || {};
      const rows = Array.isArray(data.data) ? data.data : [];
      for (const row of rows) {
        const itemId = String(row?.itemId || row?.itemIdStr || "").trim();
        if (wanted.has(itemId) && !found.has(itemId)) {
          found.set(itemId, row);
        }
      }
      const totalCount = Number(data.total_count || 0);
      logStep?.(`selection page ${page}/${maxPages} done rows=${rows.length} found=${found.size}/${wanted.size}`);
      if ([...wanted].every((itemId) => found.has(itemId))) break;
      if (!rows.length) break;
      if (totalCount > 0 && page * pageSize >= totalCount) break;
    }

    return { rowByItemId: found, debug };
  }

  function finalizeSellRow(base) {
    const row = { ...base };
    const errors = [];
    if (row.distinguish_error) errors.push(`distinguish: ${row.distinguish_error}`);
    if (row.add_error) errors.push(`add: ${row.add_error}`);
    if (row.rename_error) errors.push(`rename: ${row.rename_error}`);
    if (row.selection_error) errors.push(`selection: ${row.selection_error}`);
    row.error = errors.join(" | ");

    if (row.short_url) {
      row.status = "ok";
    } else if (row.item_id || row.mid || row.good_id) {
      row.status = "partial";
    } else {
      row.status = "failed";
    }
    return row;
  }

  async function sellItems(cmd) {
    const items = Array.isArray(cmd?.args?.items) ? cmd.args.items : [];
    if (!items.length) {
      throw new Error("Missing items");
    }

    const jobId = String(cmd?.id || "unknown").slice(0, 8);
    const logStep = (message, level = "info") => sendSellLog(jobId, message, level);
    const referer = String(cmd?.args?.referer || DEFAULT_SELL_REFERER);
    const skipRename = cmd?.args?.skip_rename === true;
    const normalized = items.map((item, index) => ({
      index: Number.isInteger(item?.index) ? item.index : index,
      url: String(item?.url || "").trim(),
      short: String(item?.short || "").trim(),
    }));

    const invalid = normalized.find((item) => !item.url);
    if (invalid) {
      throw new Error(`Missing url for item index ${invalid.index}`);
    }

    const rowLabel = (row) => `#${row.index}${row.short ? ` ${row.short}` : ""}`;
    logStep(`start items=${normalized.length} skipRename=${skipRename}`);
    const debug = {};
    const { rowByUrl, debug: distinguishDebug } = await distinguishUrls(normalized, referer, logStep);
    debug.distinguish = distinguishDebug;
    logStep(`distinguish done matched=${rowByUrl.size}/${normalized.length}`);

    const results = normalized.map((item) => {
      const distinguished = rowByUrl.get(item.url);
      if (!distinguished) {
        return {
          index: item.index,
          url: item.url,
          short: item.short,
          status: "failed",
          error: "distinguish returned no row",
        };
      }
      return {
        index: item.index,
        url: item.url,
        short: item.short,
        mid: distinguished.mid || "",
        good_id: distinguished.good_id || "",
        item_id: distinguished.item_id || "",
        goods_name: distinguished.goods_name || "",
        shop_name: distinguished.shop_name || "",
        distinguish_raw: distinguished.raw || null,
        distinguish_error: distinguished.status === "distinguish_failed" ? distinguished.error || "distinguish failed" : "",
      };
    });

    debug.add = [];
    const addRows = results.filter((row) => row.item_id && row.distinguish_raw);
    const addBatches = chunkItems(addRows, SELL_BATCH_SIZE);
    logStep(`add start items=${addRows.length} batches=${addBatches.length} batchSize=${SELL_BATCH_SIZE}`);
    for (let batchIndex = 0; batchIndex < addBatches.length; batchIndex += 1) {
      const batch = addBatches[batchIndex];
      logStep(`add batch ${batchIndex + 1}/${addBatches.length} start items=${batch.length}`);
      try {
        const response = await addGoodsToSelectionCart(batch.map((row) => row.distinguish_raw), referer);
        debug.add.push({ urls: batch.map((row) => row.url), response });
        const infos = Array.isArray(response?.data?.infos) ? response.data.infos : [];
        if (Number(response?.code || 0) !== 0 || response?.success !== true) {
          const message = `success=${response?.success} code=${response?.code} message=${response?.message || ""}`.trim();
          for (const row of batch) row.add_error = message;
          logStep(`add batch ${batchIndex + 1}/${addBatches.length} failed: ${message}`, "warn");
          continue;
        }

        const infoByItemId = new Map();
        const infoByOuterId = new Map();
        for (const info of infos) {
          const itemId = String(info?.itemId || info?.oneItemId || "").trim();
          const outerId = String(info?.outerId || "").trim();
          if (itemId) infoByItemId.set(itemId, info);
          if (outerId) infoByOuterId.set(outerId, info);
        }

        let failed = 0;
        for (let rowIndex = 0; rowIndex < batch.length; rowIndex += 1) {
          const row = batch[rowIndex];
          const info = infoByItemId.get(String(row.item_id || ""))
            || infoByOuterId.get(String(row.good_id || ""))
            || (infos.length === batch.length ? infos[rowIndex] : null);
          if (!info) {
            row.add_error = "selectionCart add response missing item result";
            failed += 1;
            logStep(`add batch ${batchIndex + 1}/${addBatches.length} missing ${rowLabel(row)}`, "warn");
          } else if (Number(info?.resCode || 0) !== 0) {
            row.add_error = `resCode=${info?.resCode} resMsg=${info?.resMsg || ""}`.trim();
            failed += 1;
            logStep(`add batch ${batchIndex + 1}/${addBatches.length} failed ${rowLabel(row)}: ${row.add_error}`, "warn");
          }
        }
        logStep(`add batch ${batchIndex + 1}/${addBatches.length} done ok=${batch.length - failed} failed=${failed}`);
      } catch (error) {
        const message = error?.message || String(error);
        for (const row of batch) row.add_error = message;
        logStep(`add batch ${batchIndex + 1}/${addBatches.length} error: ${String(message).slice(0, 180)}`, "error");
      }
    }
    logStep(`add done items=${addRows.length} batches=${addBatches.length}`);

    if (!skipRename) {
      debug.rename = [];
      const renameRows = results.filter((row) => row.item_id && row.short);
      logStep(`rename start items=${renameRows.length}`);
      for (let renameIndex = 0; renameIndex < renameRows.length; renameIndex += 1) {
        const row = renameRows[renameIndex];
        logStep(`rename ${renameIndex + 1}/${renameRows.length} ${rowLabel(row)} itemId=${row.item_id}`);
        try {
          const response = await setAnotherName(row.item_id, row.short, referer);
          debug.rename.push({ url: row.url, response });
          if (response?.success === true) {
            row.rename_ok = true;
            logStep(`rename ${renameIndex + 1}/${renameRows.length} done ${rowLabel(row)}`);
          } else {
            row.rename_error = `success=${response?.success} code=${response?.code} message=${response?.message || ""}`.trim();
            logStep(`rename ${renameIndex + 1}/${renameRows.length} failed ${rowLabel(row)}: ${row.rename_error}`, "warn");
          }
        } catch (error) {
          row.rename_error = error?.message || String(error);
          logStep(`rename ${renameIndex + 1}/${renameRows.length} error ${rowLabel(row)}: ${String(row.rename_error).slice(0, 180)}`, "error");
        }
      }
      logStep(`rename done items=${renameRows.length}`);
    } else {
      logStep("rename skipped");
    }

    const itemIds = results.map((row) => row.item_id).filter(Boolean);
    if (itemIds.length) {
      logStep(`selection start itemIds=${itemIds.length}`);
      try {
        const { rowByItemId, debug: selectionDebug } = await fetchSelectionCartRows(
          itemIds,
          referer,
          SELL_BATCH_SIZE,
          20,
          logStep,
        );
        debug.selection = selectionDebug;
        for (const row of results) {
          if (!row.item_id) continue;
          const selectionRow = rowByItemId.get(row.item_id);
          if (!selectionRow) {
            row.selection_error = "selection cart row not found";
            continue;
          }
          row.short_url = String(selectionRow?.shortUrl || "").trim();
          row.selection_raw = selectionRow;
          if (!row.short_url) {
            row.selection_error = "selection cart row has no shortUrl";
          }
        }
        logStep(`selection done found=${rowByItemId.size}/${itemIds.length}`);
      } catch (error) {
        const message = error?.message || String(error);
        logStep(`selection error: ${String(message).slice(0, 180)}`, "error");
        for (const row of results) {
          if (row.item_id) row.selection_error = message;
        }
      }
    } else {
      logStep("selection skipped: no itemIds", "warn");
    }

    const finalized = results.map(finalizeSellRow);
    const summary = finalized.reduce((acc, row) => {
      acc.total += 1;
      if (row.status === "ok") acc.ok += 1;
      else if (row.status === "partial") acc.partial += 1;
      else acc.failed += 1;
      return acc;
    }, { total: 0, ok: 0, partial: 0, failed: 0 });
    logStep(`done total=${summary.total} ok=${summary.ok} partial=${summary.partial} failed=${summary.failed}`);
    return {
      items: finalized,
      summary,
      debug,
    };
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
    if (cmd.action === "sell") {
      return sellItems(cmd);
    }
    throw new Error(`Unknown action: ${cmd.action}`);
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
    if (superseded || !isLockedToCurrentAccount()) {
      closeSocket();
      renderStatus();
      return;
    }

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    // Consume the takeover request on this attempt only: automatic retries
    // must never steal the slot from a healthy page of the same account.
    const takeover = takeoverRequested;
    takeoverRequested = false;

    try {
      ws = new WebSocket(WS_URL);
    } catch (error) {
      connectionNote = `ws error: ${error.message || String(error)}`;
      renderStatus();
      scheduleReconnect();
      return;
    }

    ws.addEventListener("open", () => {
      reconnectDelay = RECONNECT_MIN_MS;
      standby = false;
      connectedAccountId = currentAccount.accountId;
      connectionNote = "";
      sendWs({
        type: "hello",
        site: SITE,
        version: VERSION,
        contextId: TAB_ID,
        accountId: currentAccount.accountId,
        accountName: currentAccount.accountName,
        takeover,
      });
      publishSessionState();
      renderStatus();
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "command") {
        handleCommand(msg);
        return;
      }
      if (msg.type === "hello_rejected") {
        // Another page already serves this account; stand by quietly. The
        // periodic account refresh keeps retrying, so this page takes over
        // automatically if the other one goes away.
        standby = true;
        connectionNote = "同账号的其他页面已连接，本页待命";
        renderStatus();
        return;
      }
      if (msg.type === "superseded") {
        handleSuperseded(msg);
      }
    });

    ws.addEventListener("close", () => {
      ws = null;
      connectedAccountId = "";
      if (standby || superseded || busy) {
        renderStatus();
        return;
      }
      if (isLockedToCurrentAccount()) {
        scheduleReconnect();
      } else {
        renderStatus();
      }
    });

    ws.addEventListener("error", () => {
      connectionNote = "ws error";
      renderStatus();
    });
  }

  migrateLegacyAccountLock();
  accountLocks = readAccountLocks();
  renderStatus();
  if (typeof GM_addValueChangeListener === "function") {
    GM_addValueChangeListener(ACCOUNT_LOCKS_KEY, (_name, _oldValue, newValue) => {
      try {
        const parsed = newValue ? JSON.parse(newValue) : {};
        accountLocks = parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        accountLocks = {};
      }
      renderStatus();
      syncConnection();
    });
  }

  refreshAccountAndSync();
  accountRefreshTimer = setInterval(() => {
    standby = false; // retry standby pages so they can fail over
    refreshAccountAndSync();
  }, ACCOUNT_REFRESH_MS);

  window.addEventListener("beforeunload", () => {
    if (accountRefreshTimer) clearInterval(accountRefreshTimer);
    closeSocket();
  });

  renderStatus();
})();
