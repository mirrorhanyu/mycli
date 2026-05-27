const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { WebSocketServer, WebSocket } = require("ws");

const { HOST, PORT, WS_PATH } = require("./constants.js");
const { loadAllSites, userscriptPath } = require("./registry.js");

loadAllSites();

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const DOWNLOAD_DIR = path.join(os.homedir(), "Downloads");
const HEARTBEAT_MS = 15000;

// site -> { ws, version, contextId, lastSeenAt }
const sitePeers = new Map();
// site -> { cookie, updatedAt, contextId, url }
const siteSessions = new Map();
// command_id -> { site, action, args, resolve, reject, timer, dispatched }
const pending = new Map();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function corsHeaders(req) {
  const origin = req.headers["origin"] || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-mycli",
    "access-control-allow-private-network": "true",
    "access-control-allow-credentials": "true",
  };
}

function sendJson(req, res, status, body, extra = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(req),
    ...extra,
  });
  res.end(JSON.stringify(body));
}

function sendText(req, res, status, text, type = "text/plain") {
  res.writeHead(status, {
    "content-type": `${type}; charset=utf-8`,
    ...corsHeaders(req),
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function activeSitePeer(site) {
  const entry = sitePeers.get(site);
  if (!entry) return null;
  if (entry.ws.readyState !== WebSocket.OPEN) {
    sitePeers.delete(site);
    return null;
  }
  return entry;
}

function failPending(cmdId, message) {
  const entry = pending.get(cmdId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(cmdId);
  entry.reject(new Error(message));
}

function failAllForSite(site, message) {
  for (const [id, entry] of pending) {
    if (entry.site !== site) continue;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(new Error(message));
  }
}

function sessionSummary(site, session) {
  return {
    site,
    hasCookie: Boolean(session?.cookie),
    updatedAt: Number(session?.updatedAt) || 0,
    contextId: session?.contextId || null,
    url: session?.url || null,
  };
}

function upsertSiteSession(site, payload = {}) {
  const cookie = String(payload.cookie || "").trim();
  if (!cookie) return null;
  const session = {
    cookie,
    updatedAt: Number(payload.updatedAt) > 0 ? Number(payload.updatedAt) : Date.now(),
    contextId: payload.contextId ? String(payload.contextId) : null,
    url: payload.url ? String(payload.url) : null,
  };
  siteSessions.set(site, session);
  return session;
}

function mimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const table = {
    ".aac": "audio/aac", ".csv": "text/csv", ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".epub": "application/epub+zip", ".html": "text/html",
    ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".m4a": "audio/mp4",
    ".md": "text/markdown", ".mp3": "audio/mpeg", ".mp4": "video/mp4",
    ".pdf": "application/pdf", ".png": "image/png",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain", ".wav": "audio/wav",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return table[ext] || "application/octet-stream";
}

function normalizeAttachments(args) {
  const list = [];
  const raw = args && (args.attachments || (args.attachment ? [args.attachment] : null));
  if (!raw) return list;
  for (const item of raw) {
    const filePath = path.resolve(String(item.path || item.file || item));
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error(`Attachment is not a file: ${filePath}`);
    if (stat.size > MAX_UPLOAD_BYTES) throw new Error(`Attachment is too large: ${filePath}`);
    list.push({
      path: filePath,
      name: item.name ? String(item.name) : path.basename(filePath),
      mime: item.mime ? String(item.mime) : mimeFromPath(filePath),
      size: stat.size,
    });
  }
  return list;
}

function dispatchCommand({ site, action, args, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const peer = activeSitePeer(site);
    if (!peer) {
      reject(new Error(`No userscript connected for site "${site}". Install the Tampermonkey script and open the page.`));
      return;
    }

    let attachments;
    try {
      attachments = normalizeAttachments(args);
    } catch (error) {
      reject(error);
      return;
    }

    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Command timeout after ${Math.round(timeoutMs / 1000)}s`));
    }, Math.min(timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));

    const entry = { id, site, action, args, attachments, resolve, reject, timer, dispatched: false };
    pending.set(id, entry);

    // Replace local path with a daemon-served URL the userscript can GM_xmlhttpRequest.
    const wireArgs = { ...args };
    delete wireArgs.attachment;
    delete wireArgs.attachments;
    if (attachments.length) {
      wireArgs.attachments = attachments.map((att, idx) => ({
        id: String(idx),
        name: att.name,
        mime: att.mime,
        size: att.size,
        url: `/attachment/${id}/${idx}`,
      }));
    }

    try {
      peer.ws.send(JSON.stringify({ type: "command", id, action, args: wireArgs }), (err) => {
        if (err && !entry.dispatched) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error(`Failed to dispatch: ${err.message}`));
        }
      });
      entry.dispatched = true;
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

function safeFilename(name) {
  return String(name || "mycli-upload")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 200) || "mycli-upload";
}

function uniquePath(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  let target = path.join(dir, name);
  let counter = 1;
  while (fs.existsSync(target)) {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    target = path.join(dir, `${stem} (${counter})${ext}`);
    counter += 1;
  }
  return target;
}

function handleUpload(req, res, url) {
  const cmdId = String(url.searchParams.get("cmd_id") || "").trim();
  const entry = cmdId ? pending.get(cmdId) : null;
  if (!entry) {
    sendJson(req, res, 404, { ok: false, error: "Unknown cmd_id" });
    return;
  }
  const filename = safeFilename(url.searchParams.get("filename") || "mycli-upload");
  const outputDir = (entry.args && entry.args.output_dir) ? path.resolve(String(entry.args.output_dir)) : DOWNLOAD_DIR;
  let savePath;
  try {
    savePath = uniquePath(outputDir, filename);
  } catch (error) {
    sendJson(req, res, 500, { ok: false, error: `Cannot create directory: ${error.message}` });
    return;
  }

  const chunks = [];
  let total = 0;
  let aborted = false;
  req.on("data", (chunk) => {
    total += chunk.length;
    if (total > MAX_UPLOAD_BYTES) {
      aborted = true;
      req.destroy();
    } else {
      chunks.push(chunk);
    }
  });
  req.on("end", () => {
    if (aborted) {
      sendJson(req, res, 413, { ok: false, error: "Upload too large" });
      return;
    }
    try {
      fs.writeFileSync(savePath, Buffer.concat(chunks));
    } catch (error) {
      sendJson(req, res, 500, { ok: false, error: `Failed to save: ${error.message}` });
      return;
    }
    sendJson(req, res, 200, { ok: true, path: savePath, size: total });
  });
  req.on("error", (error) => {
    sendJson(req, res, 500, { ok: false, error: error.message || String(error) });
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/ping") {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/status") {
    const sites = [...sitePeers.entries()]
      .filter(([, entry]) => entry.ws.readyState === WebSocket.OPEN)
      .map(([site, entry]) => ({
        site,
        version: entry.version,
        contextId: entry.contextId,
        lastSeenAt: entry.lastSeenAt,
        pending: [...pending.values()].filter((p) => p.site === site).length,
      }));
    const sessions = [...siteSessions.entries()].map(([site, session]) => sessionSummary(site, session));
    sendJson(req, res, 200, {
      ok: true,
      pid: process.pid,
      uptime: process.uptime(),
      port: PORT,
      sites,
      sessions,
      pending: pending.size,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/shutdown") {
    sendJson(req, res, 200, { ok: true });
    setTimeout(shutdown, 50);
    return;
  }

  // Serve the userscript for installation: GET /userscript/<site>/mycli.user.js
  const userscriptMatch = pathname.match(/^\/userscript\/([^/]+)\/mycli\.user\.js$/);
  if (req.method === "GET" && userscriptMatch) {
    const site = userscriptMatch[1];
    const file = userscriptPath(site);
    if (!fs.existsSync(file)) {
      sendText(req, res, 404, `Unknown site: ${site}`);
      return;
    }
    sendText(req, res, 200, fs.readFileSync(file, "utf8"), "application/javascript");
    return;
  }

  if (req.method === "POST" && pathname === "/upload") {
    handleUpload(req, res, url);
    return;
  }

  const attMatch = pathname.match(/^\/attachment\/([^/]+)\/([^/]+)$/);
  if (req.method === "GET" && attMatch) {
    const entry = pending.get(decodeURIComponent(attMatch[1]));
    if (!entry) {
      sendJson(req, res, 404, { ok: false, error: "Unknown cmd_id" });
      return;
    }
    const att = entry.attachments?.[Number(decodeURIComponent(attMatch[2]))];
    if (!att) {
      sendJson(req, res, 404, { ok: false, error: "Unknown attachment" });
      return;
    }
    res.writeHead(200, {
      "content-type": att.mime,
      "content-length": att.size,
      "content-disposition": `attachment; filename="${encodeURIComponent(att.name)}"`,
      ...corsHeaders(req),
    });
    fs.createReadStream(att.path).pipe(res);
    return;
  }

  if (req.method === "POST" && pathname === "/command") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(req, res, 400, { ok: false, error: `Invalid body: ${error.message}` });
      return;
    }
    const site = String(body.site || "").trim();
    const action = String(body.action || "").trim();
    if (!site || !action) {
      sendJson(req, res, 400, { ok: false, error: "Missing site or action" });
      return;
    }
    const timeoutMs = Number(body.timeout_ms) > 0 ? Number(body.timeout_ms) : DEFAULT_TIMEOUT_MS;
    try {
      const result = await dispatchCommand({ site, action, args: body.args || {}, timeoutMs });
      sendJson(req, res, 200, { ok: true, result });
    } catch (error) {
      sendJson(req, res, 502, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  sendJson(req, res, 404, { ok: false, error: "Not found" });
}

const httpServer = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    try {
      sendJson(req, res, 500, { ok: false, error: error.message || String(error) });
    } catch {
      try { res.writeHead(500); res.end(); } catch {}
    }
  });
});

const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });

wss.on("connection", (ws, req) => {
  log(`[ws] connected from ${req.socket.remoteAddress}`);

  let registeredSite = null;
  let missedPongs = 0;
  const heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(heartbeat);
      return;
    }
    if (missedPongs >= 2) {
      log("[ws] heartbeat lost, terminating");
      clearInterval(heartbeat);
      ws.terminate();
      return;
    }
    missedPongs += 1;
    try { ws.ping(); } catch {}
  }, HEARTBEAT_MS);

  ws.on("pong", () => { missedPongs = 0; });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === "hello") {
      const site = String(msg.site || "").trim();
      if (!site) return;
      const previous = sitePeers.get(site);
      if (previous && previous.ws !== ws) {
        try { previous.ws.close(); } catch {}
      }
      registeredSite = site;
      sitePeers.set(site, {
        ws,
        version: msg.version || null,
        contextId: msg.contextId || null,
        lastSeenAt: Date.now(),
      });
      log(`[ws] site registered: ${site} v${msg.version || "?"}`);
      try { ws.send(JSON.stringify({ type: "hello_ack", site })); } catch {}
      return;
    }

    if (msg.type === "session_update") {
      const site = String(msg.site || registeredSite || "").trim();
      if (!site) return;
      if (registeredSite && site !== registeredSite) return;
      const peer = sitePeers.get(site);
      if (peer && peer.ws === ws) {
        peer.lastSeenAt = Date.now();
      }
      upsertSiteSession(site, {
        cookie: msg?.data?.cookie,
        updatedAt: msg?.data?.updatedAt,
        contextId: msg.contextId || peer?.contextId || null,
        url: msg?.data?.url,
      });
      return;
    }

    if (msg.type === "log") {
      log(`[${registeredSite || "ws"}] ${msg.level || "info"}: ${msg.msg || ""}`);
      return;
    }

    if (msg.type === "result" && msg.id) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(msg.id);
      if (msg.ok === false) {
        entry.reject(new Error(msg.error || "Command failed"));
      } else {
        entry.resolve(msg.data === undefined ? null : msg.data);
      }
      return;
    }
  });

  ws.on("close", () => {
    log(`[ws] closed (site=${registeredSite || "?"})`);
    clearInterval(heartbeat);
    if (registeredSite && sitePeers.get(registeredSite)?.ws === ws) {
      sitePeers.delete(registeredSite);
      failAllForSite(registeredSite, "Userscript disconnected");
    }
  });

  ws.on("error", (error) => {
    log(`[ws] error: ${error.message}`);
  });
});

httpServer.listen(PORT, HOST, () => {
  log(`mycli daemon listening at http://${HOST}:${PORT} (ws ${WS_PATH})`);
});

httpServer.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    log(`[daemon] Port ${PORT} already in use. Exiting.`);
    process.exit(2);
  }
  log(`[daemon] Server error: ${error.message}`);
  process.exit(1);
});

function shutdown() {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error("Daemon shutting down"));
  }
  pending.clear();
  siteSessions.clear();
  for (const [, entry] of sitePeers) {
    try { entry.ws.close(); } catch {}
  }
  try { httpServer.close(); } catch {}
  setTimeout(() => process.exit(0), 100);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Suppress noisy `cmdId` lint (intentionally unused in some branches)
void failPending;
