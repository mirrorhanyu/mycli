// ==UserScript==
// @name         mycli Toutiao Bridge
// @namespace    local.mycli.toutiao
// @version      0.4.2
// @description  WebSocket bridge to the mycli micro-daemon. Drives mp.toutiao.com on behalf of the CLI.
// @match        https://mp.toutiao.com/*
// @downloadURL  http://127.0.0.1:17872/userscript/toutiao/mycli.user.js
// @updateURL    http://127.0.0.1:17872/userscript/toutiao/mycli.user.js
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ── Constants ────────────────────────────────────────────────────────────
  const HTTP_API = "http://127.0.0.1:17872";
  const WS_URL = "ws://127.0.0.1:17872/ws";
  const SITE = "toutiao";
  const VERSION = "0.4.2";
  const UPLOAD_SOURCE = 20020002;
  const PUBLISH_ENV_TIMEOUT_MS = 15000;
  const PUBLISH_ENV_INTERVAL_MS = 250;
  const TAB_ID = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const LOCK_KEY = "mycli-toutiao-worker-lock";
  const LOCK_TTL_MS = 5000;
  const RECONNECT_MIN_MS = 1000;
  const RECONNECT_MAX_MS = 15000;
  let busy = false;
  let lastStatus = "";
  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_MIN_MS;

  // ── Status box ───────────────────────────────────────────────────────────
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
    let box = document.getElementById("mycli-toutiao-status");
    if (!box) {
      box = document.createElement("div");
      box.id = "mycli-toutiao-status";
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
        "max-width:260px",
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

  // ── Worker lock (only one tab does the work) ─────────────────────────────
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

  // ── Page-world access ────────────────────────────────────────────────────
  // Tampermonkey gives us `unsafeWindow`, which is a reference to the real
  // page window. We can read page globals (e.g. `Garr`) and call page methods
  // (e.g. `Garr.network.post`) directly from the isolated world. No <script>
  // injection needed, which means we side-step the publish page's strict CSP.
  function pageWindow() {
    return typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  }

  // ── Helpers for daemon traffic ───────────────────────────────────────────
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

  // ── Page-context image upload + publish ──────────────────────────────────
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitForPublishEnvironment() {
    const deadline = Date.now() + PUBLISH_ENV_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const pw = pageWindow();
      if (pw.Garr && pw.Garr.network && typeof pw.Garr.network.post === "function" &&
          document.querySelector(".ProseMirror")) {
        return;
      }
      await sleep(PUBLISH_ENV_INTERVAL_MS);
    }
    throw new Error("头条发文页尚未就绪（缺 Garr.network.post 或 ProseMirror 编辑器）");
  }

  async function uploadImageToToutiao(arrayBuffer, mime, filename) {
    const pw = pageWindow();
    // Construct Blob and FormData in the page realm so the page's fetch sees
    // them as native page objects (avoids any cross-realm quirks).
    const blob = new pw.Blob([arrayBuffer], { type: mime || "application/octet-stream" });
    const formData = new pw.FormData();
    formData.append("image", blob, filename || "image");
    const response = await pw.fetch(
      `/spice/image?upload_source=${UPLOAD_SOURCE}&need_enhance=true&aid=1231&device_platform=web&scene=paste`,
      { method: "POST", body: formData, credentials: "include" },
    );
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) {
      throw new Error(payload.message || `图片上传失败 (HTTP ${response.status})`);
    }
    return {
      ...payload.data,
      log_id: response.headers.get("x-tt-logid") || "",
    };
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function normalizeWhitespace(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function buildImageBlockHtml(meta) {
    return [
      '<div class="pgc-img">',
      `<img src="${escapeHtml(meta.image_url)}" story_id="" image_ids="[]" image_type="${escapeHtml(meta.image_type || "")}" mime_type="${escapeHtml(meta.image_mime_type || "")}" web_uri="${escapeHtml(meta.image_uri || "")}" img_width="${escapeHtml(meta.image_width || "")}" img_height="${escapeHtml(meta.image_height || "")}">`,
      '<p class="pgc-img-caption"></p>',
      "</div>",
    ].join("");
  }

  function replacePlaceholders(html, images, uploadedByPath) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const imageNode of [...doc.querySelectorAll("img")]) {
      const src = imageNode.getAttribute("src") || "";
      const match = /^codex-local:\/\/image\/(\d+)$/.exec(src);
      if (!match) continue;
      const occurrence = images[Number(match[1])];
      if (!occurrence) throw new Error(`未找到占位图片: ${src}`);
      const uploaded = uploadedByPath.get(occurrence.local_path);
      if (!uploaded) throw new Error(`未找到已上传图片: ${occurrence.local_path}`);

      const wrapper = doc.createElement("div");
      wrapper.innerHTML = buildImageBlockHtml(uploaded);
      const replacement = wrapper.firstElementChild;
      const parent = imageNode.parentElement;
      const parentIsImageParagraph =
        parent &&
        parent.tagName === "P" &&
        parent.childElementCount === 1 &&
        normalizeWhitespace(parent.textContent || "") === "";
      if (parentIsImageParagraph) {
        parent.replaceWith(replacement);
      } else {
        imageNode.replaceWith(replacement);
      }
    }
    return doc.body.innerHTML;
  }

  // Cover payload shape captured from a real publish request. `coverType` is
  // always 2 (the toutiao publisher's single-cover slot); whether a cover is
  // selected is encoded by an entry in `pgc_feed_covers`.
  function buildCoverEntry(uploaded) {
    return {
      id: "",
      url: uploaded.image_url,
      uri: uploaded.image_uri,
      ic_uri: "",
      thumb_width: Number(uploaded.image_width) || 0,
      thumb_height: Number(uploaded.image_height) || 0,
      extra: { from_content_uri: "", from_content: "0" },
    };
  }

  function buildPublishBody(title, finalHtml, coverUploaded) {
    const textContent = new DOMParser().parseFromString(finalHtml, "text/html").body.textContent || "";
    const coverList = coverUploaded ? [buildCoverEntry(coverUploaded)] : [];
    return {
      article_type: 0,
      source: 29,
      extra: JSON.stringify({
        content_source: 100000000402,
        content_word_cnt: textContent.length,
        is_multi_title: 0,
        sub_titles: [],
        gd_ext: {
          entrance: "",
          from_page: "publisher_mp",
          enter_from: "PC",
          device_platform: "mp",
          is_message: 0,
        },
        tuwen_wtt_transfer_switch: "1",
      }),
      content: finalHtml,
      title: title,
      search_creation_info: JSON.stringify({ searchTopOne: 0, abstract: "", clue_id: "" }),
      title_id: `${Date.now()}_${Math.floor(Math.random() * 1e16)}`,
      mp_editor_stat: "{}",
      is_refute_rumor: 0,
      save: 0,
      entrance: "",
      timer_status: 0,
      timer_time: "2026-05-23 02:24",
      educluecard: "",
      draft_form_data: JSON.stringify({ coverType: 2 }),
      pgc_feed_covers: JSON.stringify(coverList),
      article_ad_type: 3,
      is_fans_article: 0,
      govern_forward: 0,
      praise: 0,
      disable_praise: 0,
      tree_plan_article: 0,
      star_order_id: "",
      star_order_name: "",
      activity_tag: 0,
      trends_writing_tag: 0,
      claim_exclusive: 0,
    };
  }

  async function runDraft(cmd) {
    const args = cmd.args || {};
    const title = String(args.title || "").trim();
    const html = String(args.html || "");
    const images = Array.isArray(args.images) ? args.images : [];
    const attachments = Array.isArray(args.attachments) ? args.attachments : [];
    if (!title) throw new Error("Missing title");
    if (!html) throw new Error("Missing html");

    setStatus(`draft: waiting publish env\n${cmd.id.slice(0, 8)}`);
    await waitForPublishEnvironment();

    // Group occurrences by local_path so each unique image is uploaded once.
    const uniquePaths = [];
    const seen = new Set();
    for (const img of images) {
      if (!seen.has(img.local_path)) {
        seen.add(img.local_path);
        uniquePaths.push(img);
      }
    }

    const uploadedByPath = new Map();
    let uploadedCount = 0;
    for (const img of uniquePaths) {
      const attachment = attachments[img.attachment_index];
      if (!attachment) {
        throw new Error(`图片 #${img.index} 缺少 attachment (index=${img.attachment_index})`);
      }
      setStatus(
        `draft: upload ${uploadedCount + 1}/${uniquePaths.length}\n${attachment.name}`,
      );
      const buffer = await fetchAttachmentArrayBuffer(attachment.url);
      const uploaded = await uploadImageToToutiao(buffer, attachment.mime, attachment.name);
      uploadedByPath.set(img.local_path, uploaded);
      uploadedCount += 1;
    }

    setStatus(`draft: building final html\n${cmd.id.slice(0, 8)}`);
    const finalHtml = replacePlaceholders(html, images, uploadedByPath);

    let coverUploaded = null;
    const coverIdx = args.cover_attachment_index;
    if (coverIdx !== null && coverIdx !== undefined) {
      const coverAttachment = attachments[coverIdx];
      if (!coverAttachment) {
        throw new Error(`cover_attachment_index=${coverIdx} 越界`);
      }
      setStatus(`draft: upload cover\n${coverAttachment.name}`);
      const buffer = await fetchAttachmentArrayBuffer(coverAttachment.url);
      coverUploaded = await uploadImageToToutiao(buffer, coverAttachment.mime, coverAttachment.name);
    }

    setStatus(`draft: publishing\n${title.slice(0, 30)}`);
    const pw = pageWindow();
    const response = await pw.Garr.network.post(
      "/mp/agw/article/publish?source=mp&type=article&aid=1231&mp_publish_ab_val=0",
      buildPublishBody(title, finalHtml, coverUploaded),
    );
    if (!response || response.code !== 0) {
      throw new Error((response && response.message) || "头条草稿保存失败");
    }
    const pgcId = (response.data && response.data.pgc_id) || "";
    const draftUrl = pgcId
      ? `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${encodeURIComponent(pgcId)}`
      : "";

    setStatus(`draft: saved\npgc_id=${pgcId}`);
    return {
      pgc_id: pgcId,
      draft_url: draftUrl,
      title,
      image_occurrence_count: images.length,
      unique_image_count: uploadedByPath.size,
      content_length: finalHtml.length,
      cover: coverUploaded
        ? {
            image_url: coverUploaded.image_url,
            image_uri: coverUploaded.image_uri,
            image_width: coverUploaded.image_width,
            image_height: coverUploaded.image_height,
          }
        : null,
    };
  }

  // ── Command dispatch ─────────────────────────────────────────────────────
  async function runCommand(cmd) {
    // cmd = { id, action, args }
    setStatus(`running ${cmd.action}\n${cmd.id.slice(0, 8)}`);
    if (cmd.action === "ping") {
      const pw = pageWindow();
      const data = {
        pong: true,
        href: location.href,
        ts: Date.now(),
        message: cmd.args && cmd.args.message,
        hasGarr: typeof pw.Garr !== "undefined",
        garrNetworkPost: typeof (pw.Garr && pw.Garr.network && pw.Garr.network.post),
        userAgent: navigator.userAgent,
      };
      setStatus(`done\n${cmd.id.slice(0, 8)}`);
      return data;
    }
    if (cmd.action === "draft") {
      const data = await runDraft(cmd);
      setStatus(`done\n${cmd.id.slice(0, 8)}`);
      return data;
    }
    throw new Error(`Unknown action: ${cmd.action}`);
  }

  // ── WebSocket transport ──────────────────────────────────────────────────
  function sendWs(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
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
      const message = (error && error.message) || String(error);
      setStatus(`error\n${message}`);
      sendWs({ type: "result", id: cmd.id, ok: false, error: message });
    } finally {
      busy = false;
    }
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
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
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

  // Keep the worker lock fresh while this tab is the worker.
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) becomeWorker();
  }, Math.max(1000, Math.floor(LOCK_TTL_MS / 2)));

  setStatus("starting");
  window.addEventListener("beforeunload", () => {
    releaseWorker();
    try { ws && ws.close(); } catch {}
  });
  connect();
})();
