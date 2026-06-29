// ── Authentication: passwordless email magic-link + sessions ─────────────────
// Hosting a room requires a signed-in account; joining never does. Sign-in is
// passwordless: the user requests a one-time link by email, clicking it mints a
// long-lived session cookie. Storage is Redis when REDIS_URL is set (so accounts
// and sessions survive restarts), otherwise an in-memory fallback with manual TTL
// (fine for local/dev — accounts reset on restart).
//
// Google sign-in is intentionally left as a UI placeholder for now; this module
// is structured so a Google ID-token verification route can slot in later.
const crypto = require("crypto");

const MAGIC_TTL_SEC = 15 * 60;            // one-time link valid for 15 minutes
const SESSION_TTL_SEC = 30 * 24 * 3600;   // session cookie lives 30 days

function makeToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}
function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}
function isValidEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

module.exports = function setupAuth({ app, express, redis, logEvent, isProd, sendMail, requireHostAuth = true, cookieName = "ww_session" }) {
  // ── Storage: Redis when available, else in-memory with manual expiry ──────────
  const mem = { users: new Map(), magic: new Map(), sessions: new Map() };
  function memSet(bucket, key, val, ttlSec) {
    mem[bucket].set(key, { val, exp: ttlSec === Infinity ? Infinity : Date.now() + ttlSec * 1000 });
  }
  function memGet(bucket, key) {
    const e = mem[bucket].get(key);
    if (!e) return null;
    if (e.exp <= Date.now()) { mem[bucket].delete(key); return null; }
    return e.val;
  }
  if (!redis) {
    // Periodic sweep so expired in-memory tokens don't pile up.
    setInterval(() => {
      const now = Date.now();
      for (const bucket of Object.values(mem)) {
        for (const [k, v] of bucket) if (v.exp <= now) bucket.delete(k);
      }
    }, 60_000).unref();
  }

  async function ensureUser(email) {
    if (redis) {
      const existing = await redis.get(`ww:user:${email}`);
      if (existing) return JSON.parse(existing);
      const user = { email, createdAt: new Date().toISOString() };
      await redis.set(`ww:user:${email}`, JSON.stringify(user));
      return user;
    }
    const found = memGet("users", email);
    if (found) return found;
    const user = { email, createdAt: new Date().toISOString() };
    memSet("users", email, user, Infinity);
    return user;
  }
  async function getUser(email) {
    if (redis) { const u = await redis.get(`ww:user:${email}`); return u ? JSON.parse(u) : null; }
    return memGet("users", email);
  }
  async function putMagic(token, email) {
    if (redis) return redis.set(`ww:magic:${token}`, email, "EX", MAGIC_TTL_SEC);
    memSet("magic", token, email, MAGIC_TTL_SEC);
  }
  async function consumeMagic(token) { // single-use
    if (redis) {
      const email = await redis.get(`ww:magic:${token}`);
      if (email) await redis.del(`ww:magic:${token}`);
      return email;
    }
    const email = memGet("magic", token);
    if (email) mem.magic.delete(token);
    return email;
  }
  async function putSession(token, email) {
    if (redis) return redis.set(`ww:session:${token}`, email, "EX", SESSION_TTL_SEC);
    memSet("sessions", token, email, SESSION_TTL_SEC);
  }
  async function getSessionEmail(token) {
    if (redis) return redis.get(`ww:session:${token}`);
    return memGet("sessions", token);
  }
  async function delSession(token) {
    if (redis) return redis.del(`ww:session:${token}`);
    mem.sessions.delete(token);
  }

  // ── Cookies ──────────────────────────────────────────────────────────────────
  function parseCookies(header) {
    const out = {};
    (header || "").split(";").forEach((part) => {
      const i = part.indexOf("=");
      if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    });
    return out;
  }
  function setSessionCookie(res, token) {
    const parts = [`${cookieName}=${token}`, "HttpOnly", "Path=/", `Max-Age=${SESSION_TTL_SEC}`, "SameSite=Lax"];
    if (isProd) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  }
  function clearSessionCookie(res) {
    const parts = [`${cookieName}=`, "HttpOnly", "Path=/", "Max-Age=0", "SameSite=Lax"];
    if (isProd) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  }

  function baseUrl(req) {
    if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
    return `${req.protocol}://${req.get("host")}`;
  }

  // Resolve the current user from a session token (cookie or socket auth payload).
  async function userFromToken(token) {
    if (!token) return null;
    const email = await getSessionEmail(token);
    if (!email) return null;
    return (await getUser(email)) || { email };
  }
  async function userFromReq(req) {
    return userFromToken(parseCookies(req.headers.cookie)[cookieName]);
  }

  // ── Routes ───────────────────────────────────────────────────────────────────
  // Request a one-time sign-in link.
  app.post("/auth/request-link", express.json(), async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ ok: false, error: "Enter a valid email address." });
    }
    const token = makeToken();
    await putMagic(token, email);
    const link = `${baseUrl(req)}/auth/verify?token=${token}`;

    let emailed = false;
    try {
      emailed = await sendMail(
        email,
        "Your WordWars sign-in link",
        magicEmailHtml(link)
      );
    } catch (err) {
      logEvent("error", "magic_email_failed", { message: err && err.message });
    }
    if (!emailed) logEvent(isProd ? "error" : "info", "magic_link", { email, link: isProd ? "[hidden]" : link });

    const body = { ok: true, emailed };
    // Dev convenience only: surface the link so local testing works without SMTP.
    if (!isProd) body.devLink = link;
    res.json(body);
  });

  // Click the emailed link → mint a session and land back in the app signed in.
  app.get("/auth/verify", async (req, res) => {
    const email = await consumeMagic(String(req.query.token || ""));
    if (!email) {
      return res.status(400).send(simplePage(
        "Link expired",
        "This sign-in link is invalid or has already been used. Head back and request a new one."
      ));
    }
    await ensureUser(email);
    const session = makeToken();
    await putSession(session, email);
    setSessionCookie(res, session);
    res.redirect("/?signedin=1");
  });

  // Who am I? Used by the client on load to render signed-in state. authRequired
  // tells the client whether hosting needs sign-in (so it can skip the gate while
  // email isn't configured yet).
  app.get("/auth/me", async (req, res) => {
    const user = await userFromReq(req);
    res.json({ user: user ? { email: user.email } : null, authRequired: requireHostAuth });
  });

  app.post("/auth/logout", async (req, res) => {
    const token = parseCookies(req.headers.cookie)[cookieName];
    if (token) await delSession(token);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // Dev/test only: instant sign-in without email. NEVER mounted in production.
  if (!isProd) {
    app.post("/auth/dev-login", express.json(), async (req, res) => {
      const email = normalizeEmail(req.body?.email) || "dev@local.test";
      if (!isValidEmail(email)) return res.status(400).json({ ok: false, error: "bad email" });
      await ensureUser(email);
      const session = makeToken();
      await putSession(session, email);
      setSessionCookie(res, session);
      res.json({ ok: true, token: session, user: { email } });
    });
  }

  return { userFromToken, userFromReq, parseCookies, cookieName };
};

function magicEmailHtml(link) {
  return `
  <div style="font-family:system-ui,Segoe UI,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111">
    <h2 style="margin:0 0 8px">Sign in to WordWars</h2>
    <p style="color:#555;margin:0 0 20px">Click the button below to sign in. This link works once and expires in 15 minutes.</p>
    <p style="margin:0 0 24px">
      <a href="${link}" style="display:inline-block;background:#6c4cff;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700">Sign in to WordWars</a>
    </p>
    <p style="color:#888;font-size:13px;margin:0">If you didn't request this, you can safely ignore this email.</p>
  </div>`;
}

function simplePage(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title></head>
  <body style="font-family:system-ui,sans-serif;background:#0e0e12;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
    <div style="max-width:420px;text-align:center;padding:32px">
      <h1 style="margin:0 0 12px">${escapeHtml(title)}</h1>
      <p style="color:#aaa;margin:0 0 24px">${escapeHtml(message)}</p>
      <a href="/" style="display:inline-block;background:#6c4cff;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700">Back to WordWars</a>
    </div>
  </body></html>`;
}
