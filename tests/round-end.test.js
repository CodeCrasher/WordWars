// Integration test for round-end timing (regression for the "round hangs on the
// timer after the lone guesser is done" bug). Drives the real server over a
// minimal hand-rolled Socket.IO v4 client built on `ws` (a transitive dep of
// socket.io — no new packages). The server is spawned WITHOUT an MW_API_KEY, so
// word/guess validation fails open and any 5-letter string is accepted offline.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const WebSocket = require("ws");

const SERVER = path.join(__dirname, "..", "server.js");
const PORT = 3990;
const ADMIN_PIN = "1234"; // server default when ADMIN_PIN is unset

function get(port, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: reqPath }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("request timeout")));
  });
}

async function waitForHealth(port, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await get(port, "/health");
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server on port ${port} did not become healthy in time`);
}

// Minimal Socket.IO v4 client: just enough of the protocol to connect, emit
// events with acknowledgement callbacks, and listen for server-pushed events.
class IOClient {
  constructor(port) {
    this.port = port;
    this.ackId = 0;
    this.acks = new Map();
    this.handlers = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/socket.io/?EIO=4&transport=websocket`);
      this.ws.on("error", reject);
      this.ws.on("message", (data) => this._onMessage(data.toString(), resolve));
    });
  }

  _onMessage(msg, onConnect) {
    const eio = msg[0];
    if (eio === "0") { this.ws.send("40"); return; } // engine open → SIO connect
    if (eio === "2") { this.ws.send("3"); return; }  // ping → pong
    if (eio !== "4") return;                          // only message packets matter

    const sio = msg[1];
    const rest = msg.slice(2);
    if (sio === "0") { onConnect?.(this); return; }   // SIO CONNECT acknowledged
    if (sio === "2") {                                 // EVENT
      const payload = JSON.parse(rest.slice(rest.indexOf("[")));
      const [event, ...args] = payload;
      (this.handlers.get(event) || []).slice().forEach((h) => h(...args));
    } else if (sio === "3") {                          // ACK (server callback reply)
      const br = rest.indexOf("[");
      const id = Number(rest.slice(0, br));
      const payload = JSON.parse(rest.slice(br));
      const cb = this.acks.get(id);
      if (cb) { this.acks.delete(id); cb(...payload); }
    }
  }

  emit(event, arg) {
    return new Promise((resolve) => {
      const id = this.ackId++;
      this.acks.set(id, resolve);
      const body = JSON.stringify(arg === undefined ? [event] : [event, arg]);
      this.ws.send(`42${id}${body}`);
    });
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
  }

  once(event, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
      const h = (...args) => {
        clearTimeout(timer);
        const arr = this.handlers.get(event);
        arr.splice(arr.indexOf(h), 1);
        resolve(args.length <= 1 ? args[0] : args);
      };
      this.on(event, h);
    });
  }

  close() { try { this.ws?.close(); } catch { /* ignore */ } }
}

let server;
before(async () => {
  const env = { ...process.env, NODE_ENV: "development", PORT: String(PORT) };
  delete env.MW_API_KEY; // force fail-open validation so the test runs offline
  server = spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
  await waitForHealth(PORT);
});
after(() => { if (server) server.kill("SIGKILL"); });

// The regression: with a single guesser, the round must end the INSTANT they
// exhaust their guesses — never wait for the round timer (60s here).
test("round ends immediately when the lone guesser runs out of guesses", async () => {
  const host = new IOClient(PORT);
  const guesser = new IOClient(PORT);
  await host.connect();
  await guesser.connect();

  const created = await host.emit("room:create", { pin: ADMIN_PIN, name: "Hostplayer", roundTime: 60 });
  assert.ok(created.ok, created.error);
  const code = created.room.code;

  const joined = await guesser.emit("room:join", { code, name: "Guesserone" });
  assert.ok(joined.ok, joined.error);

  // Listen for the round end on the guesser before triggering anything.
  const roundEndP = guesser.once("game:roundEnd");

  // Host starts the session and is the first chooser (first in player order).
  const choosingP = host.once("game:choosingWord");
  const started = await host.emit("game:start", { roundTime: 60 });
  assert.ok(started.ok, started.error);
  const choosing = await choosingP;
  assert.equal(choosing.chooserId, created.playerId, "host should be the first chooser");

  const submit = await host.emit("game:submitWord", { word: "APPLE", hint: "" });
  assert.ok(submit.ok, submit.error);

  // The sole guesser burns all six guesses without ever solving.
  for (let i = 0; i < 6; i++) {
    const r = await guesser.emit("game:guess", { guess: "BERRY" });
    assert.ok(r.ok, r.error);
    assert.equal(r.solved, false);
  }

  // Round must already be ending — well before the 60s timer. If the old bug
  // were present, this would reject with a timeout.
  const end = await roundEndP;
  assert.equal(end.reason, "all-finished", "reason should reflect not-everyone-solved");
  assert.equal(end.word, "APPLE");

  host.close();
  guesser.close();
});

// Sanity counterpart: when the lone guesser SOLVES, the round still ends at once
// and the reason is the happier "all-solved".
test("round ends immediately (all-solved) when the lone guesser solves", async () => {
  const host = new IOClient(PORT);
  const guesser = new IOClient(PORT);
  await host.connect();
  await guesser.connect();

  const created = await host.emit("room:create", { pin: ADMIN_PIN, name: "Hosttwo", roundTime: 60 });
  assert.ok(created.ok, created.error);
  const joined = await guesser.emit("room:join", { code: created.room.code, name: "Guessertwo" });
  assert.ok(joined.ok, joined.error);

  const roundEndP = guesser.once("game:roundEnd");
  const choosingP = host.once("game:choosingWord");
  await host.emit("game:start", { roundTime: 60 });
  await choosingP;
  await host.emit("game:submitWord", { word: "APPLE", hint: "" });

  const r = await guesser.emit("game:guess", { guess: "APPLE" });
  assert.ok(r.ok, r.error);
  assert.equal(r.solved, true);

  const end = await roundEndP;
  assert.equal(end.reason, "all-solved");

  host.close();
  guesser.close();
});

// The word-picker (and anyone already done) must be able to see WHO used a hint.
// The progress feed carries a usedHint flag — and revealing a hint broadcasts an
// immediate progress update so the picker sees it without waiting for a guess.
// The hint TEXT must never leak to anyone but the player who revealed it.
test("hint usage is visible to the word-picker via the progress feed (text never leaks)", async () => {
  const host = new IOClient(PORT);
  const guesser = new IOClient(PORT);
  await host.connect();
  await guesser.connect();

  const created = await host.emit("room:create", { pin: ADMIN_PIN, name: "Hostthree", roundTime: 60 });
  assert.ok(created.ok, created.error);
  const joined = await guesser.emit("room:join", { code: created.room.code, name: "Guesserthree" });
  assert.ok(joined.ok, joined.error);

  const choosingP = host.once("game:choosingWord");
  await host.emit("game:start", { roundTime: 60 });
  await choosingP;
  // Submit a word WITH a hint so it can be revealed.
  await host.emit("game:submitWord", { word: "APPLE", hint: "a common fruit" });

  // The picker should receive a progress update the moment the guesser reveals.
  const progressP = host.once("game:guessProgress");
  const hintResp = await guesser.emit("game:useHint", {});
  assert.ok(hintResp.ok, "guesser should receive the hint");
  assert.equal(hintResp.hint, "a common fruit", "revealing player gets the hint text");

  const { progress } = await progressP;
  const guesserRow = progress.find((p) => p.id === joined.playerId);
  assert.ok(guesserRow, "guesser should appear in the picker's progress feed");
  assert.equal(guesserRow.usedHint, true, "picker sees that the guesser used a hint");
  // The flag travels, but never the hint text itself.
  assert.equal("hint" in guesserRow, false, "progress feed must not carry hint text");

  host.close();
  guesser.close();
});
