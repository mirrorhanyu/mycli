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
const MAX_TIMEOUT_MS = 45 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_DIR = path.join(os.homedir(), "Downloads");
const HEARTBEAT_MS = 15000;

// site -> Map(accountKey -> { ws, version, contextId, accountId, accountName, lastSeenAt })
// accountKey is the userscript-reported accountId, or "" for sites that do not
// report accounts (legacy single-slot behavior).
const sitePeers = new Map();
// site -> Map(accountKey -> { cookie, accountId, accountName, updatedAt, contextId, url })
const siteSessions = new Map();
// command_id -> { site, accountKey, action, args, resolve, reject, timer, dispatched }
const pending = new Map();
// upload key -> { savePath, tempPath, parts, nextPart, size }
const activeUploads = new Map();

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

function sitePeerMap(site) {
  let peers = sitePeers.get(site);
  if (!peers) {
    peers = new Map();
    sitePeers.set(site, peers);
  }
  return peers;
}

function livePeers(site) {
  const peers = sitePeers.get(site);
  if (!peers) return [];
  for (const [key, entry] of peers) {
    if (entry.ws.readyState !== WebSocket.OPEN) peers.delete(key);
  }
  return [...peers.entries()];
}

function describePeers(peers) {
  return peers
    .map(([, entry]) => entry.accountName || entry.accountId || entry.contextId || "?")
    .join(", ");
}

function resolvePeer(site, account) {
  const peers = livePeers(site);
  if (!peers.length) {
    throw new Error(`No userscript connected for site "${site}". Install the Tampermonkey script and open the page.`);
  }
  const wanted = String(account || "").trim();
  if (wanted) {
    const found = peers.find(([, entry]) => entry.accountId === wanted || entry.accountName === wanted);
    if (!found) {
      throw new Error(`No connected page for account "${wanted}" on ${site}. Connected: ${describePeers(peers)}`);
    }
    return found;
  }
  if (peers.length > 1) {
    throw new Error(`Multiple accounts connected for ${site}: ${describePeers(peers)}. Pass --account <name|id> to choose one.`);
  }
  return peers[0];
}

function failPending(cmdId, message) {
  const entry = pending.get(cmdId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(cmdId);
  entry.reject(new Error(message));
}

function failAllForPeer(site, accountKey, message) {
  for (const [id, entry] of pending) {
    if (entry.site !== site || entry.accountKey !== accountKey) continue;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(new Error(message));
  }
}

function sessionSummary(site, session) {
  return {
    site,
    hasCookie: Boolean(session?.cookie),
    hasAccount: Boolean(session?.accountId),
    accountName: session?.accountName || null,
    updatedAt: Number(session?.updatedAt) || 0,
    contextId: session?.contextId || null,
    url: session?.url || null,
  };
}

function upsertSiteSession(site, accountKey, payload = {}) {
  let sessions = siteSessions.get(site);
  if (!sessions) {
    sessions = new Map();
    siteSessions.set(site, sessions);
  }
  const previous = sessions.get(accountKey) || {};
  const session = {
    cookie: payload.cookie === undefined ? String(previous.cookie || "") : String(payload.cookie || "").trim(),
    accountId: payload.accountId === undefined ? String(previous.accountId || "") : String(payload.accountId || "").trim(),
    accountName: payload.accountName === undefined ? String(previous.accountName || "") : String(payload.accountName || "").trim(),
    updatedAt: Number(payload.updatedAt) > 0 ? Number(payload.updatedAt) : Date.now(),
    contextId: payload.contextId === undefined ? (previous.contextId || null) : (payload.contextId ? String(payload.contextId) : null),
    url: payload.url === undefined ? (previous.url || null) : (payload.url ? String(payload.url) : null),
  };
  sessions.set(accountKey, session);
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

function dispatchCommand({ site, account, action, args, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let accountKey;
    let peer;
    try {
      [accountKey, peer] = resolvePeer(site, account);
    } catch (error) {
      reject(error);
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

    const entry = { id, site, accountKey, action, args, attachments, resolve, reject, timer, dispatched: false };
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
  const part = Number(url.searchParams.get("part") || 0);
  const parts = Number(url.searchParams.get("parts") || 1);
  if (!Number.isInteger(part) || !Number.isInteger(parts) || part < 0 || parts < 1 || part >= parts) {
    sendJson(req, res, 400, { ok: false, error: "Invalid upload part" });
    return;
  }

  const uploadKey = `${cmdId}\0${filename}`;
  let upload = activeUploads.get(uploadKey);
  if (part === 0) {
    try {
      const savePath = uniquePath(outputDir, filename);
      const tempPath = `${savePath}.part`;
      fs.rmSync(tempPath, { force: true });
      upload = { savePath, tempPath, parts, nextPart: 0, size: 0 };
      activeUploads.set(uploadKey, upload);
    } catch (error) {
      sendJson(req, res, 500, { ok: false, error: `Cannot create upload: ${error.message}` });
      return;
    }
  }
  if (!upload || upload.parts !== parts || upload.nextPart !== part) {
    sendJson(req, res, 409, { ok: false, error: `Unexpected upload part ${part + 1}/${parts}` });
    return;
  }

  const chunks = [];
  let total = 0;
  let tooLarge = false;
  req.on("data", (chunk) => {
    total += chunk.length;
    if (total > MAX_UPLOAD_CHUNK_BYTES || upload.size + total > MAX_UPLOAD_BYTES) {
      tooLarge = true;
    } else {
      chunks.push(chunk);
    }
  });
  req.on("end", () => {
    if (tooLarge) {
      activeUploads.delete(uploadKey);
      try { fs.rmSync(upload.tempPath, { force: true }); } catch {}
      sendJson(req, res, 413, { ok: false, error: "Upload too large" });
      return;
    }
    try {
      fs.appendFileSync(upload.tempPath, Buffer.concat(chunks));
      upload.size += total;
      upload.nextPart += 1;
      if (upload.nextPart === upload.parts) {
        fs.renameSync(upload.tempPath, upload.savePath);
        activeUploads.delete(uploadKey);
      }
    } catch (error) {
      activeUploads.delete(uploadKey);
      try { fs.rmSync(upload.tempPath, { force: true }); } catch {}
      sendJson(req, res, 500, { ok: false, error: `Failed to save: ${error.message}` });
      return;
    }
    sendJson(req, res, 200, {
      ok: true,
      complete: upload.nextPart === upload.parts,
      part: upload.nextPart,
      parts: upload.parts,
      path: upload.nextPart === upload.parts ? upload.savePath : null,
      size: upload.size,
    });
  });
  req.on("error", (error) => {
    activeUploads.delete(uploadKey);
    try { fs.rmSync(upload.tempPath, { force: true }); } catch {}
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
    const sites = [];
    for (const site of sitePeers.keys()) {
      for (const [accountKey, entry] of livePeers(site)) {
        sites.push({
          site,
          version: entry.version,
          contextId: entry.contextId,
          accountId: entry.accountId || null,
          accountName: entry.accountName || null,
          lastSeenAt: entry.lastSeenAt,
          pending: [...pending.values()].filter((p) => p.site === site && p.accountKey === accountKey).length,
        });
      }
    }
    const sessions = [];
    for (const [site, perAccount] of siteSessions.entries()) {
      for (const session of perAccount.values()) {
        sessions.push(sessionSummary(site, session));
      }
    }
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

  // Serve the userscript for installation: GET/HEAD /userscript/<site>/mycli.user.js
  const userscriptMatch = pathname.match(/^\/userscript\/([^/]+)\/mycli\.user\.js$/);
  if ((req.method === "GET" || req.method === "HEAD") && userscriptMatch) {
    const site = userscriptMatch[1];
    const file = userscriptPath(site);
    if (!fs.existsSync(file)) {
      sendText(req, res, 404, `Unknown site: ${site}`);
      return;
    }
    if (req.method === "HEAD") {
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        ...corsHeaders(req),
      });
      res.end();
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
    const account = String(body.account || "").trim();
    const timeoutMs = Number(body.timeout_ms) > 0 ? Number(body.timeout_ms) : DEFAULT_TIMEOUT_MS;
    const started = Date.now();
    const argsPreview = JSON.stringify(body.args || {});
    log(`[cmd] ${site}${account ? `@${account}` : ""} ${action} args=${argsPreview.length > 300 ? `${argsPreview.slice(0, 300)}…` : argsPreview}`);
    try {
      const result = await dispatchCommand({ site, account, action, args: body.args || {}, timeoutMs });
      log(`[cmd] ${site} ${action} ok (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      sendJson(req, res, 200, { ok: true, result });
    } catch (error) {
      log(`[cmd] ${site} ${action} failed (${((Date.now() - started) / 1000).toFixed(1)}s): ${error.message || error}`);
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
  let registeredAccountKey = null;
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
      const accountId = msg.accountId ? String(msg.accountId) : "";
      const accountKey = accountId;
      const peers = sitePeerMap(site);
      const previous = peers.get(accountKey);
      if (previous && previous.ws !== ws) {
        const previousAlive = previous.ws.readyState === WebSocket.OPEN;
        if (previousAlive && accountId && msg.takeover !== true) {
          // A healthy page already serves this account. Reject the newcomer so
          // pages never steal the slot from each other automatically; the user
          // takes over explicitly from the status box (hello with takeover).
          try {
            ws.send(JSON.stringify({
              type: "hello_rejected",
              site,
              reason: "account_in_use",
              accountId,
              accountName: previous.accountName || null,
            }));
          } catch {}
          try { ws.close(); } catch {}
          log(`[ws] site ${site}: rejected duplicate page for account ${msg.accountName || accountId}`);
          return;
        }
        // Same account takeover (or legacy site without account ids): tell the
        // old page it has been replaced so it stands down instead of fighting
        // the new page in an endless reconnect loop.
        if (previousAlive) {
          try {
            previous.ws.send(JSON.stringify({
              type: "superseded",
              site,
              by: {
                contextId: msg.contextId || null,
                accountId: accountId || null,
                accountName: msg.accountName ? String(msg.accountName) : null,
              },
            }));
          } catch {}
        }
        try { previous.ws.close(); } catch {}
        failAllForPeer(site, accountKey, "Userscript superseded by another page");
        log(`[ws] site ${site}: previous peer superseded by ${msg.accountName || msg.contextId || "new peer"}`);
      }
      registeredSite = site;
      registeredAccountKey = accountKey;
      peers.set(accountKey, {
        ws,
        version: msg.version || null,
        contextId: msg.contextId || null,
        accountId: accountId || null,
        accountName: msg.accountName ? String(msg.accountName) : null,
        lastSeenAt: Date.now(),
      });
      log(`[ws] site registered: ${site}${accountId ? ` account=${msg.accountName || accountId}` : ""} v${msg.version || "?"}`);
      try { ws.send(JSON.stringify({ type: "hello_ack", site })); } catch {}
      return;
    }

    if (msg.type === "session_update") {
      const site = String(msg.site || registeredSite || "").trim();
      if (!site) return;
      if (registeredSite && site !== registeredSite) return;
      const accountKey = registeredAccountKey ?? (msg?.data?.accountId ? String(msg.data.accountId) : "");
      const peer = sitePeers.get(site)?.get(accountKey);
      if (peer && peer.ws === ws) {
        peer.lastSeenAt = Date.now();
      }
      upsertSiteSession(site, accountKey, {
        accountId: msg?.data?.accountId,
        accountName: msg?.data?.accountName,
        isLogin: msg?.data?.isLogin,
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
    log(`[ws] closed (site=${registeredSite || "?"}${registeredAccountKey ? ` account=${registeredAccountKey}` : ""})`);
    clearInterval(heartbeat);
    if (registeredSite === null) return;
    const peers = sitePeers.get(registeredSite);
    if (peers?.get(registeredAccountKey)?.ws === ws) {
      peers.delete(registeredAccountKey);
      failAllForPeer(registeredSite, registeredAccountKey, "Userscript disconnected");
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
  for (const [, upload] of activeUploads) {
    try { fs.rmSync(upload.tempPath, { force: true }); } catch {}
  }
  activeUploads.clear();
  siteSessions.clear();
  for (const peers of sitePeers.values()) {
    for (const entry of peers.values()) {
      try { entry.ws.close(); } catch {}
    }
  }
  try { httpServer.close(); } catch {}
  setTimeout(() => process.exit(0), 100);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Suppress noisy `cmdId` lint (intentionally unused in some branches)
void failPending;
