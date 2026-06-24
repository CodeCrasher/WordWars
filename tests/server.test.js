// Smoke tests using Node's built-in test runner (node --test). No extra deps.
// The server is spawned as a child process; we probe it over HTTP.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const SERVER = path.join(__dirname, "..", "server.js");
const MAIN_PORT = 3987;

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

// Spawn the server with a deterministic env: development mode (so a missing
// MW_API_KEY warns instead of exiting) and no MW key unless explicitly provided.
function spawnServer(extraEnv = {}) {
  const env = { ...process.env, NODE_ENV: "development", PORT: String(MAIN_PORT) };
  delete env.MW_API_KEY;
  Object.assign(env, extraEnv);
  return spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
}

let server;
before(async () => {
  server = spawnServer({ PORT: String(MAIN_PORT) });
  await waitForHealth(MAIN_PORT);
});
after(() => {
  if (server) server.kill("SIGKILL");
});

test("GET /health returns 200 with status ok and a numeric uptime", async () => {
  const r = await get(MAIN_PORT, "/health");
  assert.equal(r.status, 200);
  const json = JSON.parse(r.body);
  assert.equal(json.status, "ok");
  assert.equal(typeof json.uptime, "number");
});

test("Socket.io engine handshake succeeds (a client can connect)", async () => {
  // This is exactly the first request a Socket.io client makes; a 200 with a
  // session id proves the realtime layer is mounted and accepting connections.
  const r = await get(MAIN_PORT, "/socket.io/?EIO=4&transport=polling");
  assert.equal(r.status, 200);
  assert.match(r.body, /"sid"/);
});

test("missing MW_API_KEY logs a structured warning in development", async () => {
  const child = spawnServer({ PORT: "3988" });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  try {
    await waitForHealth(3988);
    await new Promise((r) => setTimeout(r, 200)); // let startup logs flush
    assert.match(out, /missing_mw_api_key/);
  } finally {
    child.kill("SIGKILL");
  }
});
