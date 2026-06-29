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

function postJson(port, reqPath, obj) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(obj));
    const req = http.request(
      { host: "127.0.0.1", port, path: reqPath, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": data.length } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// Sign in (dev-login, non-prod only) and return a connected, AUTHENTICATED client
// — required for hosting a room. Each call uses a distinct account by default.
let devUserSeq = 0;
async function authedClient(email) {
  const who = email || `host${++devUserSeq}@test.dev`;
  const res = await postJson(PORT, "/auth/dev-login", { email: who });
  if (!res.body?.ok) throw new Error("dev-login failed: " + JSON.stringify(res.body));
  const c = new IOClient(PORT, res.body.token);
  await c.connect();
  return c;
}

// Minimal Socket.IO v4 client: just enough of the protocol to connect, emit
// events with acknowledgement callbacks, and listen for server-pushed events.
class IOClient {
  constructor(port, token) {
    this.port = port;
    this.authToken = token || null; // session token → carried in the SIO CONNECT packet
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
    // engine open → SIO connect, attaching auth so the server populates handshake.auth
    if (eio === "0") { this.ws.send("40" + (this.authToken ? JSON.stringify({ token: this.authToken }) : "")); return; }
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
  env.REQUIRE_HOST_AUTH = "true"; // enforce host-auth so the auth tests are meaningful
  server = spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
  await waitForHealth(PORT);
});
after(() => { if (server) server.kill("SIGKILL"); });

// The regression: with a single guesser, the round must end the INSTANT they
// exhaust their guesses — never wait for the round timer (60s here).
test("round ends immediately when the lone guesser runs out of guesses", async () => {
  const host = await authedClient(); // hosting requires a signed-in account
  const guesser = new IOClient(PORT);
  await guesser.connect();

  const created = await host.emit("room:create", { name: "Hostplayer", roundTime: 60 });
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
  const host = await authedClient(); // hosting requires a signed-in account
  const guesser = new IOClient(PORT);
  await guesser.connect();

  const created = await host.emit("room:create", { name: "Hosttwo", roundTime: 60 });
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
  const host = await authedClient(); // hosting requires a signed-in account
  const guesser = new IOClient(PORT);
  await guesser.connect();

  const created = await host.emit("room:create", { name: "Hostthree", roundTime: 60 });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A returning player can re-enter a game IN PROGRESS using only the room key +
// their name (no session token), reclaiming their disconnected slot — board,
// score, and chooser turn intact. Brand-new names are turned away mid-game.
test("a returning player rejoins a live game by name and gets their board back", async () => {
  const host = await authedClient(); // hosting requires a signed-in account
  const guesser = new IOClient(PORT);
  const other = new IOClient(PORT); // 3rd player keeps the game alive after a drop
  await guesser.connect();
  await other.connect();

  const created = await host.emit("room:create", { name: "Hostfour", roundTime: 60 });
  assert.ok(created.ok, created.error);
  const code = created.room.code;
  const joined = await guesser.emit("room:join", { code, name: "Returner" });
  assert.ok(joined.ok, joined.error);
  const otherJoin = await other.emit("room:join", { code, name: "Stayer" });
  assert.ok(otherJoin.ok, otherJoin.error);

  const choosingP = host.once("game:choosingWord");
  await host.emit("game:start", { roundTime: 60 });
  await choosingP;
  await host.emit("game:submitWord", { word: "APPLE", hint: "" });

  // The guesser makes one (wrong) guess, then drops off the network entirely.
  const g = await guesser.emit("game:guess", { guess: "BERRY" });
  assert.ok(g.ok, g.error);
  guesser.close();
  await sleep(300); // let the server register the disconnect (slot kept, inactive)

  // A FRESH socket — no session token — rejoins using just the room key + name.
  const returner = new IOClient(PORT);
  await returner.connect();
  const back = await returner.emit("room:join", { code, name: "Returner" });
  assert.ok(back.ok, back.error);
  assert.ok(back.roundState, "a live round hands back a roundState snapshot");
  assert.equal(back.roundState.guesses.length, 1, "their earlier guess is restored");
  assert.equal(back.roundState.guesses[0].guess, "BERRY");
  assert.equal(back.sessionId, joined.sessionId, "same player slot — session token preserved");

  // A brand-new name is rejected while the game is in progress.
  const stranger = new IOClient(PORT);
  await stranger.connect();
  const denied = await stranger.emit("room:join", { code, name: "Stranger" });
  assert.equal(denied.ok, false, "new players cannot join a game in progress");
  assert.match(denied.error, /in progress/i);

  host.close();
  other.close();
  returner.close();
  stranger.close();
});

// A still-CONNECTED name cannot be hijacked by someone else mid-game.
test("an active player's name cannot be taken over mid-game", async () => {
  const host = await authedClient(); // hosting requires a signed-in account
  const guesser = new IOClient(PORT);
  await guesser.connect();

  const created = await host.emit("room:create", { name: "Hostfive", roundTime: 60 });
  assert.ok(created.ok, created.error);
  const code = created.room.code;
  const joined = await guesser.emit("room:join", { code, name: "Active" });
  assert.ok(joined.ok, joined.error);

  const choosingP = host.once("game:choosingWord");
  await host.emit("game:start", { roundTime: 60 });
  await choosingP;
  await host.emit("game:submitWord", { word: "APPLE", hint: "" });

  // "Active" is still connected — an impostor with the same name is refused.
  const impostor = new IOClient(PORT);
  await impostor.connect();
  const denied = await impostor.emit("room:join", { code, name: "Active" });
  assert.equal(denied.ok, false, "cannot reclaim a slot that's still online");
  assert.match(denied.error, /already active/i);

  host.close();
  guesser.close();
  impostor.close();
});

// ── Auth: hosting requires a signed-in account; joining does not ──────────────

test("creating a room without signing in is rejected (needAuth)", async () => {
  const guest = new IOClient(PORT); // no token → unauthenticated
  await guest.connect();
  const res = await guest.emit("room:create", { name: "Nobody", roundTime: 60 });
  assert.equal(res.ok, false, "guests cannot host");
  assert.equal(res.needAuth, true, "server flags that auth is needed");
  guest.close();
});

test("a signed-in account can host, and guests can still join without signing in", async () => {
  const host = await authedClient("real@player.dev");
  const created = await host.emit("room:create", { name: "Hostauth", roundTime: 60 });
  assert.ok(created.ok, created.error);
  assert.ok(created.room.code, "room was created by the signed-in host");

  // A guest with no account joins the lobby normally.
  const guest = new IOClient(PORT);
  await guest.connect();
  const joined = await guest.emit("room:join", { code: created.room.code, name: "Guestplayer" });
  assert.ok(joined.ok, joined.error);

  host.close();
  guest.close();
});

test("/auth/me reflects the session, and dev-login issues a working token", async () => {
  const login = await postJson(PORT, "/auth/dev-login", { email: "me@who.dev" });
  assert.ok(login.body.ok);
  assert.ok(login.body.token, "dev-login returns a session token");
  assert.equal(login.body.user.email, "me@who.dev");
});

// With no email provider configured (and no explicit override), hosting is OPEN so
// the rest of the app stays usable while email is still being set up. This runs on
// its own server instance so the shared (auth-enforced) one is untouched.
test("hosting is open when no email provider is configured", async () => {
  const port = 3991;
  const env = { ...process.env, NODE_ENV: "development", PORT: String(port) };
  delete env.MW_API_KEY;
  delete env.REQUIRE_HOST_AUTH;  // rely on the default
  delete env.RESEND_API_KEY;
  delete env.SMTP_HOST;          // → no mail configured → auth not required
  const srv = spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await waitForHealth(port);
    const guest = new IOClient(port); // no token at all
    await guest.connect();
    const res = await guest.emit("room:create", { name: "Soloplayer", roundTime: 60 });
    assert.ok(res.ok, "a guest can host when auth isn't required yet");
    assert.ok(res.room.code, "room created without signing in");

    const me = JSON.parse((await get(port, "/auth/me")).body);
    assert.equal(me.authRequired, false, "/auth/me advertises that hosting is open");
    guest.close();
  } finally {
    srv.kill("SIGKILL");
  }
});
