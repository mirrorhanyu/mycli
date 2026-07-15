// ==UserScript==
// @name         mycli ChatGPT Bridge
// @namespace    local.mycli.chatgpt
// @version      0.1.6
// @description  HTTP bridge to the mycli micro-daemon. Generates and downloads ChatGPT images.
// @match        https://chatgpt.com/*
// @downloadURL  http://127.0.0.1:17872/userscript/chatgpt/mycli.user.js
// @updateURL    http://127.0.0.1:17872/userscript/chatgpt/mycli.user.js
// @grant        GM_xmlhttpRequest
// @connect      chatgpt.com
// @connect      127.0.0.1
// @connect      localhost
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  if (window.top !== window.self) return;

  const HTTP_API = "http://127.0.0.1:17872";
  const SITE = "chatgpt";
  const VERSION = "0.1.6";
  const TAB_ID_KEY = "mycli-chatgpt-tab-id";
  const TAB_ID = (() => {
    try {
      let id = sessionStorage.getItem(TAB_ID_KEY);
      if (!id) {
        id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        sessionStorage.setItem(TAB_ID_KEY, id);
      }
      return id;
    } catch {
      return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
  })();
  const LOCK_KEY = "mycli-chatgpt-worker-lock";
  const LOCK_TTL_MS = 5000;
  const RECONNECT_MIN_MS = 1000;
  const RECONNECT_MAX_MS = 15000;
  const DEFAULT_WAIT_MS = 15 * 60 * 1000;
  const IMAGE_STABLE_MS = 3500;
  const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
  const MODE_LABELS = {
    instant: "Instant",
    medium: "Medium",
    high: "High",
  };
  const MODE_MENU_SELECTOR = [
    '[data-testid="composer-intelligence-picker-content"]',
    '[role="menu"]',
    '[role="listbox"]',
    '[role="dialog"]',
    '[data-radix-popper-content-wrapper]',
    '[data-radix-menu-content]',
    '[data-radix-dropdown-menu-content]',
    '[data-slot="popover-content"]',
    '[data-slot="dropdown-menu-content"]',
  ].join(", ");
  const MODE_OPTION_SELECTOR = [
    '[role="menuitemradio"]',
    '[role="menuitem"]',
    '[role="option"]',
    'button',
    '[tabindex="0"]',
    '[data-radix-collection-item]',
  ].join(", ");

  let busy = false;
  let stopped = false;
  let statusBox = null;

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

  function compactText(text, limit = 240) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
  }

  function elementSearchText(element) {
    return [
      normalizedText(element),
      element?.getAttribute?.("aria-label") || "",
      element?.getAttribute?.("title") || "",
    ].join(" ").replace(/\s+/g, " ").trim();
  }

  function textHasModeLabel(text, label) {
    return new RegExp(`(^|\\s)${label}(\\s|$)`, "i").test(String(text || ""));
  }

  function modeLabelForElement(element) {
    const text = elementSearchText(element);
    return Object.values(MODE_LABELS).find((label) => textHasModeLabel(text, label)) || "";
  }

  function describeElement(element) {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName?.toLowerCase() || "",
      id: element.id || "",
      role: element.getAttribute?.("role") || "",
      testid: element.getAttribute?.("data-testid") || "",
      ariaLabel: compactText(element.getAttribute?.("aria-label") || "", 120),
      ariaHaspopup: element.getAttribute?.("aria-haspopup") || "",
      ariaExpanded: element.getAttribute?.("aria-expanded") || "",
      className: compactText(element.getAttribute?.("class") || "", 160),
      text: compactText(normalizedText(element), 240),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
    };
  }

  function debugElements(selector, limit = 12) {
    return [...document.querySelectorAll(selector)]
      .filter(visible)
      .slice(0, limit)
      .map(describeElement);
  }

  function debugTextMatches(limit = 16) {
    const labels = Object.values(MODE_LABELS);
    const matches = [];
    for (const element of document.querySelectorAll("button, [role], [aria-label], [tabindex]")) {
      if (!visible(element)) continue;
      const text = elementSearchText(element);
      if (!labels.some((label) => textHasModeLabel(text, label))) continue;
      matches.push(describeElement(element));
      if (matches.length >= limit) break;
    }
    return matches;
  }

  function modeSelectionDebug(root, trigger, label) {
    const data = {
      targetLabel: label,
      url: location.href,
      activeElement: describeElement(document.activeElement),
      composer: describeElement(root),
      trigger: describeElement(trigger),
      modeButtons: debugElements([
        'button[aria-haspopup]',
        'button[data-testid*="intelligence"]',
        'button[data-testid*="model"]',
        'button[data-testid*="mode"]',
        'button[aria-label*="model" i]',
        'button[aria-label*="mode" i]',
      ].join(", "), 16),
      menus: debugElements(MODE_MENU_SELECTOR, 16),
      modeTextMatches: debugTextMatches(20),
    };
    return JSON.stringify(data, null, 2).slice(0, 7000);
  }

  function activateElement(element) {
    if (!element) return;
    element.scrollIntoView?.({ block: "center", inline: "center" });
    element.focus?.();
    const rect = element.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      buttons: 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      try {
        element.dispatchEvent(new MouseEvent(type, init));
      } catch {
        element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, composed: true }));
      }
    }
    element.click?.();
  }

  function ensureStatusBox() {
    if (statusBox?.isConnected) return statusBox;
    let box = document.getElementById("mycli-chatgpt-status");
    if (!box) {
      box = document.createElement("div");
      box.id = "mycli-chatgpt-status";
      box.style.cssText = [
        "position:fixed",
        "right:0",
        "top:72px",
        "z-index:2147483647",
        "max-width:320px",
        "padding:8px 10px",
        "border-left:3px solid #10a37f",
        "border-radius:10px 0 0 10px",
        "background:rgba(17,24,39,.92)",
        "box-shadow:0 8px 24px rgba(0,0,0,.18)",
        "color:#fff",
        "font:12px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
        "white-space:pre-wrap",
      ].join(";");
      (document.body || document.documentElement).appendChild(box);
    }
    statusBox = box;
    return box;
  }

  function setStatus(text) {
    ensureStatusBox().textContent = `mycli/${SITE} ${VERSION}\n${text}`;
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

  function composer() {
    return [...document.querySelectorAll('form[data-type="unified-composer"]')]
      .filter(visible)
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0] || null;
  }

  function promptInput(root = composer()) {
    return root?.querySelector('[contenteditable="true"][role="textbox"][aria-label="Chat with ChatGPT"]') ||
      root?.querySelector('#prompt-textarea[contenteditable="true"]') ||
      null;
  }

  function currentModeButton(root = composer()) {
    return [...(root?.querySelectorAll([
      'button[aria-haspopup]',
      'button[data-testid*="intelligence"]',
      'button[data-testid*="model"]',
      'button[data-testid*="mode"]',
      'button[aria-label*="model" i]',
      'button[aria-label*="mode" i]',
    ].join(", ")) || [])]
      .filter(visible)
      .find((button) => modeLabelForElement(button)) || null;
  }

  function modeOptionCandidates(root) {
    if (!root) return [];
    const candidates = root.matches?.(MODE_OPTION_SELECTOR) ? [root] : [];
    candidates.push(...root.querySelectorAll(MODE_OPTION_SELECTOR));
    return [...new Set(candidates)].filter(visible);
  }

  function findModeOption(root, label, excludeRoot = null) {
    return modeOptionCandidates(root)
      .filter((item) => !excludeRoot?.contains(item))
      .find((item) => textHasModeLabel(elementSearchText(item), label)) || null;
  }

  function modeMenu() {
    return [...document.querySelectorAll(MODE_MENU_SELECTOR)]
      .filter(visible)
      .find((menu) => Object.values(MODE_LABELS).some((label) => findModeOption(menu, label))) || null;
  }

  async function selectMode(mode) {
    const label = MODE_LABELS[mode];
    if (!label) throw new Error(`Invalid ChatGPT mode: ${mode}`);
    const root = await waitFor(() => composer(), { label: "ChatGPT composer" });
    let trigger = await waitFor(() => currentModeButton(root), {
      label: "ChatGPT intelligence picker",
    });
    if (modeLabelForElement(trigger) === label) {
      if (trigger.getAttribute("aria-expanded") === "true") activateElement(trigger);
      return;
    }
    if (trigger.getAttribute("aria-expanded") !== "true") activateElement(trigger);
    let opened;
    try {
      opened = await waitFor(() => {
        const menu = modeMenu();
        const fallbackOption = findModeOption(document.body, label, root);
        return menu || fallbackOption ? { menu, fallbackOption } : null;
      }, { label: "ChatGPT intelligence menu" });
    } catch (error) {
      throw new Error(`${error.message}\nChatGPT mode DOM debug:\n${modeSelectionDebug(root, trigger, label)}`);
    }
    const option = findModeOption(opened.menu, label) || opened.fallbackOption;
    if (!option) throw new Error(`ChatGPT mode is unavailable: ${label}`);
    activateElement(option);
    await waitFor(() => {
      trigger = currentModeButton(root);
      return trigger && modeLabelForElement(trigger) === label;
    }, { label: `${label} mode selection` });
  }

  function setPrompt(input, text) {
    input.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("delete", false);
    if (!document.execCommand("insertText", false, text)) {
      input.textContent = text;
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }));
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function sendButton(root = composer()) {
    const direct =
      root?.querySelector('button[data-testid="send-button"]') ||
      root?.querySelector('button[aria-label="Send prompt"]') ||
      root?.querySelector('button[aria-label="Send message"]');
    if (direct && visible(direct) && !direct.disabled) return direct;
    return [...(root?.querySelectorAll("button") || [])]
      .filter(visible)
      .filter((button) => !button.disabled)
      .filter((button) => /send/i.test(button.getAttribute("aria-label") || ""))
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0] || null;
  }

  function generatedImages() {
    const byUrl = new Map();
    for (const image of document.querySelectorAll('img[alt^="Generated image:"]')) {
      const url = image.currentSrc || image.src;
      if (!url || byUrl.has(url)) continue;
      byUrl.set(url, image);
    }
    return [...byUrl.values()];
  }

  function generatedImageUrls() {
    return new Set(generatedImages().map((image) => image.currentSrc || image.src));
  }

  function generationRunning() {
    const root = composer();
    return [...(root?.querySelectorAll("button") || [])]
      .filter(visible)
      .some((button) => /stop/i.test(button.getAttribute("aria-label") || ""));
  }

  function imageReady(image) {
    const imageRoot = image.closest('[class~="group/imagegen-image"]');
    return (
      image.complete &&
      image.naturalWidth > 0 &&
      image.naturalHeight > 0 &&
      Boolean(imageRoot?.querySelector('[data-testid="image-gen-overlay-actions"]'))
    );
  }

  function challengeMessage() {
    const text = normalizedText(document.body);
    if (/verify you are human|security check|captcha|人机验证|安全验证/i.test(text)) {
      return "ChatGPT requires browser verification. Complete it in the page and retry";
    }
    return "";
  }

  function latestAssistantText() {
    const turns = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    return normalizedText(turns.at(-1));
  }

  async function waitForGeneratedImages(baselineUrls, baselineAssistantCount, timeoutMs) {
    const started = Date.now();
    let stableSince = 0;
    let lastKey = "";
    let lastDebugAt = 0;

    while (Date.now() - started < timeoutMs) {
      await sleep(500);
      becomeWorker();
      const challenge = challengeMessage();
      if (challenge) throw new Error(challenge);

      const images = generatedImages().filter((image) => {
        const url = image.currentSrc || image.src;
        return url && !baselineUrls.has(url);
      });
      const ready = images.filter(imageReady);
      const key = ready.map((image) => image.currentSrc || image.src).join("|");
      if (key && key === lastKey) {
        if (!stableSince) stableSince = Date.now();
      } else {
        lastKey = key;
        stableSince = key ? Date.now() : 0;
      }

      const stableFor = stableSince ? Date.now() - stableSince : 0;
      if (ready.length && stableFor >= IMAGE_STABLE_MS && !generationRunning()) {
        return ready;
      }

      const assistantCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;
      if (!images.length && assistantCount > baselineAssistantCount && !generationRunning()) {
        const response = latestAssistantText();
        if (response) throw new Error(`ChatGPT returned text instead of an image: ${response.slice(0, 240)}`);
      }

      if (Date.now() - lastDebugAt > 3000) {
        lastDebugAt = Date.now();
        setStatus(
          `waiting for image\nfound=${images.length} ready=${ready.length} stable=${Math.round(stableFor / 1000)}s`,
        );
      }
    }
    throw new Error("Timed out waiting for ChatGPT generated image");
  }

  function requestImage(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "arraybuffer",
        timeout: 10 * 60 * 1000,
        onprogress(event) {
          if (!event.loaded) return;
          const progress = event.lengthComputable
            ? `${Math.round((event.loaded / event.total) * 100)}%`
            : `${(event.loaded / 1024 / 1024).toFixed(1)} MB`;
          setStatus(`downloading image\n${progress}`);
        },
        onload(response) {
          if (response.status < 200 || response.status >= 400) {
            reject(new Error(`Image download failed: HTTP ${response.status}`));
            return;
          }
          const contentType =
            response.responseHeaders?.match(/^content-type:\s*([^;\r\n]+)/im)?.[1]?.trim() ||
            "image/png";
          const buffer = response.response;
          if (!buffer?.byteLength) {
            reject(new Error("ChatGPT image download returned an empty file"));
            return;
          }
          resolve(new Blob([buffer], { type: contentType }));
        },
        onerror() {
          reject(new Error("Cannot download the ChatGPT generated image"));
        },
        ontimeout() {
          reject(new Error("ChatGPT image download timed out"));
        },
      });
    });
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
          reject(new Error(`Cannot save image part ${part + 1}/${parts}`));
        },
        ontimeout() {
          reject(new Error(`Saving image part ${part + 1}/${parts} timed out`));
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
      setStatus(`saving image\n${part + 1}/${parts}\n${filename}`);
      result = await uploadBlobPart(cmdId, filename, chunk, part, parts);
    }
    return result;
  }

  function safeFilename(name) {
    return String(name || "")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/^\.+/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
  }

  function defaultFilename() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `chatgpt-image-${stamp}.png`;
  }

  function ensurePngExtension(name) {
    return /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.png`;
  }

  function indexedFilename(name, index, total) {
    const normalized = ensurePngExtension(safeFilename(name) || defaultFilename());
    if (total <= 1) return normalized;
    const match = normalized.match(/^(.*?)(\.[^.]+)$/);
    return `${match?.[1] || normalized}-${index + 1}${match?.[2] || ""}`;
  }

  async function runCommand(cmd) {
    if (cmd.action !== "image") throw new Error(`Unknown action for ${SITE}: ${cmd.action}`);
    const args = cmd.args || {};
    const prompt = String(args.prompt || "").trim();
    const mode = String(args.mode || "high").toLowerCase();
    const waitMs = Number(args.wait_ms) > 0 ? Number(args.wait_ms) : DEFAULT_WAIT_MS;
    const download = args.download !== false;
    const rename = args.rename ? String(args.rename) : "";
    if (!prompt) throw new Error("Missing prompt");
    if (!MODE_LABELS[mode]) throw new Error(`Invalid ChatGPT mode: ${mode}`);

    setStatus(`starting ${MODE_LABELS[mode]}\n${cmd.id.slice(0, 8)}`);
    const root = await waitFor(() => composer(), { timeoutMs: 15000, label: "ChatGPT composer" });
    await selectMode(mode);
    const input = await waitFor(() => promptInput(root), { label: "ChatGPT prompt input" });
    const baselineUrls = generatedImageUrls();
    const baselineAssistantCount =
      document.querySelectorAll('[data-message-author-role="assistant"]').length;

    setPrompt(input, prompt);
    const button = await waitFor(() => sendButton(root), {
      timeoutMs: 10000,
      label: "enabled ChatGPT send button",
    });
    if (modeLabelForElement(currentModeButton(root)) !== MODE_LABELS[mode]) {
      throw new Error(`ChatGPT mode changed before send: expected ${MODE_LABELS[mode]}`);
    }
    button.click();

    const generated = await waitForGeneratedImages(baselineUrls, baselineAssistantCount, waitMs);
    const result = [];
    for (let index = 0; index < generated.length; index += 1) {
      const image = generated[index];
      const url = image.currentSrc || image.src;
      const item = {
        url,
        width: image.naturalWidth,
        height: image.naturalHeight,
        saved_path: null,
      };
      if (download) {
        const blob = await requestImage(url);
        const filename = indexedFilename(rename || defaultFilename(), index, generated.length);
        const saved = await uploadToLocalService(cmd.id, filename, blob);
        item.saved_path = saved.path;
        item.size = blob.size;
      }
      result.push(item);
    }
    setStatus(`done ${MODE_LABELS[mode]}\nimages=${result.length}`);
    return { mode, images: result };
  }

  function postBridge(path, body, timeout = 40000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: `${HTTP_API}${path}`,
        headers: { "content-type": "application/json" },
        data: JSON.stringify(body),
        timeout,
        onload(response) {
          let json;
          try {
            json = JSON.parse(response.responseText || "{}");
          } catch (error) {
            reject(error);
            return;
          }
          if (response.status < 200 || response.status >= 300 || json.ok === false) {
            reject(new Error(json.error || `HTTP ${response.status}`));
            return;
          }
          resolve(json);
        },
        onerror() {
          reject(new Error("Cannot reach the mycli local service"));
        },
        ontimeout() {
          reject(new Error("mycli local bridge timed out"));
        },
      });
    });
  }

  async function sendResult(cmd, ok, data, error) {
    await postBridge("/bridge/result", {
      site: SITE,
      version: VERSION,
      contextId: TAB_ID,
      id: cmd.id,
      ok,
      data,
      error,
    });
  }

  async function handleCommand(cmd) {
    if (busy) {
      await sendResult(cmd, false, null, "Userscript is busy with another command");
      return;
    }
    busy = true;
    try {
      const data = await runCommand(cmd);
      await sendResult(cmd, true, data, null);
    } catch (error) {
      const message = error?.message || String(error);
      setStatus(`error\n${message}`);
      try {
        await sendResult(cmd, false, null, message);
      } catch {}
    } finally {
      busy = false;
    }
  }

  async function pollLoop() {
    let retryDelay = RECONNECT_MIN_MS;
    while (!stopped) {
      if (!becomeWorker()) {
        setStatus("standby, another ChatGPT tab is worker");
        await sleep(LOCK_TTL_MS);
        continue;
      }
      try {
        const response = await postBridge("/bridge/poll", {
          site: SITE,
          version: VERSION,
          contextId: TAB_ID,
        });
        retryDelay = RECONNECT_MIN_MS;
        becomeWorker();
        if (response.command) {
          handleCommand(response.command);
        } else if (!busy) {
          setStatus("connected, waiting");
        }
      } catch (error) {
        if (stopped) return;
        setStatus(`bridge error, retry in ${Math.round(retryDelay / 1000)}s\n${error.message || String(error)}`);
        await sleep(retryDelay);
        retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX_MS);
      }
    }
  }

  window.addEventListener("beforeunload", () => {
    stopped = true;
    releaseWorker();
  });

  setInterval(() => {
    if (lockSnapshot()?.id === TAB_ID) becomeWorker();
  }, Math.max(1000, Math.floor(LOCK_TTL_MS / 2)));

  setStatus("starting");
  pollLoop();
})();
