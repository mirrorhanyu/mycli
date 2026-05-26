const os = require("node:os");
const path = require("node:path");

const HOST = "127.0.0.1";
const PORT = Number(process.env.MYCLI_DAEMON_PORT || 17872);
const API = `http://${HOST}:${PORT}`;
const WS_PATH = "/ws";
const STATE_DIR = path.join(os.homedir(), ".mycli");
const PID_PATH = path.join(STATE_DIR, "daemon.pid");
const LOG_PATH = path.join(STATE_DIR, "daemon.log");

module.exports = { HOST, PORT, API, WS_PATH, STATE_DIR, PID_PATH, LOG_PATH };
