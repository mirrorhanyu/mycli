// ==UserScript==
// @name         mycli SMZDM Bridge
// @namespace    local.mycli.smzdm
// @version      0.3.5
// @description  WebSocket bridge to the mycli micro-daemon. Syncs the current SMZDM session and saves drafts through browser-side APIs.
// @match        https://post.smzdm.com/post/*
// @match        https://post.smzdm.com/edit/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @downloadURL  http://127.0.0.1:17872/userscript/smzdm/mycli.user.js
// @updateURL    http://127.0.0.1:17872/userscript/smzdm/mycli.user.js
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const SITE = "smzdm";
  const VERSION = "0.3.5";
  const AUTOSAVE_URL_RE = /\/api\/editor\/article\/(submit|save)|\/api\/draft\//;
  // Tampermonkey sandboxes the script when any GM_* grant is declared. Page
  // globals like `editor` live on the real page window, accessible via
  // `unsafeWindow`. Fall back to `window` when running unsandboxed.
  const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const HTTP_API = "http://127.0.0.1:17872";
  const WS_URL = "ws://127.0.0.1:17872/ws";
  const TAB_ID = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const LOCK_KEY = "mycli-smzdm-worker-lock";
  const LOCK_TTL_MS = 5000;
  const RECONNECT_MIN_MS = 1000;
  const RECONNECT_MAX_MS = 15000;
  const URL_POLL_MS = 1000;
  const SESSION_SYNC_MIN_MS = 1500;

  let busy = false;
  let ws = null;
  let lastStatus = "";
  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  let lastHref = location.href;
  let lastSessionSignature = "";
  let lastSyncAt = 0;

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
    let box = document.getElementById("mycli-smzdm-status");
    if (!box) {
      box = document.createElement("div");
      box.id = "mycli-smzdm-status";
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
      const mount = document.body || document.documentElement || document.head;
      if (mount) {
        mount.appendChild(box);
      } else {
        const mountLater = () => {
          const target = document.body || document.documentElement || document.head;
          if (!target) {
            requestAnimationFrame(mountLater);
            return;
          }
          target.appendChild(box);
        };
        requestAnimationFrame(mountLater);
      }
    }
    statusBox = box;
    box.onclick = () => {
      if (statusCollapsed) expandStatus();
      else collapseStatus();
    };
    box.dataset.full = `mycli/${SITE} ${VERSION}\n${text}`;
    expandStatus();
  }

  function lockSnapshot() {
    try {
      return JSON.parse(localStorage.getItem(LOCK_KEY) || "null");
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
    localStorage.setItem(
      LOCK_KEY,
      JSON.stringify({ id: TAB_ID, expires_at: now + LOCK_TTL_MS }),
    );
    return lockSnapshot()?.id === TAB_ID;
  }

  function releaseWorker() {
    if (lockSnapshot()?.id === TAB_ID) {
      localStorage.removeItem(LOCK_KEY);
    }
  }

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

  function logStep(msg) {
    sendWs({ type: "log", level: "info", msg: `[draft] ${msg}` });
  }

  function currentSession() {
    const cookie = String(document.cookie || "").trim();
    if (!cookie) return null;
    return {
      cookie,
      url: location.href,
      updatedAt: Date.now(),
    };
  }

  function sessionSignature(session) {
    return `${session.cookie}\n${session.url}`;
  }

  function syncSession(reason, { force = false } = {}) {
    if (!becomeWorker()) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const session = currentSession();
    if (!session) {
      setStatus("connected, waiting for login");
      return;
    }
    const now = Date.now();
    const signature = sessionSignature(session);
    if (!force) {
      if (signature === lastSessionSignature) return;
      if (now - lastSyncAt < SESSION_SYNC_MIN_MS) return;
    }
    lastSessionSignature = signature;
    lastSyncAt = now;
    sendWs({
      type: "session_update",
      site: SITE,
      contextId: TAB_ID,
      data: session,
    });
    setStatus(`connected, session synced\n${reason}`);
  }

  function fetchAttachmentArrayBuffer(urlPath) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: `${HTTP_API}${urlPath}`,
        responseType: "arraybuffer",
        timeout: 60000,
        onload(response) {
          if (response.status >= 400) {
            reject(new Error(`HTTP ${response.status}`));
            return;
          }
          resolve(response.response);
        },
        onerror() { reject(new Error("Cannot fetch attachment from daemon")); },
        ontimeout() { reject(new Error("Attachment download timed out")); },
      });
    });
  }

  function getArticleId() {
    return String(document.querySelector("#article_id")?.value || "").trim();
  }

  function installAutosaveWatcher() {
    if (pageWindow.__mycliSmzdmAutosave) return pageWindow.__mycliSmzdmAutosave;
    const state = {
      pending: 0,
      lastStartedAt: 0,
      lastCompletedAt: 0,
      lastStatus: 0,
      lastUrl: "",
    };

    const XHR = pageWindow.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const origOpen = XHR.prototype.open;
      XHR.prototype.open = function (method, url) {
        this.__mycliAutosave = AUTOSAVE_URL_RE.test(String(url || ""));
        this.__mycliAutosaveUrl = String(url || "");
        return origOpen.apply(this, arguments);
      };
      const origSend = XHR.prototype.send;
      XHR.prototype.send = function () {
        if (this.__mycliAutosave) {
          state.pending += 1;
          state.lastStartedAt = Date.now();
          state.lastUrl = this.__mycliAutosaveUrl;
          const done = () => {
            state.pending = Math.max(0, state.pending - 1);
            state.lastCompletedAt = Date.now();
            state.lastStatus = this.status || 0;
          };
          this.addEventListener("loadend", done);
        }
        return origSend.apply(this, arguments);
      };
    }

    const origFetch = pageWindow.fetch;
    if (typeof origFetch === "function") {
      pageWindow.fetch = function (input, init) {
        const url = typeof input === "string" ? input : input && input.url;
        const isAutosave = AUTOSAVE_URL_RE.test(String(url || ""));
        if (isAutosave) {
          state.pending += 1;
          state.lastStartedAt = Date.now();
          state.lastUrl = String(url || "");
        }
        const p = origFetch.apply(this, arguments);
        if (isAutosave) {
          const done = (status) => {
            state.pending = Math.max(0, state.pending - 1);
            state.lastCompletedAt = Date.now();
            state.lastStatus = status || 0;
          };
          p.then((res) => done(res && res.status), () => done(0));
        }
        return p;
      };
    }

    pageWindow.__mycliSmzdmAutosave = state;
    return state;
  }

  const autosave = installAutosaveWatcher();

  function setNativeValue(el, value) {
    const desc =
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value") ||
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value") ||
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    if (desc?.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  function setTitle(title) {
    const input = document.querySelector('textarea.article-title, textarea[placeholder="请输入文章标题"]');
    if (!input) throw new Error("未找到标题输入框");
    setNativeValue(input, title);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: title, inputType: "insertText" }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function waitFor(predicate, { timeoutMs = 60000, intervalMs = 250, label = "操作" } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = await predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`${label}超时`);
  }

  // One-shot image upload. Sends multipart with `x-requested-with` so SMZDM's
  // WAF treats it as a regular XHR rather than a bare fetch.
  async function uploadImageOnce(attachment, articleId, fileIndex) {
    const arrayBuffer = await fetchAttachmentArrayBuffer(attachment.url);
    const mime = attachment.mime || "application/octet-stream";
    const blob = new pageWindow.Blob([arrayBuffer], { type: mime });
    const form = new pageWindow.FormData();
    form.append("imgFile", blob, attachment.name || "image");
    form.append("id", `WU_FILE_${fileIndex}`);
    form.append("type", mime);
    form.append("article_id", articleId);
    const response = await pageWindow.fetch("/api/images/upload/local", {
      method: "POST",
      credentials: "include",
      headers: { "x-requested-with": "XMLHttpRequest" },
      body: form,
    });
    const text = await response.text();
    if (text.trimStart().startsWith("<")) {
      const snippet = text.slice(0, 200).replace(/\s+/g, " ");
      const err = new Error(`图片上传被拦截 (HTTP ${response.status}, ${text.length}B): ${snippet}`);
      err.isWaf = true;
      throw err;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`图片上传响应不是 JSON (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }
    if (payload?.error_code !== 0 || !payload?.data?.url) {
      throw new Error(payload?.error_msg || `图片上传失败 (error_code=${payload?.error_code}): ${attachment.name}`);
    }
    return String(payload.data.url);
  }

  async function uploadImageToSmzdm(attachment, articleId, fileIndex) {
    const MAX_TRIES = 3;
    let lastError;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
      try {
        return await uploadImageOnce(attachment, articleId, fileIndex);
      } catch (error) {
        lastError = error;
        if (!error.isWaf || attempt === MAX_TRIES) throw error;
        const delay = attempt * 1500;
        logStep(`upload retry ${attempt}/${MAX_TRIES} after ${delay}ms: ${String(error.message).slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  // Splits the prepared HTML into alternating html/image segments. A top-level
  // block whose only meaningful child is a codex-local placeholder img becomes
  // an "image" step; everything else stays as raw html. SMZDM's image is a
  // top-level block node, so we insert it standalone (not wrapped in <p>).
  function planFromHtml(rawHtml) {
    const doc = new DOMParser().parseFromString(rawHtml, "text/html");
    const plan = [];
    for (const node of doc.body.childNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = /** @type {HTMLElement} */ (node);
      const placeholder = el.querySelector('img[src^="codex-local://image/"]');
      const match = placeholder && /^codex-local:\/\/image\/(\d+)$/.exec(placeholder.getAttribute("src") || "");
      if (match) {
        plan.push({ type: "image", placeholder_index: Number(match[1]) });
        continue;
      }
      plan.push({ type: "html", html: el.outerHTML });
    }
    return plan;
  }

  function imageNode(url) {
    // Attrs verified against editor.getJSON() output for a manually-pasted
    // image. `issmzmd` is BOOLEAN true (not string), `src` (not `pic_url`).
    return {
      type: "image",
      attrs: {
        src: url,
        platform: "fe",
        issmzmd: true,
        class: "",
      },
    };
  }

  async function saveDraftViaEditor(cmd) {
    const title = String(cmd.args?.title || "").trim();
    const rawHtml = String(cmd.args?.html || "").trim();
    if (!title) throw new Error("标题为空，无法保存草稿");
    if (!rawHtml) throw new Error("正文为空，无法保存草稿");
    const articleId = getArticleId();
    if (!articleId) {
      throw new Error(`未找到草稿页面，请先打开什么值得买投稿编辑页（当前: ${location.href}）`);
    }
    try {
      await waitFor(() => !!(pageWindow.editor && pageWindow.editor.commands), {
        timeoutMs: 8000,
        intervalMs: 200,
        label: "等待编辑器初始化",
      });
    } catch {
      throw new Error(`当前标签页未检测到 pageWindow.editor（${location.href}）`);
    }

    const attachments = Array.isArray(cmd.args?.attachments) ? cmd.args.attachments : [];
    const images = Array.isArray(cmd.args?.images) ? cmd.args.images : [];

    setStatus(`draft: preparing\n${articleId}`);
    logStep(`begin: articleId=${articleId}, title=${title.slice(0, 30)}, images=${images.length}, attachments=${attachments.length}`);
    setTitle(title);
    logStep("title set");

    // 1) Upload each unique attachment to SMZDM, collect real URLs.
    const urlByAttachmentIndex = new Map();
    for (let i = 0; i < attachments.length; i += 1) {
      const att = attachments[i];
      setStatus(`draft: upload ${i + 1}/${attachments.length}\n${att.name}`);
      logStep(`upload ${i + 1}/${attachments.length}: ${att.name} (${att.size}B, ${att.mime})`);
      const url = await uploadImageToSmzdm(att, articleId, i);
      urlByAttachmentIndex.set(i, url);
      logStep(`upload ${i + 1} ok → ${url}`);
    }

    // 2) Walk the plan and always append at the end of the doc. Plain
     //    `insertContent` inserts at the current selection — after a chain of
     //    inserts the cursor drifts in ways that make later calls clobber or
     //    no-op. `insertContentAt(<end>, ...)` is explicit and idempotent.
    const plan = planFromHtml(rawHtml);
    logStep(`plan: ${plan.length} steps`);
    pageWindow.editor.commands.clearContent();
    for (let i = 0; i < plan.length; i += 1) {
      const step = plan[i];
      const endPos = pageWindow.editor.state.doc.content.size;
      if (step.type === "html") {
        pageWindow.editor.commands.insertContentAt(endPos, step.html);
        continue;
      }
      const occurrence = images[step.placeholder_index];
      if (!occurrence) throw new Error(`未找到占位图片: ${step.placeholder_index}`);
      const url = urlByAttachmentIndex.get(occurrence.attachment_index);
      if (!url) throw new Error(`未找到上传 URL: ${occurrence.local_path}`);
      pageWindow.editor.commands.insertContentAt(endPos, imageNode(url));
      logStep(`step ${i + 1}/${plan.length}: image @${endPos} → ${url}`);
    }
    logStep(`content inserted (html ${pageWindow.editor.getHTML().length} chars), waiting for autosave`);

    setStatus(`draft: saving\n${title.slice(0, 24)}`);
    // SMZDM autosaves on a debounce (~5s after the last edit) and posts to
    // /api/editor/article/submit. Wait for an autosave that was triggered
    // *after* our edits finished, so we never report success on stale state.
    const editsFinishedAt = Date.now();
    await waitFor(
      () =>
        autosave.lastStartedAt >= editsFinishedAt &&
        autosave.pending === 0 &&
        autosave.lastCompletedAt >= autosave.lastStartedAt,
      { timeoutMs: 30000, intervalMs: 250, label: "等待自动保存" },
    );
    if (autosave.lastStatus && (autosave.lastStatus < 200 || autosave.lastStatus >= 300)) {
      throw new Error(`自动保存失败: HTTP ${autosave.lastStatus}`);
    }

    setStatus(`draft: saved\n${articleId}`);
    return {
      draft_id: articleId,
      draft_url: `https://post.smzdm.com/edit/${articleId}`,
      content_length: pageWindow.editor.getHTML().length,
      image_occurrence_count: Number(cmd.args?.image_occurrence_count) || images.length,
      unique_image_count: pageWindow.editor.commands.queryImageData().length,
      autosave_status: autosave.lastStatus,
      autosave_url: autosave.lastUrl,
      submit_result: null,
    };
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
      syncSession("socket open", { force: true });
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
      if (msg.action !== "draft") {
        sendResult(msg.id, false, `Unknown action for ${SITE}: ${msg.action}`);
        return;
      }
      busy = true;
        saveDraftViaEditor(msg)
          .then((result) => sendResult(msg.id, true, result))
          .catch((error) => sendResult(msg.id, false, error.message || String(error)))
          .finally(() => {
            busy = false;
            syncSession("draft finished", { force: true });
          });
        return;
      }
      if (msg.type === "hello_ack") {
        syncSession("hello ack", { force: true });
        return;
      }
      if (msg.type === "refresh_session") {
        syncSession("refresh requested", { force: true });
      }
    });

    ws.addEventListener("close", () => {
      ws = null;
      setStatus("disconnected");
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      setStatus("ws error");
    });
  }

  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      becomeWorker();
    }
  }, Math.max(1000, Math.floor(LOCK_TTL_MS / 2)));

  setInterval(() => {
    if (!becomeWorker()) return;
    if (location.href !== lastHref) {
      lastHref = location.href;
      syncSession("url changed", { force: true });
    }
  }, URL_POLL_MS);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      syncSession("page visible", { force: true });
    }
  });

  window.addEventListener("focus", () => {
    syncSession("window focused", { force: true });
  });

  window.addEventListener("beforeunload", () => {
    releaseWorker();
    try {
      ws && ws.close();
    } catch {}
  });

  setStatus("starting");
  connect();
})();
