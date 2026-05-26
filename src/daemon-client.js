const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { API, HOST, PORT, STATE_DIR, PID_PATH, LOG_PATH } = require("./constants.js");

const DAEMON_SCRIPT = path.resolve(__dirname, "daemon.js");

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_PATH, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function ping(timeoutMs = 1000) {
  try {
    const res = await fetchWithTimeout(`${API}/ping`, {}, timeoutMs);
    return res.ok;
  } catch {
    return false;
  }
}

async function status(timeoutMs = 1500) {
  try {
    const res = await fetchWithTimeout(`${API}/status`, {}, timeoutMs);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function waitForReady(timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await ping(700)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function ensureDaemon() {
  if (await ping()) return { spawned: false };

  ensureStateDir();
  const stalePid = readPid();
  if (stalePid && !isPidRunning(stalePid)) {
    try { fs.rmSync(PID_PATH, { force: true }); } catch {}
  }

  const logFd = fs.openSync(LOG_PATH, "a");
  const child = spawn(process.execPath, [DAEMON_SCRIPT], {
    cwd: path.resolve(__dirname, ".."),
    detached: true,
    env: { ...process.env, MYCLI_DAEMON_PORT: String(PORT) },
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.writeFileSync(PID_PATH, `${child.pid}\n`);

  const ok = await waitForReady();
  if (!ok) throw new Error(`Daemon did not become ready. Check ${LOG_PATH}`);
  return { spawned: true, pid: child.pid };
}

async function shutdownDaemon() {
  if (!(await ping())) {
    const pid = readPid();
    if (pid && isPidRunning(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    try { fs.rmSync(PID_PATH, { force: true }); } catch {}
    return { wasRunning: false };
  }
  try {
    await fetch(`${API}/shutdown`, { method: "POST" });
  } catch {}
  try { fs.rmSync(PID_PATH, { force: true }); } catch {}
  return { wasRunning: true };
}

async function sendCommand({ site, action, args = {}, timeoutMs }) {
  await ensureDaemon();
  const body = JSON.stringify({ site, action, args, timeout_ms: timeoutMs });
  // CLI-side fetch has no hard timeout — daemon enforces it and returns 502 on timeout.
  const res = await fetch(`${API}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new Error(`Daemon returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${res.status}`);
  }
  return payload.result;
}

module.exports = {
  API,
  HOST,
  PORT,
  LOG_PATH,
  PID_PATH,
  ping,
  status,
  ensureDaemon,
  shutdownDaemon,
  sendCommand,
  readPid,
  isPidRunning,
};
