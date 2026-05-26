# mycli

Local browser-bridge CLI. Architecture inspired by [opencli](https://github.com/jackwener/opencli), but the browser side is a **Tampermonkey** userscript instead of a Chrome extension.

```
┌──────┐   HTTP POST /command   ┌────────┐   WebSocket /ws   ┌──────────────┐
│ CLI  │ ─────────────────────► │ daemon │ ────────────────► │ Tampermonkey │
│      │ ◄───────────────────── │        │ ◄──────────────── │  on doubao   │
└──────┘    response            └────────┘   {type:result}   └──────────────┘
```

The daemon (`src/daemon.js`) is a tiny localhost HTTP + WebSocket server. It is auto-spawned the first time you run a `mycli <site> <command>` and stays alive until you stop it (or run `mycli daemon stop`).

## Install

```sh
cd mycli
npm install
npm link        # so `mycli` is on your PATH
```

## Install the Tampermonkey userscript

1. Start the daemon: `mycli daemon start` (or just run any command — it auto-starts).
2. Open this URL in the Chrome profile where Doubao is logged in:

   ```
   http://127.0.0.1:17872/userscript/doubao/mycli.user.js
   ```

   Tampermonkey will prompt to install or update.
3. Open <https://www.doubao.com/> — the top-right status box should say `connected, waiting`.

## Use

```sh
mycli doubao ask --text "3+2 等于多少"
mycli doubao ask --file ./prompts.md > result.md
mycli doubao podcast --file ./material.pdf --out-dir ./audio
```

```sh
mycli daemon start | stop | restart | status | logs
```

## Add a new site

The micro-daemon is site-agnostic. Each userscript registers itself by sending `{type:"hello", site:"<name>"}` and the daemon routes commands keyed by `site`.

To add `mycli <newsite> <cmd>`:

```
clis/
└── newsite/
    ├── index.js           # require('./cmd1.js') etc.
    ├── cmd1.js            # defineCommand({ site:'newsite', name:'cmd1', run({...}) })
    └── userscript.user.js # connects to ws://127.0.0.1:17872/ws and registers site:'newsite'
```

Each Node-side command file:

```js
const { defineCommand } = require("../../src/registry.js");
defineCommand({
  site: "newsite",
  name: "cmd1",
  async run({ options, sendCommand, site }) {
    const result = await sendCommand({ site, action: "cmd1", args: { ... } });
    process.stdout.write(result);
  },
});
```

The userscript receives `{type:"command", id, action, args}` over WS, runs whatever DOM work it needs, and sends back `{type:"result", id, ok, data}` or `{type:"result", id, ok:false, error}`.

## Wire protocol summary

HTTP (CLI ↔ daemon):
- `GET  /ping` — health
- `GET  /status` — pid, uptime, connected sites
- `POST /command` — `{site, action, args, timeout_ms}` → `{ok, result}`
- `POST /shutdown`
- `GET  /userscript/<site>/mycli.user.js` — serve userscript for installation
- `GET  /attachment/<cmd_id>/<idx>` — userscript fetches local file by URL
- `POST /upload?cmd_id=X&filename=Y` — userscript saves a blob to `args.output_dir` (or `~/Downloads`)

WebSocket (daemon ↔ userscript at `/ws`):
- `→ {type:"hello", site, version, contextId}`
- `← {type:"hello_ack", site}`
- `← {type:"command", id, action, args}`
- `→ {type:"result", id, ok:true, data}` or `{type:"result", id, ok:false, error}`
- `→ {type:"log", level, msg}` (optional)
- ping/pong heartbeat every 15s

## State

PID file and log live in `~/.mycli/`.
