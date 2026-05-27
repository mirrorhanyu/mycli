// ==UserScript==
// @name         mycli SMZDM Bridge
// @namespace    local.mycli.smzdm
// @version      0.2.0
// @description  WebSocket bridge to the mycli micro-daemon. Syncs the current SMZDM session and saves drafts through browser-side APIs.
// @match        https://post.smzdm.com/*
// @grant        GM_xmlhttpRequest
// @downloadURL  http://127.0.0.1:17872/userscript/smzdm/mycli.user.js
// @updateURL    http://127.0.0.1:17872/userscript/smzdm/mycli.user.js
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const SITE = "smzdm";
  const VERSION = "0.2.0";
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
      ].join(";");
      document.documentElement.appendChild(box);
    }
    box.textContent = `mycli/${SITE} ${VERSION}\n${text}`;
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

  function requestJson(url, options = {}) {
    return fetch(url, {
      credentials: "include",
      headers: {
        accept: "*/*",
        "x-requested-with": "XMLHttpRequest",
        ...(options.headers || {}),
      },
      ...options,
    }).then(async (res) => {
      const text = await res.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {}
      if (!res.ok) {
        throw new Error((payload && payload.error_msg) || `HTTP ${res.status}`);
      }
      return payload;
    });
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

  async function createOrReuseDraft() {
    const payload = await requestJson("/ajax_create_caogao");
    if (payload?.error_code !== 0 || !payload?.data) {
      throw new Error(payload?.error_msg || "无法创建草稿");
    }
    return String(payload.data);
  }

  async function fetchToken() {
    const payload = await requestJson("/api/editor/get_token");
    const token = payload?.data?.token;
    if (payload?.error_code !== 0 || !token) {
      throw new Error(payload?.error_msg || "无法获取投稿 token");
    }
    return String(token);
  }

  async function fetchDraftData(articleId) {
    const payload = await requestJson(`/api/draft/${encodeURIComponent(articleId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    if (payload?.error_code !== 0 || !payload?.data) {
      throw new Error(payload?.error_msg || "无法读取当前草稿信息");
    }
    return payload.data;
  }

  async function uploadLocalImage(attachment, { articleId, token, uploadIndex }) {
    const arrayBuffer = await fetchAttachmentArrayBuffer(attachment.url);
    const blob = new Blob([arrayBuffer], { type: attachment.mime || "application/octet-stream" });
    const form = new FormData();
    form.append("imgFile", blob, attachment.name || `image-${uploadIndex + 1}`);
    form.append("article_id", articleId);
    form.append("id", `WU_FILE_${uploadIndex}`);
    form.append("type", attachment.mime || "application/octet-stream");

    const payload = await requestJson("/api/images/upload/local", {
      method: "POST",
      headers: { _csrf_token: token },
      body: form,
    });
    if (payload?.error_code !== 0 || !payload?.data?.url) {
      throw new Error(payload?.error_msg || `图片上传失败: ${attachment.name}`);
    }
    return {
      id: payload.data.id || "",
      url: payload.data.url,
      pic_url: payload.data.url,
      original: payload.data,
    };
  }

  function replaceImagePlaceholders(html, images, uploadedByPath) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const imageNode of [...doc.querySelectorAll("img")]) {
      const src = imageNode.getAttribute("src") || "";
      const match = /^codex-local:\/\/image\/(\d+)$/.exec(src);
      if (!match) continue;
      const occurrence = images[Number(match[1])];
      if (!occurrence) throw new Error(`未找到占位图片: ${src}`);
      const uploaded = uploadedByPath.get(occurrence.local_path);
      if (!uploaded?.url) throw new Error(`未找到上传结果: ${occurrence.local_path}`);
      imageNode.setAttribute("src", uploaded.url);
    }
    return doc.body.innerHTML;
  }

  function htmlTextCount(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return (doc.body.textContent || "").replace(/\s+/g, "").length;
  }

  function buildSubmitParams({
    articleId,
    title,
    html,
    draftData,
    uploadedImages,
  }) {
    const params = new URLSearchParams();
    const focusImage =
      uploadedImages[0]?.url ||
      draftData?.article_image?.pic_url ||
      draftData?.article_image_url ||
      "";

    params.set("article_id", articleId);
    params.set("submit_type", "manul_save");
    params.set("ai_title", draftData?.ai_title || "");
    params.set("title", title);
    params.set("series_title", draftData?.series_title || "");
    params.set("focus_image", focusImage);
    params.set("series_order_id", String(draftData?.series_order_id || 0));
    params.set("series_id", String(draftData?.series_id || 0));
    params.set("anonymous", String(draftData?.anonymous || 0));
    params.set("first_publish", String(draftData?.first_publish || 0));
    params.set("remark", draftData?.remark || "");
    params.set("editorValue", html);
    params.set("create_state_type", String(draftData?.create_state_type || 0));
    params.set("ai_state_type", String(draftData?.ai_state_type || 0));
    params.set("topic_list", JSON.stringify(draftData?.topic_list || []));
    params.set("tag_list", JSON.stringify(draftData?.tag_list || []));
    params.set("square_pic_url", draftData?.square_pic_url || "");
    params.set("cover_image_rectangle", draftData?.cover_image_rectangle || "");
    params.set("cover_image_square", draftData?.cover_image_square || "");
    params.set("group_id", draftData?.group_id || "");
    params.set("wne", String(htmlTextCount(html)));
    if (uploadedImages.length) {
      params.set(
        "image_list",
        JSON.stringify(
          uploadedImages.map((item) => ({
            id: item.id || "",
            pic_url: item.pic_url || item.url,
            url: item.url,
          })),
        ),
      );
    }
    if (draftData?.ai_outline_log_ids) {
      params.set("ai_outline_log_ids", String(draftData.ai_outline_log_ids));
    }
    return params;
  }

  async function saveDraftViaApi(cmd) {
    const title = String(cmd.args?.title || "").trim();
    const rawHtml = String(cmd.args?.html || "").trim();
    if (!title) throw new Error("标题为空，无法保存草稿");
    if (!rawHtml) throw new Error("正文为空，无法保存草稿");

    const draftId = await createOrReuseDraft();
    setStatus(`draft: ready\n${draftId}`);

    const token = await fetchToken();
    const draftData = await fetchDraftData(draftId);

    const attachments = Array.isArray(cmd.args?.attachments) ? cmd.args.attachments : [];
    const images = Array.isArray(cmd.args?.images) ? cmd.args.images : [];
    const uploadedByPath = new Map();

    if (images.length) {
      const dedupedByPath = new Map();
      for (const image of images) {
        if (!dedupedByPath.has(image.local_path)) {
          dedupedByPath.set(image.local_path, image);
        }
      }
      const uniqueImages = [...dedupedByPath.values()];
      for (let index = 0; index < uniqueImages.length; index += 1) {
        const image = uniqueImages[index];
        const attachment = attachments[image.attachment_index];
        if (!attachment) {
          throw new Error(`未找到图片附件: ${image.local_path}`);
        }
        setStatus(`draft: upload ${index + 1}/${uniqueImages.length}\n${attachment.name}`);
        const uploaded = await uploadLocalImage(attachment, {
          articleId: draftId,
          token,
          uploadIndex: index,
        });
        uploadedByPath.set(image.local_path, uploaded);
      }
    }

    const finalHtml = images.length
      ? replaceImagePlaceholders(rawHtml, images, uploadedByPath)
      : rawHtml;
    const uploadedImages = [...uploadedByPath.values()];
    const body = buildSubmitParams({
      articleId: draftId,
      title,
      html: finalHtml,
      draftData,
      uploadedImages,
    });

    setStatus(`draft: saving\n${title.slice(0, 24)}`);
    const payload = await requestJson("/api/editor/article/submit", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        _csrf_token: token,
      },
      body: body.toString(),
    });
    if (payload?.error_code !== 0) {
      throw new Error(payload?.error_msg || "保存草稿失败");
    }

    setStatus(`draft: saved\n${draftId}`);
    return {
      draft_id: draftId,
      draft_url: `https://post.smzdm.com/edit/${draftId}`,
      content_length: finalHtml.length,
      image_occurrence_count: Number(cmd.args?.image_occurrence_count) || images.length,
      unique_image_count: uploadedImages.length,
      submit_result: payload?.data || null,
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
        saveDraftViaApi(msg)
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
