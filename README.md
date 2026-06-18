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
mycli doubao ask --text "按顺序识别这些图片" --attach ./7.png --attach ./8.png --attach ./9.png
mycli doubao read --file ./file.md --out-dir ./audio
mycli doubao podcast --file ./material.pdf --out-dir ./audio
mycli bilibili recent 402626075 123456789 --days 7 --limit 3
mycli bilibili sell 稿件/20260608-122739/bilibili.json
mycli bilibili sell 稿件/20260608-122739/bilibili.json --force
node scripts/generate_bilibili_comment_md.js --bilibili-json /path/to/bilibili.json --hyperframe-input /path/to/hyperframe-input.json
```

For `mycli doubao ask`:
- `--file` means "read the prompt text from this file".
- `--attach` / `--attachment` adds an attachment and can be repeated.
- Attachment order follows the command-line order exactly.

```sh
mycli daemon start | stop | restart | status | logs
```

## Add a new site

The micro-daemon is site-agnostic. Each userscript registers itself by sending `{type:"hello", site:"<name>"}` and the daemon routes commands keyed by `site`. A hello may also carry `accountId`/`accountName`; sites that report accounts get one connected page per account (see the Bilibili section), while sites that don't keep the legacy single-page slot.

To add `mycli <newsite> <cmd>`:

```
clis/
└── newsite/
    ├── index.js           # require('./cmd1.js') etc.
    ├── cmd1.js            # defineCommand({ site:'newsite', name:'cmd1', run({...}) })
    └── userscript.user.js # connects to ws://127.0.0.1:17872/ws and registers site:'newsite'
```

### Bilibili site

`mycli bilibili recent` looks up recent uploads for one or more mids inside a browser session that is already logged in to Bilibili. `mycli bilibili sell <json>` uploads commerce items from a JSON file and rewrites compact fields such as `bilibili_short_url` in place. By default it skips rows that already have `sell_status: "ok"` unless you pass `--force`. Open the Bilibili account page you want to bind first, then install the userscript:

```sh
open http://127.0.0.1:17872/userscript/bilibili/mycli.user.js
```

After installation, the status box shows the current page account name and the locked account name. Use `切换为<账号>` to bind the page you want to control, or `退出<账号>` to release it.

Multiple accounts can stay connected at the same time (one page per account — e.g. two browser profiles each logged in to a different Bilibili account). Pages of *different* accounts never kick each other. If two pages are logged in to the *same* account, the first one keeps serving and later ones stand by (`本页待命`); click `在本页接管` to move the connection over explicitly.

With more than one account connected, pass `--account <昵称|mid>` to choose which page runs the command:

```sh
mycli bilibili sell items.json --account 某账号昵称
mycli bilibili recent 402626075 --account 12345678
```

Without `--account`, commands run on the only connected account, or fail with a list of connected accounts when there are several. `mycli daemon status` shows which accounts are connected.

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
- `POST /command` — `{site, account?, action, args, timeout_ms}` → `{ok, result}`; `account` matches the userscript-reported account id or name when several accounts are connected for one site
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
