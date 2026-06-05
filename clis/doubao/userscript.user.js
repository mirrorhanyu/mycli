// ==UserScript==
// @name         mycli Doubao Bridge
// @namespace    local.mycli.doubao
// @version      0.5.7
// @description  WebSocket bridge to the mycli micro-daemon. Drives Doubao on behalf of the CLI.
// @match        https://www.doubao.com/*
// @match        https://doubao.com/*
// @downloadURL  http://127.0.0.1:17872/userscript/doubao/mycli.user.js
// @updateURL    http://127.0.0.1:17872/userscript/doubao/mycli.user.js
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @connect      doubao.com
// @connect      www.doubao.com
// @connect      byteimg.com
// @connect      *.byteimg.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const HTTP_API = "http://127.0.0.1:17872";
  const WS_URL = "ws://127.0.0.1:17872/ws";
  const SITE = "doubao";
  const VERSION = "0.5.7";
  const TAB_ID = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const LOCK_KEY = "mycli-doubao-worker-lock";
  const LOCK_TTL_MS = 5000;
  const RECONNECT_MIN_MS = 1000;
  const RECONNECT_MAX_MS = 15000;
  const ANSWER_TIMEOUT_MS = 120000;
  const PODCAST_TIMEOUT_MS = 10 * 60 * 1000;
  const MIN_AUDIO_BYTES = 64 * 1024;
  const MAX_READ_CAPTURE_BYTES = 400 * 1024 * 1024;
  const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
  const STABLE_MS = 3500;
  const READ_AUDIO_QUIET_MS = 3000;
  const READ_AUDIO_FALLBACK_QUIET_MS = 15000;
  // Doubao's markdown renderer is debounced: even after the "停止生成" button
  // disappears (network stream ended), tokens keep flushing into the DOM for
  // another 1–5 seconds. Require the "done" signal to be stable for this long
  // before trusting it, so we don't return a truncated answer.
  const POST_DONE_QUIET_MS = 8000;

  let busy = false;
  let lastStatus = "";
  const capturedPodcastAudios = [];
  const readAudioCapture = {
    active: false,
    chunks: [],
    pcmChunks: [],
    sampleRate: 24000,
    startedAt: 0,
    lastChunkAt: 0,
    encodedBytes: 0,
    pcmBytes: 0,
    error: "",
  };

  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_MIN_MS;

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
    let box = document.getElementById("mycli-doubao-status");
    if (!box) {
      box = document.createElement("div");
      box.id = "mycli-doubao-status";
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

  function requestArrayBuffer(path) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url: `${HTTP_API}${path}`,
        responseType: "arraybuffer",
        timeout: 60000,
        onload(response) {
          if (response.status >= 400) {
            reject(new Error(`HTTP ${response.status}`));
            return;
          }
          resolve(response.response);
        },
        onerror() {
          reject(new Error("Cannot fetch attachment from local service"));
        },
        ontimeout() {
          reject(new Error("Attachment download timed out"));
        },
      });
    });
  }

  function headStatus(url) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: "HEAD",
        url,
        timeout: 15000,
        onload(response) {
          resolve(response.status);
        },
        onerror() {
          resolve(0);
        },
        ontimeout() {
          resolve(0);
        },
      });
    });
  }

  async function waitForAudioReady(getUrl, timeoutMs = 10 * 60 * 1000) {
    const started = Date.now();
    let lastStatus = 0;
    while (Date.now() - started < timeoutMs) {
      const url = getUrl();
      if (url) {
        const status = await headStatus(url);
        lastStatus = status;
        if (status >= 200 && status < 400) {
          return url;
        }
        setStatus(`waiting podcast audio\nHEAD ${status || "error"}`);
      } else {
        setStatus("waiting podcast audio_link");
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Podcast audio not ready (last HEAD ${lastStatus})`);
  }

  function audioResponseReady(status, contentType, byteLength) {
    const normalizedType = (contentType || "").toLowerCase();
    if (status < 200 || status >= 400) return false;
    if (/text\/html|application\/json|text\/plain/.test(normalizedType)) return false;
    return byteLength >= MIN_AUDIO_BYTES;
  }

  function requestBlob(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "arraybuffer",
        timeout: 10 * 60 * 1000,
        onprogress(event) {
          if (event.lengthComputable) {
            const percent = Math.round((event.loaded / event.total) * 100);
            setStatus(`downloading podcast\n${percent}%`);
          } else if (event.loaded) {
            const mb = (event.loaded / 1024 / 1024).toFixed(1);
            setStatus(`downloading podcast\n${mb} MB`);
          }
        },
        onload(response) {
          const contentType =
            response.responseHeaders?.match(/^content-type:\s*([^;\r\n]+)/im)?.[1]?.trim() ||
            "application/octet-stream";
          const byteLength = response.response?.byteLength || 0;
          if (response.status >= 400) {
            reject(new Error(`Audio download HTTP ${response.status}`));
            return;
          }
          if (!audioResponseReady(response.status, contentType, byteLength)) {
            reject(new Error(`Audio not ready (${response.status}, ${contentType}, ${byteLength} bytes)`));
            return;
          }
          resolve(new Blob([response.response], { type: contentType }));
        },
        onerror() {
          reject(new Error("Cannot download podcast audio"));
        },
        ontimeout() {
          reject(new Error("Podcast audio download timed out"));
        },
      });
    });
  }

  function looksLikePodcastAudio(url, contentType) {
    const normalizedUrl = String(url || "").toLowerCase();
    const normalizedType = String(contentType || "").toLowerCase();
    return (
      normalizedType.startsWith("audio/") ||
      /podcast|audio|voice|m4a|mp3|wav|aac/.test(normalizedUrl)
    );
  }

  function rememberPodcastAudio(url, contentType, buffer) {
    const byteLength = buffer?.byteLength || 0;
    if (!audioResponseReady(200, contentType, byteLength)) return;
    capturedPodcastAudios.push({
      url: String(url || ""),
      contentType: contentType || "application/octet-stream",
      buffer,
      byteLength,
      createdAt: Date.now(),
    });
    while (capturedPodcastAudios.length > 5) capturedPodcastAudios.shift();
  }

  function latestCapturedPodcastAudio() {
    return capturedPodcastAudios
      .filter((item) => item.byteLength >= MIN_AUDIO_BYTES)
      .sort((a, b) => a.createdAt - b.createdAt)
      .at(-1);
  }

  function cloneArrayBuffer(value) {
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    if (value && typeof value.byteLength === "number" && typeof value.slice === "function") {
      return value.slice(0);
    }
    return null;
  }

  function cloneFloat32Array(value) {
    if (!value || typeof value.length !== "number") return null;
    const tag = Object.prototype.toString.call(value);
    if (tag !== "[object Float32Array]") return null;
    return new Float32Array(value);
  }

  function readAscii(view, offset, length) {
    if (offset + length > view.byteLength) return "";
    let text = "";
    for (let i = 0; i < length; i += 1) text += String.fromCharCode(view.getUint8(offset + i));
    return text;
  }

  function looksLikeDecodableAudioBuffer(buffer) {
    if (!buffer || buffer.byteLength < 2048) return false;
    const view = new DataView(buffer);
    const head4 = readAscii(view, 0, 4);
    const head3 = readAscii(view, 0, 3);
    return (
      (head4 === "RIFF" && readAscii(view, 8, 4) === "WAVE") ||
      head3 === "ID3" ||
      head4 === "OggS" ||
      readAscii(view, 4, 4) === "ftyp"
    );
  }

  function resetReadAudioCapture() {
    readAudioCapture.active = true;
    readAudioCapture.chunks = [];
    readAudioCapture.pcmChunks = [];
    readAudioCapture.sampleRate = 24000;
    readAudioCapture.startedAt = Date.now();
    readAudioCapture.lastChunkAt = 0;
    readAudioCapture.encodedBytes = 0;
    readAudioCapture.pcmBytes = 0;
    readAudioCapture.error = "";
  }

  function stopReadAudioCapture() {
    readAudioCapture.active = false;
  }

  function rememberReadAudioChunk(buffer) {
    if (!readAudioCapture.active || !looksLikeDecodableAudioBuffer(buffer)) return;
    if (readAudioCapture.encodedBytes + buffer.byteLength > MAX_READ_CAPTURE_BYTES) {
      readAudioCapture.error = "Read-aloud encoded audio exceeded capture limit";
      readAudioCapture.active = false;
      return;
    }
    readAudioCapture.chunks.push(buffer);
    readAudioCapture.encodedBytes += buffer.byteLength;
    readAudioCapture.lastChunkAt = Date.now();
  }

  function rememberReadPcmChunk(data, sampleRate) {
    if (!readAudioCapture.active) return;
    const chunk = cloneFloat32Array(data);
    if (!chunk || !chunk.length) return;
    if (readAudioCapture.pcmBytes + chunk.byteLength > MAX_READ_CAPTURE_BYTES) {
      readAudioCapture.error = "Read-aloud PCM audio exceeded capture limit";
      readAudioCapture.active = false;
      return;
    }
    readAudioCapture.pcmChunks.push(chunk);
    readAudioCapture.pcmBytes += chunk.byteLength;
    if (Number.isFinite(sampleRate) && sampleRate > 0) readAudioCapture.sampleRate = sampleRate;
    readAudioCapture.lastChunkAt = Date.now();
  }

  function wrapAudioWorkletPort(node, audioContext) {
    const port = node?.port;
    if (!port || port.__mycliReadAudioPortWrapped || typeof port.postMessage !== "function") return;
    port.__mycliReadAudioPortWrapped = true;
    const nativePostMessage = port.postMessage;
    port.postMessage = function mycliAudioWorkletPostMessage(message) {
      try {
        if (message?.message === "dataIn") {
          rememberReadPcmChunk(message.data, audioContext?.sampleRate);
        }
      } catch {}
      return nativePostMessage.apply(this, arguments);
    };
  }

  function installReadAudioSniffer() {
    const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    for (const AudioContextCtor of [pageWindow.AudioContext, pageWindow.webkitAudioContext]) {
      const proto = AudioContextCtor?.prototype;
      if (!proto || proto.__mycliReadAudioSnifferInstalled || typeof proto.decodeAudioData !== "function") continue;
      proto.__mycliReadAudioSnifferInstalled = true;
      const nativeDecodeAudioData = proto.decodeAudioData;
      proto.decodeAudioData = function mycliDecodeAudioData(audioData, successCallback, errorCallback) {
        try {
          const copy = cloneArrayBuffer(audioData);
          if (copy) rememberReadAudioChunk(copy);
        } catch {}
        return nativeDecodeAudioData.apply(this, arguments);
      };
    }

    const NativeAudioWorkletNode = pageWindow.AudioWorkletNode;
    if (NativeAudioWorkletNode && !pageWindow.__mycliReadAudioWorkletSnifferInstalled) {
      pageWindow.__mycliReadAudioWorkletSnifferInstalled = true;
      const WrappedAudioWorkletNode = function MycliAudioWorkletNode(audioContext) {
        const node = Reflect.construct(NativeAudioWorkletNode, arguments, new.target || WrappedAudioWorkletNode);
        wrapAudioWorkletPort(node, audioContext);
        return node;
      };
      Object.setPrototypeOf(WrappedAudioWorkletNode, NativeAudioWorkletNode);
      WrappedAudioWorkletNode.prototype = NativeAudioWorkletNode.prototype;
      pageWindow.AudioWorkletNode = WrappedAudioWorkletNode;
    }
  }

  function installPodcastNetworkSniffer() {
    const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    if (!pageWindow || pageWindow.__doubaoEarPodcastSnifferInstalled) return;
    pageWindow.__doubaoEarPodcastSnifferInstalled = true;

    const nativeFetch = pageWindow.fetch;
    if (typeof nativeFetch === "function") {
      pageWindow.fetch = async function doubaoEarFetch(input, init) {
        const response = await nativeFetch.apply(this, arguments);
        try {
          const url = response.url || (typeof input === "string" ? input : input?.url) || "";
          const contentType = response.headers?.get?.("content-type") || "";
          if (looksLikePodcastAudio(url, contentType)) {
            response.clone().arrayBuffer().then((buffer) => {
              rememberPodcastAudio(url, contentType, buffer);
            }).catch(() => {});
          }
        } catch {}
        return response;
      };
    }

    const NativeXHR = pageWindow.XMLHttpRequest;
    if (typeof NativeXHR === "function") {
      pageWindow.XMLHttpRequest = function DoubaoEarXMLHttpRequest() {
        const xhr = new NativeXHR();
        xhr.addEventListener("loadend", () => {
          try {
            const url = xhr.responseURL || "";
            const contentType = xhr.getResponseHeader("content-type") || "";
            if (!looksLikePodcastAudio(url, contentType)) return;
            if (xhr.response instanceof ArrayBuffer) {
              rememberPodcastAudio(url, contentType, xhr.response);
            } else if (xhr.response instanceof Blob) {
              xhr.response.arrayBuffer().then((buffer) => rememberPodcastAudio(url, contentType, buffer));
            }
          } catch {}
        });
        return xhr;
      };
    }
  }

  async function pageFetchBlob(url) {
    const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    if (!pageWindow?.fetch) throw new Error("Page fetch is unavailable");
    const response = await pageWindow.fetch(url, { credentials: "include", cache: "no-store" });
    const contentType = response.headers?.get?.("content-type") || "application/octet-stream";
    const buffer = await response.arrayBuffer();
    if (!audioResponseReady(response.status, contentType, buffer.byteLength)) {
      throw new Error(`Page audio not ready (${response.status}, ${contentType}, ${buffer.byteLength} bytes)`);
    }
    return new Blob([buffer], { type: contentType });
  }

  function doubaoActionUrl() {
    const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const entries = pageWindow.performance?.getEntriesByType?.("resource") || [];
    const names = entries.map((entry) => entry.name).filter(Boolean).reverse();
    const candidate =
      names.find((name) => name.includes("/api/doubao/do_action_v2")) ||
      names.find((name) =>
        name.includes("www.doubao.com/") &&
        name.includes("version_code=") &&
        name.includes("web_tab_id="),
      );
    const url = new URL(candidate || "/api/doubao/do_action_v2", location.origin);
    url.pathname = "/api/doubao/do_action_v2";
    return url.href;
  }

  async function requestPodcastVideoUrl(episodeId) {
    const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    if (!pageWindow?.fetch) throw new Error("Page fetch is unavailable");
    const response = await pageWindow.fetch(doubaoActionUrl(), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scene: "FPA_Podcast",
        payload: JSON.stringify({
          api_name: "GetGenPodcastVideoUrl",
          params: JSON.stringify({ episode_id: String(episodeId) }),
        }),
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Podcast action HTTP ${response.status}`);
    }
    const data = JSON.parse(text || "{}");
    const resp = JSON.parse(data?.data?.resp || "{}");
    if (!resp.video_url) {
      throw new Error(`Podcast action did not return video_url (${data?.msg || data?.code || "empty"})`);
    }
    return resp.video_url;
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
      JSON.stringify({
        id: TAB_ID,
        expires_at: now + LOCK_TTL_MS,
      }),
    );
    return lockSnapshot()?.id === TAB_ID;
  }

  function releaseWorker() {
    const current = lockSnapshot();
    if (current?.id === TAB_ID) {
      localStorage.removeItem(LOCK_KEY);
    }
  }

  function visible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function findInput() {
    const selectors = [
      "textarea:not([disabled])",
      "[contenteditable='true']",
      "[role='textbox']",
    ];
    const candidates = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
    return candidates
      .filter(visible)
      .filter((element) => !element.closest("#doubao-ear-status"))
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
  }

  function centerDistance(element, targetRect) {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2 - (targetRect.left + targetRect.width / 2);
    const y = rect.top + rect.height / 2 - (targetRect.top + targetRect.height / 2);
    return Math.sqrt(x * x + y * y);
  }

  function shortVisibleText(element) {
    return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
  }

  function clickableElements() {
    return [...document.querySelectorAll("button, [role='button'], [role='menuitem'], label, li, div")]
      .filter(visible)
      .filter((element) => !element.closest("#doubao-ear-status"));
  }

  function findClickableByText(pattern) {
    return clickableElements()
      .map((element) => ({
        element,
        text: shortVisibleText(element),
        area: element.getBoundingClientRect().width * element.getBoundingClientRect().height,
      }))
      .filter((item) => item.text && item.text.length < 80 && pattern.test(item.text))
      .sort((a, b) => a.area - b.area)[0]?.element;
  }

  function findPlusButton(input) {
    const buttons = clickableElements().filter((element) => {
      const text = buttonText(element) || shortVisibleText(element);
      return /^(\+|添加|更多|上传)$/.test(text) || /添加|上传|更多/.test(text);
    });
    const inputRect = input.getBoundingClientRect();
    const nearInput = buttons
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        return Math.abs(rect.bottom - inputRect.bottom) < 140 && rect.right < inputRect.right;
      })
      .sort((a, b) => centerDistance(a, inputRect) - centerDistance(b, inputRect))[0];
    return nearInput || buttons[0];
  }

  async function waitForClickableText(pattern, timeoutMs = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const element = findClickableByText(pattern);
      if (element) return element;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  }

  function podcastModeSelected(input) {
    const inputRect = input.getBoundingClientRect();
    return clickableElements().some((element) => {
      const text = shortVisibleText(element);
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const className = String(element.className || "");
      return (
        /AI\s*播客/.test(text) &&
        (text.includes("网页链接") ||
          /exit-skill|skill-btn/i.test(className) ||
          style.color === "rgb(0, 102, 255)") &&
        Math.abs(rect.bottom - inputRect.bottom) < 140 &&
        rect.left > inputRect.left - 80
      );
    });
  }

  function findPodcastSkillButton(input) {
    const inputRect = input.getBoundingClientRect();
    return [...document.querySelectorAll("button, [role='button']")]
      .filter(isClickable)
      .filter((element) => shortVisibleText(element) === "AI 播客" || /AI\s*播客/.test(buttonText(element)))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return Math.abs(rect.bottom - inputRect.bottom) < 160 && rect.left > inputRect.left - 80;
      })
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
  }

  function setInputValue(input, text) {
    input.focus();
    if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
      const descriptor =
        Object.getOwnPropertyDescriptor(input.constructor.prototype, "value") ||
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
      descriptor.set.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    document.getSelection()?.selectAllChildren(input);
    document.execCommand("insertText", false, text);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  async function ensurePodcastMode(input) {
    if (podcastModeSelected(input)) {
      return;
    }

    const podcastButton = findPodcastSkillButton(input) || (await waitForClickableText(/AI\s*播客/, 5000));
    if (!podcastButton) {
      throw new Error("Could not find AI podcast button");
    }
    podcastButton.click();
    const started = Date.now();
    while (Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (podcastModeSelected(input)) return;
    }
    throw new Error("AI podcast mode did not become active");
  }

  async function openUploadMenu(input) {
    let uploadButton = findClickableByText(/上传文件/);
    if (uploadButton) return uploadButton;

    const plusButton = findPlusButton(input);
    if (!plusButton) {
      throw new Error("Could not find Doubao plus button");
    }
    plusButton.click();
    uploadButton = await waitForClickableText(/上传文件/, 5000);
    if (!uploadButton) {
      throw new Error("Could not find upload file button");
    }
    return uploadButton;
  }

  async function attachmentToFile(attachment) {
    setStatus(`downloading attachment\n${attachment.name}`);
    const buffer = await requestArrayBuffer(attachment.url);
    return new File([buffer], attachment.name, {
      type: attachment.mime || "application/octet-stream",
      lastModified: Date.now(),
    });
  }

  function setFilesOnInput(input, files) {
    const dataTransfer = new DataTransfer();
    files.forEach((file) => dataTransfer.items.add(file));
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function findUploadFileInput() {
    const inputs = [...document.querySelectorAll("input[type='file']")];
    return (
      inputs.find((item) => {
        const accept = String(item.getAttribute("accept") || "").toLowerCase();
        return item.multiple || /png|jpg|jpeg|webp|pdf|doc|xls|ppt|txt|md/.test(accept);
      }) ||
      inputs.at(-1) ||
      null
    );
  }

  function uploadRegion(input) {
    return input.closest("form") || input.parentElement || document.body;
  }

  async function waitForUploadSettled(input, timeoutMs = 60000) {
    const region = uploadRegion(input);
    let lastMutationAt = Date.now();
    const observer = new MutationObserver(() => {
      lastMutationAt = Date.now();
    });
    observer.observe(region, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });

    try {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const text = (region.innerText || document.body.innerText || "").replace(/\s+/g, " ");
        const busy = /上传中|正在上传|处理中|解析中/.test(text);
        if (!busy && Date.now() - lastMutationAt >= 1200) {
          return;
        }
      }
    } finally {
      observer.disconnect();
    }
    throw new Error("Timed out waiting for file upload");
  }

  async function uploadFiles(input, attachments, options = {}) {
    if (!attachments?.length) {
      throw new Error("Job is missing attachment");
    }

    if (options.podcastMode) {
      await ensurePodcastMode(input);
    }
    const files = [];
    for (const attachment of attachments) {
      files.push(await attachmentToFile(attachment));
    }

    let fileInput = findUploadFileInput();
    if (!fileInput) {
      const beforeInputs = new Set([...document.querySelectorAll("input[type='file']")]);
      await openUploadMenu(input);
      await new Promise((resolve) => setTimeout(resolve, 500));

      fileInput = [...document.querySelectorAll("input[type='file']")].find((item) => !beforeInputs.has(item)) || findUploadFileInput();
    }
    if (!fileInput) {
      throw new Error("Could not find file upload input");
    }

    setStatus(`uploading file\n${files.map((file) => file.name).join(", ")}`);
    setFilesOnInput(fileInput, files);
    await waitForUploadSettled(input);
  }

  function buttonText(button) {
    return [
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.textContent,
      button.getAttribute("data-testid"),
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  function isClickable(element) {
    const ariaDisabled = element.getAttribute("aria-disabled");
    return !element.disabled && ariaDisabled !== "true" && visible(element);
  }

  function findSendButton(input) {
    const buttons = [...document.querySelectorAll("button")].filter(isClickable);
    const explicit = buttons.find((button) => /发送|send/i.test(buttonText(button)) && !button.disabled);
    if (explicit) return explicit;

    const inputRect = input.getBoundingClientRect();
    return buttons
      .filter((button) => !button.disabled)
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        return Math.abs(rect.bottom - inputRect.bottom) < 120 && rect.left > inputRect.left;
      })
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
  }

  function pressEnter(input) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      input.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }

  function meaningfulText(text, prompt) {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (trimmed.length < 2) return "";
    if (trimmed === prompt.replace(/\s+/g, " ").trim()) return "";
    if (/^(发送|重新生成|停止生成|复制|点赞|点踩|分享)$/.test(trimmed)) return "";
    if (trimmed.includes("Doubao Ear")) return "";
    return text.trim();
  }

  function collectAnswerCandidates(prompt) {
    const selectors = [
      "[class*='md-box-root' i]",
      "[class*='markdown' i]",
    ];
    const seen = new Set();
    const elements = selectors
      .flatMap((selector) => [...document.querySelectorAll(selector)])
      .filter((element) => {
        if (seen.has(element)) return false;
        seen.add(element);
        return visible(element);
      });

    // Doubao nests markdown blocks inside a md-box-root container. Both
    // selectors match, so we'd return the inner-most paragraph as the
    // "latest" candidate by bottom — which truncates the answer to just
    // the last block. Keep only the outermost container so innerText
    // covers the whole message.
    const outermost = elements.filter((element) =>
      !elements.some((other) => other !== element && other.contains(element)),
    );

    return outermost
      .map((element) => ({
        element,
        text: meaningfulText(element.innerText || element.textContent || "", prompt),
        bottom: element.getBoundingClientRect().bottom,
        height: element.getBoundingClientRect().height,
      }))
      .filter((item) => item.text)
      .filter((item) => item.height > 0)
      .sort((a, b) => a.bottom - b.bottom);
  }

  function latestAnswerCandidate(prompt) {
    const candidates = collectAnswerCandidates(prompt);
    const withoutPromptEcho = candidates.filter((item) => !item.text.includes(prompt));
    const pool = withoutPromptEcho.length ? withoutPromptEcho : candidates;
    return pool.at(-1) || null;
  }

  function answerSnapshot(prompt) {
    const candidates = collectAnswerCandidates(prompt);
    const byElement = new Map();
    const textCounts = new Map();
    for (const item of candidates) {
      byElement.set(item.element, item.text);
      textCounts.set(item.text, (textCounts.get(item.text) || 0) + 1);
    }
    return { byElement, textCounts };
  }

  function candidatesAfterSnapshot(candidates, snapshot) {
    const remainingTextCounts = new Map(snapshot.textCounts);
    return candidates.filter((item) => {
      const previousText = snapshot.byElement.get(item.element);
      if (previousText !== undefined) {
        if (item.text !== previousText) return true;
        remainingTextCounts.set(item.text, Math.max(0, (remainingTextCounts.get(item.text) || 0) - 1));
        return false;
      }

      const remaining = remainingTextCounts.get(item.text) || 0;
      if (remaining > 0) {
        remainingTextCounts.set(item.text, remaining - 1);
        return false;
      }
      return true;
    });
  }

  function isGenerating() {
    return [...document.querySelectorAll("button, [role='button']")]
      .filter(visible)
      .some((element) => /停止生成|stop generating|stop/i.test(buttonText(element)));
  }

  function collectPodcastDownloadButtons() {
    const textButtons = [...document.querySelectorAll("button, [role='button'], a")]
      .filter(isClickable)
      .map((element) => ({
        element,
        text: (buttonText(element) || shortVisibleText(element)).replace(/\s+/g, " ").trim(),
        bottom: element.getBoundingClientRect().bottom,
      }))
      .filter((item) => /下载.*(\.m4a|音频|播客)?|download/i.test(item.text));

    function enabledPodcastDownload(element) {
      const card = element.closest("[data-plugin-identifier='Symbol(receive-podcast-content)']");
      const control = element.closest("[class*='actionBtn' i]") || element;
      const classNames = `${card?.className || ""} ${control.className || ""} ${element.className || ""}`;
      const cardText = (card?.innerText || card?.textContent || "").replace(/\s+/g, " ").trim();
      const style = window.getComputedStyle(control);
      const hasDuration = /\d{1,2}:\d{2}\s*｜\s*\d{1,2}:\d{2}/.test(cardText);
      return (
        card &&
        hasDuration &&
        !/--:--/.test(cardText) &&
        !/disabled/i.test(classNames) &&
        style.cursor !== "not-allowed" &&
        isClickable(control)
      );
    }

    const iconButtons = [...document.querySelectorAll("[data-plugin-identifier='Symbol(receive-podcast-content)'] [class*='downloadBtn' i]")]
      .map((icon) => {
        const element =
          icon.closest("[class*='actionBtn' i]") ||
          icon.closest("button, [role='button'], a") ||
          icon;
        return {
          element,
          text: "podcast download icon",
          bottom: element.getBoundingClientRect().bottom,
        };
      })
      .filter((item) => enabledPodcastDownload(item.element));

    return [...textButtons, ...iconButtons]
      .filter((item, index, items) => items.findIndex((other) => other.element === item.element) === index)
      .sort((a, b) => a.bottom - b.bottom);
  }

  function parseJsonMaybe(value) {
    if (!value || typeof value !== "string") return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function extractPodcastAudio() {
    const pageDocument = typeof unsafeWindow !== "undefined" ? unsafeWindow.document : document;
    const cards = [...pageDocument.querySelectorAll("[data-plugin-identifier='Symbol(receive-podcast-content)']")];
    for (const card of cards.reverse()) {
      const propsKey = Object.keys(card).find((key) => key.startsWith("__reactProps"));
      const message = propsKey ? card[propsKey]?.children?.[0]?.props?.message : null;
      const content = parseJsonMaybe(message?.content);
      const widgetData = parseJsonMaybe(content?.widget_data);
      const data = parseJsonMaybe(widgetData?.data);
      const episode = data?.episodeList?.episodes?.[0];
      const audioLink = episode?.meta?.playback_model?.audio_link;
      if (audioLink) {
        return {
          audioLink,
          title: episode?.meta?.title || episode?.meta?.podcast_title || "doubao-podcast",
          id: episode?.id || "",
        };
      }
    }
    return null;
  }

  function extensionFromBlob(blob) {
    const map = {
      "audio/wav": "wav",
      "audio/x-wav": "wav",
      "audio/wave": "wav",
      "audio/mpeg": "mp3",
      "audio/mp3": "mp3",
      "audio/mp4": "m4a",
      "audio/aac": "aac",
      "audio/ogg": "ogg",
      "audio/webm": "webm",
    };
    return map[(blob.type || "").toLowerCase()] || "";
  }

  function extensionFromContentType(contentType) {
    const map = {
      "audio/wav": "wav",
      "audio/x-wav": "wav",
      "audio/wave": "wav",
      "audio/mpeg": "mp3",
      "audio/mp3": "mp3",
      "audio/mp4": "m4a",
      "audio/aac": "aac",
      "audio/ogg": "ogg",
      "audio/webm": "webm",
    };
    return map[String(contentType || "").toLowerCase()] || "";
  }

  function parseWav(buffer) {
    const view = new DataView(buffer);
    if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") return null;

    let offset = 12;
    let fmt = null;
    let data = null;
    while (offset + 8 <= view.byteLength) {
      const id = readAscii(view, offset, 4);
      const size = view.getUint32(offset + 4, true);
      const start = offset + 8;
      const end = Math.min(start + size, view.byteLength);
      if (id === "fmt ") fmt = new Uint8Array(buffer.slice(start, end));
      if (id === "data") data = new Uint8Array(buffer.slice(start, end));
      offset = start + size + (size % 2);
    }

    return fmt && data ? { fmt, data } : null;
  }

  function writeAscii(target, offset, text) {
    for (let i = 0; i < text.length; i += 1) target[offset + i] = text.charCodeAt(i);
  }

  function equalBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function wavBlobFromFloat32Chunks(chunks, sampleRate) {
    const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (!totalSamples) throw new Error("No read-aloud PCM audio was captured");
    const dataLength = totalSamples * 2;
    const totalLength = 44 + dataLength;
    const bytes = new Uint8Array(totalLength);
    const view = new DataView(bytes.buffer);
    let offset = 0;
    writeAscii(bytes, offset, "RIFF"); offset += 4;
    view.setUint32(offset, totalLength - 8, true); offset += 4;
    writeAscii(bytes, offset, "WAVE"); offset += 4;
    writeAscii(bytes, offset, "fmt "); offset += 4;
    view.setUint32(offset, 16, true); offset += 4;
    view.setUint16(offset, 1, true); offset += 2;
    view.setUint16(offset, 1, true); offset += 2;
    view.setUint32(offset, sampleRate, true); offset += 4;
    view.setUint32(offset, sampleRate * 2, true); offset += 4;
    view.setUint16(offset, 2, true); offset += 2;
    view.setUint16(offset, 16, true); offset += 2;
    writeAscii(bytes, offset, "data"); offset += 4;
    view.setUint32(offset, dataLength, true); offset += 4;
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, chunk[i]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }
    return new Blob([bytes], { type: "audio/wav" });
  }

  function blobFromReadAudioChunks() {
    const chunks = readAudioCapture.chunks.slice();
    const pcmChunks = readAudioCapture.pcmChunks.slice();
    if (!chunks.length && !pcmChunks.length) throw new Error("No read-aloud audio was captured");

    if (!chunks.length && pcmChunks.length) {
      return wavBlobFromFloat32Chunks(pcmChunks, readAudioCapture.sampleRate || 24000);
    }

    const parsed = chunks.map(parseWav);
    if (parsed.every(Boolean) && parsed.every((item) => equalBytes(item.fmt, parsed[0].fmt))) {
      const fmt = parsed[0].fmt;
      const dataLength = parsed.reduce((sum, item) => sum + item.data.length, 0);
      const totalLength = 12 + 8 + fmt.length + 8 + dataLength;
      const bytes = new Uint8Array(totalLength);
      const view = new DataView(bytes.buffer);
      let offset = 0;
      writeAscii(bytes, offset, "RIFF"); offset += 4;
      view.setUint32(offset, totalLength - 8, true); offset += 4;
      writeAscii(bytes, offset, "WAVE"); offset += 4;
      writeAscii(bytes, offset, "fmt "); offset += 4;
      view.setUint32(offset, fmt.length, true); offset += 4;
      bytes.set(fmt, offset); offset += fmt.length;
      writeAscii(bytes, offset, "data"); offset += 4;
      view.setUint32(offset, dataLength, true); offset += 4;
      for (const item of parsed) {
        bytes.set(item.data, offset);
        offset += item.data.length;
      }
      return new Blob([bytes], { type: "audio/wav" });
    }

    return new Blob(chunks, { type: "audio/wav" });
  }

  function safeFilename(name) {
    return String(name || "doubao-podcast")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "doubao-podcast";
  }

  function filenameFromSignedUrl(url) {
    try {
      const attname = new URL(url).searchParams.get("attname");
      return attname ? decodeURIComponent(attname) : "";
    } catch {
      return "";
    }
  }

  function uploadBlobPart(cmdId, filename, blob, part, parts) {
    return new Promise((resolve, reject) => {
      const query = [
        `cmd_id=${encodeURIComponent(cmdId)}`,
        `filename=${encodeURIComponent(filename)}`,
        `part=${part}`,
        `parts=${parts}`,
      ].join("&");
      GM_xmlhttpRequest({
        method: "POST",
        url: `${HTTP_API}/upload?${query}`,
        headers: { "content-type": blob.type || "application/octet-stream" },
        data: blob,
        timeout: 10 * 60 * 1000,
        onload(response) {
          try {
            const json = JSON.parse(response.responseText || "{}");
            if (response.status >= 400) {
              reject(new Error(json.error || `HTTP ${response.status}`));
              return;
            }
            resolve(json);
          } catch (error) {
            reject(error);
          }
        },
        onerror() {
          reject(new Error(`Cannot upload audio part ${part + 1}/${parts} to local service`));
        },
        ontimeout() {
          reject(new Error(`Local upload part ${part + 1}/${parts} timed out`));
        },
      });
    });
  }

  async function uploadToLocalService(cmdId, filename, blob) {
    const parts = Math.max(1, Math.ceil(blob.size / UPLOAD_CHUNK_BYTES));
    let result = null;
    for (let part = 0; part < parts; part += 1) {
      const start = part * UPLOAD_CHUNK_BYTES;
      const chunk = blob.slice(start, Math.min(blob.size, start + UPLOAD_CHUNK_BYTES), blob.type);
      setStatus(`uploading audio\n${part + 1}/${parts}\n${filename}`);
      result = await uploadBlobPart(cmdId, filename, chunk, part, parts);
    }
    return result;
  }

  async function downloadPodcastAudio(audio, jobId) {
    let url = new URL(audio.audioLink, location.origin).href;
    setStatus(`fetching podcast audio\n${audio.title || audio.id}`);
    let blob = null;
    let signedName = "";
    try {
      if (audio.id) {
        url = await requestPodcastVideoUrl(audio.id);
        signedName = filenameFromSignedUrl(url);
      }
      try {
        blob = await pageFetchBlob(url);
      } catch {
        blob = await requestBlob(url);
      }
    } catch {
      const captured = latestCapturedPodcastAudio();
      if (captured) {
        blob = new Blob([captured.buffer], { type: captured.contentType });
      } else {
        try {
          blob = await pageFetchBlob(url);
        } catch {
          blob = await requestBlob(url);
        }
      }
    }
    const extension = extensionFromBlob(blob) || "wav";
    const filename = signedName || `${safeFilename(audio.title)}.${extension}`;
    setStatus(`saving podcast\n${filename}`);
    const result = await uploadToLocalService(jobId, filename, blob);
    return { url, size: blob.size, savedPath: result.path };
  }

  async function saveCapturedPodcastAudio(jobId) {
    const captured = latestCapturedPodcastAudio();
    if (!captured) return null;
    const blob = new Blob([captured.buffer], { type: captured.contentType });
    const extension = extensionFromContentType(captured.contentType) || "m4a";
    const filename = `doubao-podcast-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
    setStatus(`saving captured podcast\n${filename}`);
    const result = await uploadToLocalService(jobId, filename, blob);
    return { size: blob.size, savedPath: result.path };
  }

  async function waitForPodcastDownloadButton(baselineCount, jobId) {
    const currentJobId = jobId;
    const started = Date.now();
    let lastDebugAt = 0;
    let lastAudioError = "";

    while (Date.now() - started < PODCAST_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      becomeWorker();

      const audio = extractPodcastAudio();
      if (audio?.audioLink) {
        try {
          const download = await downloadPodcastAudio(audio, currentJobId);
          setStatus(`podcast saved\n${download.savedPath}`);
          await new Promise((resolve) => setTimeout(resolve, 500));
          return `Podcast saved: ${download.savedPath} (${download.size} bytes)`;
        } catch (error) {
          lastAudioError = error.message || String(error);
          if (Date.now() - lastDebugAt > 3000) {
            lastDebugAt = Date.now();
            const buttonCount = collectPodcastDownloadButtons().length;
            setStatus(`waiting podcast audio\n${lastAudioError.slice(0, 70)}\nbuttons=${buttonCount}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
        }
      }

      try {
        const captured = await saveCapturedPodcastAudio(currentJobId);
        if (captured) {
          setStatus(`podcast saved\n${captured.savedPath}`);
          return `Podcast saved: ${captured.savedPath} (${captured.size} bytes)`;
        }
      } catch (error) {
        lastAudioError = error.message || String(error);
      }

      const buttons = collectPodcastDownloadButtons();
      const button = buttons.length > baselineCount ? buttons.at(-1) : null;
      if (button?.element) {
        setStatus(`podcast ready\n${button.text}`);
        button.element.click();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return `Podcast download button clicked: ${button.text}`;
      }

      if (Date.now() - lastDebugAt > 5000) {
        lastDebugAt = Date.now();
        setStatus(`waiting podcast download\nbuttons=${buttons.length} baseline=${baselineCount}`);
      }
    }

    throw new Error(lastAudioError ? `Timed out waiting for podcast audio: ${lastAudioError}` : "Timed out waiting for podcast download button");
  }

  function collectReadAloudButtons() {
    return clickableElements()
      .map((element) => ({
        element,
        text: (buttonText(element) || shortVisibleText(element)).replace(/\s+/g, " ").trim(),
        rect: element.getBoundingClientRect(),
      }))
      .filter((item) => /朗读|read aloud/i.test(item.text))
      .filter((item) => !/自动播报|auto|暂停|停止|pause|stop/i.test(item.text));
  }

  function readAloudIsPlaying() {
    return clickableElements().some((element) => {
      const text = (buttonText(element) || shortVisibleText(element)).replace(/\s+/g, " ").trim();
      return /暂停朗读|停止朗读|pause|stop/i.test(text);
    });
  }

  function findReadAloudButton(answerItem) {
    const buttons = collectReadAloudButtons();
    if (!buttons.length) return null;
    const answerRect = answerItem?.element?.getBoundingClientRect?.();
    if (!answerRect) return buttons.sort((a, b) => a.rect.bottom - b.rect.bottom).at(-1)?.element || null;

    return buttons
      .map((item) => {
        const belowPenalty = item.rect.top < answerRect.bottom - 80 ? 5000 : 0;
        const vertical = Math.abs(item.rect.top - answerRect.bottom);
        const horizontal = Math.abs(item.rect.left - answerRect.left);
        return { ...item, score: belowPenalty + vertical + horizontal / 20 };
      })
      .sort((a, b) => a.score - b.score)[0]?.element || null;
  }

  async function saveReadAudio(jobId) {
    const blob = blobFromReadAudioChunks();
    const extension = extensionFromBlob(blob) || "wav";
    const filename = `doubao-read-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
    setStatus(`saving read audio\n${filename}`);
    const result = await uploadToLocalService(jobId, filename, blob);
    return { size: blob.size, savedPath: result.path };
  }

  async function clickReadAloudAndSave(prompt, jobId, timeoutMs) {
    installReadAudioSniffer();
    const answerItem = latestAnswerCandidate(prompt);
    const button = findReadAloudButton(answerItem);
    if (!button) throw new Error("Could not find read-aloud button");

    resetReadAudioCapture();
    setStatus("starting read-aloud");
    button.click();

    const started = Date.now();
    const totalTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : PODCAST_TIMEOUT_MS;
    let lastChunkCount = 0;
    let sawPlaying = false;
    let lastDebugAt = 0;

    try {
      while (Date.now() - started < totalTimeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        becomeWorker();
        if (readAudioCapture.error) throw new Error(readAudioCapture.error);

        const chunkCount = readAudioCapture.chunks.length + readAudioCapture.pcmChunks.length;
        if (chunkCount !== lastChunkCount) {
          lastChunkCount = chunkCount;
          setStatus(`capturing read audio\nchunks=${chunkCount}`);
        }

        const playing = readAloudIsPlaying();
        if (playing) sawPlaying = true;
        const quietFor = readAudioCapture.lastChunkAt ? Date.now() - readAudioCapture.lastChunkAt : 0;

        if (chunkCount && sawPlaying && !playing && quietFor > 1000) {
          const saved = await saveReadAudio(jobId);
          return `Read audio saved: ${saved.savedPath} (${saved.size} bytes)`;
        }

        if (chunkCount && quietFor > READ_AUDIO_FALLBACK_QUIET_MS) {
          const saved = await saveReadAudio(jobId);
          return `Read audio saved: ${saved.savedPath} (${saved.size} bytes)`;
        }

        if (chunkCount && quietFor > READ_AUDIO_QUIET_MS && !playing) {
          const saved = await saveReadAudio(jobId);
          return `Read audio saved: ${saved.savedPath} (${saved.size} bytes)`;
        }

        if (Date.now() - lastDebugAt > 3000) {
          lastDebugAt = Date.now();
          setStatus(`waiting read audio\nchunks=${chunkCount} playing=${playing ? "yes" : "no"} quiet=${(quietFor / 1000).toFixed(1)}s`);
        }
      }
    } finally {
      stopReadAudioCapture();
    }

    throw new Error(`Timed out waiting for read-aloud audio (chunks=${readAudioCapture.chunks.length + readAudioCapture.pcmChunks.length})`);
  }

  async function waitForAnswer(prompt, baselineSnapshot, timeoutMs) {
    const started = Date.now();
    const totalTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : ANSWER_TIMEOUT_MS;
    let best = "";
    let stableSince = 0;
    // doneSince = the moment isGenerating() most recently transitioned to
    // false. Reset to 0 whenever the stop button reappears or text grows
    // (text growing means the renderer is still flushing, regardless of
    // what the button says).
    let doneSince = 0;
    let lastDebugAt = 0;

    while (Date.now() - started < totalTimeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      becomeWorker();
      const candidates = collectAnswerCandidates(prompt);
      const current = candidatesAfterSnapshot(candidates, baselineSnapshot).at(-1)?.text || "";
      if (current && current !== best) {
        best = current;
        stableSince = Date.now();
        // Text just grew → renderer is still working, don't trust any
        // earlier "done" observation.
        doneSince = 0;
        setStatus(`receiving answer\n${best.slice(0, 80)}`);
        continue;
      }

      const generating = isGenerating();
      if (generating) {
        doneSince = 0;
      } else if (!doneSince) {
        doneSince = Date.now();
      }

      const stableFor = stableSince ? Date.now() - stableSince : 0;
      const doneFor = doneSince ? Date.now() - doneSince : 0;
      // Return only when BOTH:
      //   - we have an answer that hasn't changed for STABLE_MS, AND
      //   - the stop button has been gone for at least POST_DONE_QUIET_MS.
      // The post-done quiet period lets Doubao's debounced markdown
      // renderer drain its queue after the network stream ends.
      if (best && stableFor > STABLE_MS && doneFor > POST_DONE_QUIET_MS) {
        return best;
      }

      if (Date.now() - lastDebugAt > 3000) {
        lastDebugAt = Date.now();
        setStatus(
          `waiting answer\nlen=${best.length} stable=${(stableFor / 1000).toFixed(1)}s done=${(doneFor / 1000).toFixed(1)}s\nlatest=${(current || "").slice(0, 60)}`,
        );
      }
    }

    if (best) return best;
    throw new Error("Timed out waiting for Doubao answer");
  }

  async function runCommand(cmd) {
    // cmd = { id, action, args: { prompt, wait_ms, output_dir?, audio_wait_ms?, attachments?: [{id,name,mime,size,url}] } }
    setStatus(`running ${cmd.action}\n${cmd.id.slice(0, 8)}`);
    const args = cmd.args || {};
    const prompt = String(args.prompt || "");
    if (!prompt) throw new Error("Missing prompt");

    let input = findInput();
    if (!input) throw new Error("Could not find Doubao input box");

    const isPodcast = cmd.action === "podcast";
    const isRead = cmd.action === "read";
    const attachments = (args.attachments || []).map((att) => ({
      url: att.url,
      name: att.name,
      mime: att.mime,
    }));
    const podcastDownloadBaseline = collectPodcastDownloadButtons().length;
    if (attachments.length) {
      await uploadFiles(input, attachments, { podcastMode: isPodcast });
      input = findInput();
      if (!input) throw new Error("Could not find Doubao input box after upload");
    }

    const baselineSnapshot = answerSnapshot(prompt);

    setInputValue(input, prompt);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const sendButton = findSendButton(input);
    if (sendButton) sendButton.click();
    else pressEnter(input);

    const waitMs = Number(args.wait_ms) || 0;
    const answer = isPodcast
      ? await waitForPodcastDownloadButton(podcastDownloadBaseline, cmd.id)
      : await waitForAnswer(prompt, baselineSnapshot, waitMs);

    if (isRead) {
      const audioWaitMs = Number(args.audio_wait_ms) || PODCAST_TIMEOUT_MS;
      const message = await clickReadAloudAndSave(prompt, cmd.id, audioWaitMs);
      setStatus(`done\n${cmd.id.slice(0, 8)}\n${message}`);
      return message;
    }

    setStatus(`done\n${cmd.id.slice(0, 8)}\nlen=${typeof answer === "string" ? answer.length : "?"}`);
    return answer;
  }

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
      const message = error && error.message ? error.message : String(error);
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
      // Re-check periodically in case the worker tab dies.
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
      } else if (msg.type === "hello_ack") {
        // noop
      }
    });

    ws.addEventListener("close", () => {
      ws = null;
      if (!busy) setStatus("disconnected");
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // close event will follow; just surface a hint.
      setStatus("ws error");
    });
  }

  // Keep the worker lock fresh as long as this tab is the worker.
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) becomeWorker();
  }, Math.max(1000, Math.floor(LOCK_TTL_MS / 2)));

  setStatus("starting");
  installReadAudioSniffer();
  installPodcastNetworkSniffer();
  window.addEventListener("beforeunload", () => {
    releaseWorker();
    try { ws && ws.close(); } catch {}
  });
  connect();
})();
