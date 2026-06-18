const { test, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { WebSocket } = require("ws");

const PORT = 18000 + (process.pid % 1000);
const API = `http://127.0.0.1:${PORT}`;
const DAEMON = path.resolve(__dirname, "..", "src", "daemon.js");

let child = null;

async function ping() {
  try {
    const res = await fetch(`${API}/ping`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(fn, timeoutMs = 5000, label = "condition") {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// Minimal fake userscript peer: connects, says hello, queues incoming messages.
function openPeer({ site, accountId, accountName, takeover }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const queue = [];
    const waiters = [];
    let closed = false;

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else queue.push(msg);
    });
    ws.on("close", () => { closed = true; });
    ws.on("error", reject);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "hello",
        site,
        version: "test",
        contextId: `tab-${accountId || site}-${Math.random().toString(16).slice(2)}`,
        accountId,
        accountName,
        takeover,
      }));
      resolve({
        ws,
        next(timeoutMs = 3000) {
          if (queue.length) return Promise.resolve(queue.shift());
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error("Timed out waiting for ws message")), timeoutMs);
            waiters.push((msg) => { clearTimeout(timer); res(msg); });
          });
        },
        isClosed: () => closed,
        replyTo(handler) {
          ws.on("message", (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type !== "command") return;
            ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: handler(msg) }));
          });
        },
      });
    });
  });
}

async function sendCommand(body) {
  const res = await fetch(`${API}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ timeout_ms: 3000, ...body }),
  });
  return res.json();
}

before(async () => {
  child = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, MYCLI_DAEMON_PORT: String(PORT) },
    stdio: "ignore",
  });
  await waitFor(ping, 5000, "daemon ping");
});

after(async () => {
  try { await fetch(`${API}/shutdown`, { method: "POST" }); } catch {}
  if (child) {
    await new Promise((resolve) => {
      child.on("exit", resolve);
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 2000);
    });
  }
});

test("different accounts on the same site coexist", async () => {
  const alice = await openPeer({ site: "bilibili", accountId: "111", accountName: "alice" });
  const bob = await openPeer({ site: "bilibili", accountId: "222", accountName: "bob" });
  assert.strictEqual((await alice.next()).type, "hello_ack");
  assert.strictEqual((await bob.next()).type, "hello_ack");

  alice.replyTo(() => ({ from: "alice" }));
  bob.replyTo(() => ({ from: "bob" }));

  const status = await (await fetch(`${API}/status`)).json();
  const bilibili = status.sites.filter((s) => s.site === "bilibili");
  assert.strictEqual(bilibili.length, 2);
  assert.ok(!alice.isClosed() && !bob.isClosed(), "neither peer was kicked");

  // Ambiguous dispatch must error instead of picking a random account.
  const ambiguous = await sendCommand({ site: "bilibili", action: "noop", args: {} });
  assert.strictEqual(ambiguous.ok, false);
  assert.match(ambiguous.error, /Multiple accounts/);

  // Account-addressed dispatch routes to the matching peer (by name or id).
  const viaName = await sendCommand({ site: "bilibili", account: "bob", action: "noop", args: {} });
  assert.deepStrictEqual(viaName.result, { from: "bob" });
  const viaId = await sendCommand({ site: "bilibili", account: "111", action: "noop", args: {} });
  assert.deepStrictEqual(viaId.result, { from: "alice" });

  const missing = await sendCommand({ site: "bilibili", account: "nobody", action: "noop", args: {} });
  assert.strictEqual(missing.ok, false);
  assert.match(missing.error, /No connected page for account "nobody"/);
});

test("duplicate page for the same account is rejected, takeover supersedes", async () => {
  // Same account as the already-connected alice, no takeover: rejected.
  const dupe = await openPeer({ site: "bilibili", accountId: "111", accountName: "alice" });
  const rejected = await dupe.next();
  assert.strictEqual(rejected.type, "hello_rejected");
  assert.strictEqual(rejected.reason, "account_in_use");
  await waitFor(() => dupe.isClosed(), 3000, "rejected peer close");

  // Original alice still serves the account.
  const beforeTakeover = await sendCommand({ site: "bilibili", account: "alice", action: "noop", args: {} });
  assert.deepStrictEqual(beforeTakeover.result, { from: "alice" });

  // Explicit takeover replaces the old page and routes commands to it.
  const alice2 = await openPeer({ site: "bilibili", accountId: "111", accountName: "alice", takeover: true });
  const first = await alice2.next();
  assert.strictEqual(first.type, "hello_ack");
  alice2.replyTo(() => ({ from: "alice2" }));
  const afterTakeover = await sendCommand({ site: "bilibili", account: "alice", action: "noop", args: {} });
  assert.deepStrictEqual(afterTakeover.result, { from: "alice2" });
});

test("legacy sites without account ids keep last-writer-wins", async () => {
  const tab1 = await openPeer({ site: "toutiao" });
  assert.strictEqual((await tab1.next()).type, "hello_ack");
  const tab2 = await openPeer({ site: "toutiao" });
  assert.strictEqual((await tab2.next()).type, "hello_ack");
  const superseded = await tab1.next();
  assert.strictEqual(superseded.type, "superseded");
  await waitFor(() => tab1.isClosed(), 3000, "superseded legacy peer close");
});
