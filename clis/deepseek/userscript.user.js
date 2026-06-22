// ==UserScript==
// @name         mycli DeepSeek Bridge
// @namespace    local.mycli.deepseek
// @version      0.1.3
// @description  WebSocket bridge to the mycli micro-daemon. Drives the logged-in DeepSeek web UI.
// @match        https://chat.deepseek.com/*
// @downloadURL  http://127.0.0.1:17872/userscript/deepseek/mycli.user.js
// @updateURL    http://127.0.0.1:17872/userscript/deepseek/mycli.user.js
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const HTTP_API = "http://127.0.0.1:17872";
  const WS_URL = "ws://127.0.0.1:17872/ws";
  const SITE = "deepseek";
  const VERSION = "0.1.3";
  const TAB_ID = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const LOCK_KEY = "mycli-deepseek-worker-lock";
  const LOCK_TTL_MS = 5000;
  const RECONNECT_MIN_MS = 1000;
  const RECONNECT_MAX_MS = 15000;
  const DEFAULT_WAIT_MS = 300000;
  const ANSWER_STABLE_MS = 2500;
  const DONE_QUIET_MS = 1500;
  const MODE_MODEL_TYPES = {
    instant: "default",
    expert: "expert",
    vision: "vision",
  };

  let busy = false;
  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  let lastStatus = "";

  const STATUS_ID = "mycli-deepseek-status";
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
  let statusCollapsed = false;
  let statusCollapseTimer = null;
  let statusBox = null;

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

  function collapseStatus() {
    statusCollapsed = true;
    applyStatusTransform();
  }

  function expandStatus() {
    statusCollapsed = false;
    applyStatusTransform();
    clearTimeout(statusCollapseTimer);
    statusCollapseTimer = setTimeout(collapseStatus, STATUS_COLLAPSE_MS);
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

    let pointerId = null;
    let startX = 0;
    let dragX = 0;
    const endDrag = (event) => {
      if (pointerId !== event.pointerId) return;
      pointerId = null;
      box.style.transition = "transform .25s ease, opacity .25s ease";
      if (dragX > 4) suppressClick = true;
      if (dragX >= STATUS_SWIPE_PX) collapseStatus();
      else applyStatusTransform();
      dragX = 0;
    };
    box.addEventListener("pointerdown", (event) => {
      if (statusCollapsed || event.button !== 0) return;
      pointerId = event.pointerId;
      startX = event.clientX;
    });
    box.addEventListener("pointermove", (event) => {
      if (pointerId !== event.pointerId) return;
      dragX = event.clientX - startX;
      if (dragX > 4) {
        try { box.setPointerCapture(event.pointerId); } catch {}
        box.style.transition = "none";
        box.style.transform = `translateX(${dragX}px)`;
      }
    });
    box.addEventListener("pointerup", endDrag);
    box.addEventListener("pointercancel", endDrag);
  }

  function ensureStatusBox() {
    if (statusBox) return statusBox;
    let box = document.getElementById(STATUS_ID);
    if (!box) {
      box = document.createElement("div");
      box.id = STATUS_ID;
      box.style.cssText = STATUS_BOX_CSS;
      attachStatusGestures(box);
      (document.body || document.documentElement).appendChild(box);
    }
    statusBox = box;
    return box;
  }

  function setStatus(text) {
    lastStatus = text;
    const box = ensureStatusBox();
    box.textContent = `mycli/${SITE} ${VERSION}\n${text}`;
    expandStatus();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(fn, { timeoutMs = 10000, intervalMs = 100, label = "condition" } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = fn();
      if (value) return value;
      await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for ${label}`);
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
    if (current && current.id !== TAB_ID && current.expires_at > now) return false;
    localStorage.setItem(LOCK_KEY, JSON.stringify({ id: TAB_ID, expires_at: now + LOCK_TTL_MS }));
    return lockSnapshot()?.id === TAB_ID;
  }

  function releaseWorker() {
    if (lockSnapshot()?.id === TAB_ID) localStorage.removeItem(LOCK_KEY);
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

  function normalizedText(element) {
    return (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function findInput() {
    return [...document.querySelectorAll('textarea[placeholder="Message DeepSeek"], textarea')]
      .filter(visible)
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0] || null;
  }

  function findNewChatButton() {
    return [...document.querySelectorAll("div")]
      .filter(visible)
      .filter((element) => normalizedText(element) === "New chat")
      .filter((element) => !element.closest("a"))
      .filter((element) => window.getComputedStyle(element).cursor === "pointer")
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { element, area: rect.width * rect.height, top: rect.top };
      })
      .filter((item) => item.top >= 0 && item.top < 240)
      .sort((a, b) => b.area - a.area)[0]?.element || null;
  }

  function modeModelType(mode) {
    const modelType = MODE_MODEL_TYPES[mode];
    if (!modelType) throw new Error(`Invalid DeepSeek mode: ${mode}`);
    return modelType;
  }

  function modeControl(mode) {
    const modelType = modeModelType(mode);
    return document.querySelector(`[role="radio"][data-model-type="${modelType}"]`);
  }

  async function startNewChat() {
    const button = findNewChatButton();
    if (!button) throw new Error("Could not find DeepSeek New chat button");
    button.click();
    await waitFor(
      () => findInput() && document.querySelectorAll('[role="radio"][data-model-type]').length >= 3,
      { timeoutMs: 10000, label: "DeepSeek new chat" },
    );
  }

  async function selectMode(mode) {
    const control = await waitFor(() => modeControl(mode), {
      timeoutMs: 5000,
      label: `${mode} mode`,
    });
    if (control.getAttribute("aria-checked") !== "true") {
      control.click();
      await waitFor(
        () => modeControl(mode)?.getAttribute("aria-checked") === "true",
        { timeoutMs: 5000, label: `${mode} mode selection` },
      );
    }
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
            reject(new Error(`Attachment download failed: HTTP ${response.status}`));
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

  async function attachmentToFile(attachment) {
    setStatus(`downloading attachment\n${attachment.name}`);
    const buffer = await requestArrayBuffer(attachment.url);
    return new File([buffer], attachment.name, {
      type: attachment.mime || "application/octet-stream",
      lastModified: Date.now(),
    });
  }

  function setFilesOnInput(input, files) {
    const transfer = new DataTransfer();
    files.forEach((file) => transfer.items.add(file));
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function uploadInput() {
    return [...document.querySelectorAll('input[type="file"]')]
      .find((input) => input.multiple || /png|jpg|jpeg|webp|pdf|doc|txt|md/i.test(input.accept)) || null;
  }

  function pageTextWithoutStatus() {
    const fullText = normalizedText(document.body);
    const statusText = normalizedText(statusBox);
    return statusText ? fullText.replace(statusText, "") : fullText;
  }

  function pageHasUploadError() {
    const text = pageTextWithoutStatus();
    return /upload failed|failed to upload|文件上传失败|上传失败|不支持.*文件/i.test(text);
  }

  function attachmentCardVisible(name) {
    return [...document.querySelectorAll("button, [role='button'], img")]
      .filter(visible)
      .some((element) => {
        const label = [
          element.getAttribute("aria-label"),
          element.getAttribute("alt"),
          element.getAttribute("title"),
          normalizedText(element),
        ]
          .filter(Boolean)
          .join(" ");
        return label.includes(name);
      });
  }

  async function uploadAttachments(attachments) {
    if (!attachments.length) return;
    const input = uploadInput();
    if (!input) throw new Error("DeepSeek file upload is unavailable in the selected mode");

    const files = [];
    for (const attachment of attachments) {
      files.push(await attachmentToFile(attachment));
    }
    setStatus(`uploading\n${files.map((file) => file.name).join(", ")}`);
    setFilesOnInput(input, files);

    const expectedNames = files.map((file) => file.name);
    await waitFor(() => {
      if (pageHasUploadError()) throw new Error("DeepSeek rejected an attachment");
      return expectedNames.every(attachmentCardVisible);
    }, { timeoutMs: 90000, intervalMs: 250, label: "DeepSeek attachment cards" });
    await sleep(750);
  }

  function setInputValue(input, text) {
    input.focus();
    const descriptor =
      Object.getOwnPropertyDescriptor(input.constructor.prototype, "value") ||
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    descriptor.set.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function composerRoot(input) {
    let current = input;
    for (let i = 0; current && i < 8; i += 1, current = current.parentElement) {
      if (
        current.querySelector?.('input[type="file"]') &&
        current.querySelectorAll?.('[role="button"].ds-button').length >= 1
      ) {
        return current;
      }
    }
    return input.parentElement?.parentElement?.parentElement || document.body;
  }

  function sendButton(input) {
    const root = composerRoot(input);
    const candidates = [...root.querySelectorAll('[role="button"].ds-button--primary, [role="button"].ds-button--circle')]
      .filter(visible)
      .filter((element) => !String(element.className).includes("ds-button--disabled"));
    return candidates
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0] || null;
  }

  function answerElements() {
    return [...document.querySelectorAll(".ds-assistant-message-main-content")].filter(visible);
  }

  function answerSnapshot() {
    return new Set(answerElements());
  }

  function readableNodeText(node) {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const element = node;
    if (
      element.matches(
        [
          ".md-code-block-banner-wrap",
          ".ds-think-content",
          "svg",
          '[role="button"]',
          "button",
        ].join(","),
      )
    ) {
      return "";
    }
    if (element.tagName === "BR") return "\n";
    if (element.tagName === "PRE") return `${element.innerText || element.textContent || ""}\n`;

    const text = [...element.childNodes].map(readableNodeText).join("");
    if (/^(DIV|P|LI|UL|OL|H[1-6]|TABLE|TR|BLOCKQUOTE)$/.test(element.tagName)) {
      return `${text}\n`;
    }
    return text;
  }

  function cleanAnswerText(element) {
    if (!element) return "";
    return readableNodeText(element)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function answerIsDone(element) {
    const message = element?.closest(".ds-message");
    if (!message) return false;
    if (
      [...message.children].some((child) =>
        /AI-generated,\s*for reference only\.?/i.test(normalizedText(child)),
      )
    ) {
      return true;
    }

    // DeepSeek currently renders the completed-message action row as a
    // sibling of `.ds-message`, not inside it. The row appears only after
    // generation has finished and contains copy/regenerate/feedback/share.
    const wrapper = message.parentElement;
    return [...(wrapper?.children || [])].some(
      (child) =>
        child !== message &&
        child.querySelectorAll?.('[role="button"].ds-button').length >= 3,
    );
  }

  function challengeMessage() {
    const text = normalizedText(document.body);
    if (/captcha|verify you are human|security verification|验证码|安全验证|人机验证/i.test(text)) {
      return "DeepSeek requires browser verification. Complete it in the page and retry";
    }
    return "";
  }

  async function waitForFinalAnswer(baseline, timeoutMs) {
    const started = Date.now();
    let best = "";
    let stableSince = 0;
    let doneSince = 0;
    let lastDebugAt = 0;

    while (Date.now() - started < timeoutMs) {
      await sleep(400);
      becomeWorker();

      const challenge = challengeMessage();
      if (challenge) throw new Error(challenge);

      const candidates = answerElements().filter((element) => !baseline.has(element));
      const element = candidates.at(-1) || null;
      const current = cleanAnswerText(element);
      if (current && current !== best) {
        best = current;
        stableSince = Date.now();
        doneSince = 0;
        setStatus(`receiving answer\n${best.slice(0, 90)}`);
        continue;
      }

      if (element && answerIsDone(element)) {
        if (!doneSince) doneSince = Date.now();
      } else {
        doneSince = 0;
      }

      const stableFor = stableSince ? Date.now() - stableSince : 0;
      const doneFor = doneSince ? Date.now() - doneSince : 0;
      if (best && stableFor >= ANSWER_STABLE_MS && doneFor >= DONE_QUIET_MS) {
        return best;
      }

      if (Date.now() - lastDebugAt > 3000) {
        lastDebugAt = Date.now();
        setStatus(
          `waiting answer\nlen=${best.length} stable=${Math.round(stableFor / 1000)}s done=${Math.round(doneFor / 1000)}s`,
        );
      }
    }

    if (best) return best;
    throw new Error("Timed out waiting for DeepSeek final answer");
  }

  async function runCommand(cmd) {
    if (cmd.action !== "ask") throw new Error(`Unknown action for ${SITE}: ${cmd.action}`);
    const args = cmd.args || {};
    const prompt = String(args.prompt || "");
    const mode = String(args.mode || "instant");
    const attachments = Array.isArray(args.attachments) ? args.attachments : [];
    const waitMs = Number(args.wait_ms) > 0 ? Number(args.wait_ms) : DEFAULT_WAIT_MS;
    if (!prompt) throw new Error("Missing prompt");
    modeModelType(mode);

    setStatus(`starting ${mode}\n${cmd.id.slice(0, 8)}`);
    await startNewChat();
    await selectMode(mode);
    await uploadAttachments(attachments);

    const input = await waitFor(() => findInput(), {
      timeoutMs: 5000,
      label: "DeepSeek message input",
    });
    const baseline = answerSnapshot();
    setInputValue(input, prompt);

    const button = await waitFor(() => sendButton(input), {
      timeoutMs: 5000,
      label: "enabled DeepSeek send button",
    });
    if (modeControl(mode)?.getAttribute("aria-checked") !== "true") {
      throw new Error(`DeepSeek mode changed before send: expected ${mode}`);
    }
    button.click();

    const answer = await waitForFinalAnswer(baseline, waitMs);
    setStatus(`done ${mode}\nlen=${answer.length}`);
    return answer;
  }

  function sendWs(message) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
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
      const message = error?.message || String(error);
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
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "command") {
        becomeWorker();
        handleCommand(message);
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
    try { ws && ws.close(); } catch {}
  });

  setStatus("starting");
  connect();
})();
