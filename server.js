const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const Redis = require("ioredis");

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";

// ── Structured logging ──────────────────────────────────────────────────────
// One JSON object per line so Railway's log tail stays grep/parse-friendly.
function logEvent(level, event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error" || level === "fatal") console.error(line);
  else console.log(line);
}

// Process-level safety nets — capture crashes instead of dying silently.
process.on("uncaughtException", (err) => {
  logEvent("error", "uncaught_exception", { message: err && err.message, stack: err && err.stack });
});
process.on("unhandledRejection", (reason) => {
  logEvent("error", "unhandled_rejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason && reason.stack
  });
});

const ROOM_EXPIRY_MS = 2 * 60 * 60 * 1000;
const MAX_PLAYERS = 20;
const MAX_GUESSES = 6;
const WORD_LENGTH = 5;
// Hint cost (server-authoritative, never sent to the client). Revealing the
// chooser's hint subtracts from the guesser's round score. The cost is locked
// in at reveal time and decays as the player keeps battling on their own.
const HINT_PENALTY_BASE = 250; // cost if revealed before any guess
const HINT_PENALTY_STEP = 20;  // cost drops by this for each guess already made
// How long the FINAL round's appreciation + leaderboard stays up before the
// final scoreboard replaces it. Long enough to read the meaning and standings.
const ROUND_END_DELAY = 8000;
// For non-final rounds we don't force everyone off the leaderboard. Instead, once
// the appreciation has played we quietly announce the next chooser so they can
// start picking. Each player leaves the leaderboard on their own — by tapping to
// continue, or automatically the moment the next round actually starts.
const ROUND_REVEAL_DELAY = 4000;

const MW_API_KEY = process.env.MW_API_KEY;
if (!MW_API_KEY) {
  if (IS_PROD) {
    // In production the dictionary key is mandatory — fail fast and loud.
    logEvent("fatal", "missing_mw_api_key", {
      message: "MW_API_KEY is not set. Get a free key at https://dictionaryapi.com/register/index"
    });
    process.exit(1);
  }
  // In development we fail-open: words are accepted unverified and definitions skipped.
  logEvent("warn", "missing_mw_api_key", {
    message: "MW_API_KEY not set — word validation falls back to fail-open. Get a free key at https://dictionaryapi.com/register/index"
  });
}
const wordCache = new Map();
const CACHE_MAX_SIZE = 2000;

// ── Persistence (Redis snapshot/restore) ─────────────────────────────────────
// The in-memory `rooms` Map is the runtime source of truth. Redis is a side
// channel: we snapshot serialized room state on an interval (and on SIGTERM),
// and restore it on boot, so active games survive a Railway redeploy/restart.
// Entirely optional — if REDIS_URL is unset, the server runs in-memory exactly
// as before (and every Redis call is a no-op). Failures never break gameplay.
const REDIS_URL = process.env.REDIS_URL;
const REDIS_STATE_KEY = "wordwars:state";
const SNAPSHOT_INTERVAL_MS = 5000;
let redis = null;
if (REDIS_URL) {
  redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 200, 2000)
  });
  // Handle errors so a Redis outage logs but never crashes the game server.
  redis.on("error", (err) => logEvent("error", "redis_error", { message: err && err.message }));
  redis.on("connect", () => logEvent("info", "redis_connected", {}));
  logEvent("info", "persistence_enabled", { store: "redis" });
} else {
  logEvent("warn", "persistence_disabled", {
    message: "REDIS_URL not set — room state is in-memory only and will not survive a restart/redeploy."
  });
}

// CORS origin policy. In production an explicit ALLOWED_ORIGIN is required; if it
// is missing we fall back to the Railway-provided public domain rather than a
// wildcard, and deny cross-origin entirely if neither is set. In development we
// default to "*" for convenience.
const ALLOWED_ORIGIN = (() => {
  if (!IS_PROD) return process.env.ALLOWED_ORIGIN || "*";
  if (process.env.ALLOWED_ORIGIN) return process.env.ALLOWED_ORIGIN;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    logEvent("warn", "allowed_origin_unset", {
      message: `ALLOWED_ORIGIN not set in production — restricting to RAILWAY_PUBLIC_DOMAIN (${process.env.RAILWAY_PUBLIC_DOMAIN}).`
    });
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  logEvent("warn", "allowed_origin_unset", {
    message: "ALLOWED_ORIGIN and RAILWAY_PUBLIC_DOMAIN both unset in production — denying cross-origin requests."
  });
  return false;
})();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"],
  allowEIO3: true
});
// Runtime source of truth for all room state. Snapshotted to Redis (when
// REDIS_URL is set) so it survives a redeploy/restart; without Redis it is
// in-process only and a redeploy clears it. Reconnects within a live process —
// and after a restore — are handled via the room:rejoin flow.
const rooms = new Map();

// Honour X-Forwarded-Proto/Host behind Railway's proxy so magic-link URLs and
// the Secure cookie flag resolve to https in production.
app.set("trust proxy", 1);

// ── Email delivery for magic-link sign-in ────────────────────────────────────
// Configured via SMTP_* env vars (nodemailer). When SMTP isn't set we can't send
// mail: sendMail returns false and the auth layer falls back to logging the link
// (dev) so local sign-in still works without an email provider.
let mailer = null;
if (process.env.SMTP_HOST) {
  try {
    const nodemailer = require("nodemailer");
    mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
    logEvent("info", "smtp_configured", { host: process.env.SMTP_HOST });
  } catch (err) {
    logEvent("error", "nodemailer_unavailable", { message: err && err.message });
  }
} else {
  logEvent(IS_PROD ? "error" : "warn", "smtp_not_configured", {
    message: "SMTP_HOST not set — magic-link emails cannot be sent. Set SMTP_* env vars to enable email sign-in."
  });
}
async function sendMail(to, subject, html) {
  if (!mailer) return false;
  await mailer.sendMail({
    from: process.env.SMTP_FROM || "WordWars <no-reply@wordwars.app>",
    to, subject, html
  });
  return true;
}

const auth = require("./auth")({
  app, express, redis, logEvent, isProd: IS_PROD, sendMail
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use(express.static(__dirname));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.get("/api/validate-word/:word", async (req, res) => {
  const word = String(req.params.word || "").trim().toUpperCase();
  if (!isFiveLetterWord(word)) return res.json({ valid: false, reason: "not-five-letters" });
  try {
    const valid = await isValidWord(word);
    if (valid === true) return res.json({ valid: true });
    if (valid === false) return res.json({ valid: false, reason: "not-a-common-word" });
    // null → couldn't verify (no key / MW outage). Don't block the user: allow with a notice.
    return res.json({ valid: true, unverified: true, reason: "unverified" });
  } catch {
    res.json({ valid: true, unverified: true, reason: "unverified" });
  }
});

function normalizeWord(word) {
  return String(word || "").trim().toUpperCase();
}

function isFiveLetterWord(word) {
  return /^[A-Z]{5}$/.test(normalizeWord(word));
}

// Single Merriam-Webster lookup that returns BOTH the validity verdict and a
// short definition from ONE request. Doing both in one call (instead of a
// separate validate + define round-trip) means the round-end "meaning" is
// guaranteed to be available to EVERY player whenever the word was accepted —
// and it halves our MW traffic so rate-limits never silently drop the meaning.
//
// Returns { valid, definition } where valid is tri-state:
//   true  → definitely a valid common word
//   false → definitely NOT a word (MW responded, nothing matched) — safe to cache
//   null  → could not verify (no key / HTTP error / network / timeout) — NEVER cached,
//           callers should fail-open so a transient MW outage never blocks play.
// definition is a concise sense string, or "" if none is available.
async function lookupWord(word) {
  if (!MW_API_KEY) return { valid: null, definition: "" };
  const normalized = normalizeWord(word).toLowerCase();
  if (wordCache.has(normalized)) return wordCache.get(normalized);

  try {
    const url = `https://www.dictionaryapi.com/api/v3/references/collegiate/json/${encodeURIComponent(normalized)}?key=${MW_API_KEY}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    // HTTP error (5xx/429/etc.) is an UNKNOWN result — do not cache, fail-open.
    if (!response.ok) { logEvent("error", "mw_api_http_error", { statusCode: response.status, word: normalized }); return { valid: null, definition: "" }; }

    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0 || typeof data[0] === "string") {
      // MW answered definitively: not a known word (data[0] strings are spelling suggestions).
      const result = { valid: false, definition: "" };
      cacheWord(normalized, result);
      return result;
    }

    const REJECTED_LABELS = new Set([
      "biographical name", "geographical name", "trademark",
      "abbreviation", "symbol"
    ]);

    const valid = data.some(entry => {
      if (typeof entry !== "object" || !entry.fl) return false;
      if (REJECTED_LABELS.has(entry.fl.toLowerCase())) return false;
      const hw = entry?.hwi?.hw || "";
      if (hw && hw[0] === hw[0].toUpperCase() && hw[0] !== hw[0].toLowerCase()) return false;
      return true;
    });

    // Pull a concise definition from the same payload so the round-end reveal
    // never needs a second API call.
    const defEntry = data.find(e => typeof e === "object" && Array.isArray(e.shortdef) && e.shortdef.length);
    let definition = defEntry ? String(defEntry.shortdef[0] || "").trim() : "";
    if (definition.length > 160) definition = definition.slice(0, 157).trimEnd() + "…";

    const result = { valid, definition };
    cacheWord(normalized, result);
    return result;

  } catch (err) {
    // Network failure / 5s timeout abort — UNKNOWN, do not cache, fail-open.
    logEvent("error", "mw_api_error", { word: normalized, message: err.message });
    return { valid: null, definition: "" };
  }
}

// Thin wrapper used by the guess path and the /api/validate-word route, which
// only care about the tri-state verdict.
async function isValidWord(word) {
  return (await lookupWord(word)).valid;
}

function cacheWord(key, value) {
  if (wordCache.size > CACHE_MAX_SIZE) wordCache.delete(wordCache.keys().next().value);
  wordCache.set(key, value);
}

function isDisplayName(name) {
  return /^[a-zA-Z0-9]{3,16}$/.test(String(name || "").trim());
}

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

// Normalize a host-chosen room code: uppercase, strip anything that isn't
// a letter or digit (spaces, punctuation, etc.).
function normalizeRoomCode(raw) {
  return String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// A valid custom code is 3–6 letters/digits, so it fits the join field
// (maxlength 6) and is short enough to share verbally.
function isValidCustomCode(code) {
  return /^[A-Z0-9]{3,6}$/.test(code);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function touchRoom(room) {
  room.lastActive = Date.now();
}

function getRoomForSocket(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

function getPublicPlayers(room) {
  return Array.from(room.players.values()).map((player) => ({
    id: player.id,
    name: player.name,
    isHost: player.id === room.hostId,
    isChooser: player.id === room.currentChooserId,
    active: player.active,
    connected: player.connected,
    cumulativeScore: player.cumulativeScore,
    roundScore: player.roundScore,
    solved: player.solved,
    guessesUsed: player.guesses.length
  }));
}

function getRoomSummary(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    roundTime: room.config.roundTime,
    totalRounds: room.config.totalRounds,
    currentRound: room.currentRound,
    hintAvailable: Boolean(room.currentRoundConfig?.hint),
    currentChooserId: room.currentChooserId,
    waitingForWord: room.waitingForWord,
    playerOrder: room.playerOrder || [],
    players: getPublicPlayers(room)
  };
}

function emitPlayers(room, eventName = "room:playerJoined") {
  io.to(room.code).emit(eventName, getRoomSummary(room));
}

function findPlayer(room, socketId) {
  return room.players.get(socketId);
}

function assertHost(socket, room) {
  return room && room.hostId === socket.id;
}

function makePlayer(socket, name, isHost = false) {
  return {
    id: socket.id,
    sessionId: uuidv4(),
    name,
    connected: true,
    active: true,
    isHost,
    cumulativeScore: 0,
    roundScore: 0,
    solved: false,
    solvedAt: null,
    guesses: [],
    breakdown: null,
    usedHint: false,
    hintPenalty: 0
  };
}

function resetRoundPlayerState(room) {
  for (const player of room.players.values()) {
    player.roundScore = 0;
    player.solved = false;
    player.solvedAt = null;
    player.guesses = [];
    player.breakdown = null;
    player.usedHint = false;
    player.hintPenalty = 0;
  }
}

function makeFeedback(guess, answer) {
  const result = Array(WORD_LENGTH).fill("gray");
  const counts = {};

  for (let i = 0; i < WORD_LENGTH; i += 1) {
    if (guess[i] === answer[i]) {
      result[i] = "green";
    } else {
      counts[answer[i]] = (counts[answer[i]] || 0) + 1;
    }
  }

  for (let i = 0; i < WORD_LENGTH; i += 1) {
    if (result[i] === "green") continue;
    if (counts[guess[i]] > 0) {
      result[i] = "yellow";
      counts[guess[i]] -= 1;
    }
  }

  return result;
}

function calculateScore(room, player) {
  const elapsed = Math.max(0, nowSeconds() - room.roundStartedAt);
  const timeRemaining = Math.max(0, room.config.roundTime - elapsed);
  const unusedGuesses = Math.max(0, MAX_GUESSES - player.guesses.length);
  const base = 1000;
  const timeBonus = timeRemaining * 10;
  const guessBonus = unusedGuesses * 50;
  const penalty = player.usedHint ? player.hintPenalty : 0;
  return {
    base,
    timeRemaining,
    timeBonus,
    unusedGuesses,
    guessBonus,
    hintPenalty: penalty,
    score: Math.max(0, base + timeBonus + guessBonus - penalty)
  };
}

/*
 * CHOOSER SCORING — points per guesser per round
 * ─────────────────────────────────────────────
 * Guesser solved in 1 guess   →   0 pts  (too easy)
 * Guesser solved in 2 guesses →  100 pts
 * Guesser solved in 3 guesses →  200 pts
 * Guesser solved in 4 guesses →  300 pts
 * Guesser solved in 5 guesses →  400 pts
 * Guesser solved in 6 guesses →  500 pts
 * Guesser failed entirely     →  500 pts
 * Stump bonus (nobody solved,
 *   2+ guessers)              → +300 pts flat
 * Round cap                   → 1500 pts max
 */
function calculateChooserScore(room) {
  const guessers = Array.from(room.players.values()).filter(
    p => p.id !== room.currentChooserId && p.active
  );
  if (guessers.length === 0) return 0;

  let total = 0;
  for (const g of guessers) {
    total += g.solved
      ? Math.max(0, (g.guesses.length - 1) * 100)
      : 500;
  }

  const nonesolve = guessers.every(g => !g.solved);
  if (nonesolve && guessers.length >= 2) total += 300;

  return Math.min(total, 1500);
}

function getLiveLeaderboard(room) {
  return Array.from(room.players.values())
    .filter((player) => player.solved)
    .sort((a, b) => {
      if (b.roundScore !== a.roundScore) return b.roundScore - a.roundScore;
      return (a.solvedAt || Infinity) - (b.solvedAt || Infinity);
    })
    .map((player) => ({
      id: player.id,
      name: player.name,
      time: player.solvedAt,
      score: player.roundScore,
      guessesUsed: player.guesses.length
    }));
}

function getRoundLeaderboard(room) {
  return Array.from(room.players.values())
    // Rank by CUMULATIVE total (skribbl-style running scoreboard between rounds),
    // tie-broken by this round's score, then solve time, then name.
    .sort((a, b) => {
      if (b.cumulativeScore !== a.cumulativeScore) return b.cumulativeScore - a.cumulativeScore;
      if (b.roundScore !== a.roundScore) return b.roundScore - a.roundScore;
      if ((a.solvedAt || Infinity) !== (b.solvedAt || Infinity)) return (a.solvedAt || Infinity) - (b.solvedAt || Infinity);
      return a.name.localeCompare(b.name);
    })
    .map((player) => ({
      id: player.id,
      name: player.name,
      active: player.active,
      isChooser: player.id === room.currentChooserId,
      solved: player.solved,
      time: player.solvedAt,
      guessesUsed: player.guesses.length,
      score: player.roundScore,
      cumulativeScore: player.cumulativeScore,
      breakdown: player.breakdown || {
        base: 0,
        timeRemaining: 0,
        timeBonus: 0,
        unusedGuesses: 0,
        guessBonus: 0,
        score: 0
      }
    }));
}

function getFinalLeaderboard(room) {
  return Array.from(room.players.values())
    .sort((a, b) => b.cumulativeScore - a.cumulativeScore || a.name.localeCompare(b.name))
    .map((player) => ({
      id: player.id,
      name: player.name,
      active: player.active,
      cumulativeScore: player.cumulativeScore
    }));
}

// Cumulative standings shown on the "waiting while X chooses" screen so idle
// players watch the scoreboard instead of a spinner. Ranked by running total.
function getChoosingStandings(room) {
  return Array.from(room.players.values())
    .filter((p) => p.active)
    .map((p) => ({
      id: p.id,
      name: p.name,
      cumulativeScore: p.cumulativeScore,
      isChooser: p.id === room.currentChooserId,
      connected: p.connected
    }))
    .sort((a, b) => b.cumulativeScore - a.cumulativeScore || a.name.localeCompare(b.name));
}

// Live per-player progress for the CURRENT round (attempt counts + solves), so
// the word-picker (and anyone already done) can watch the race. Letters are
// never included — only how many guesses each player has used. Solved players
// rank first by solve time, then the rest by guesses used.
function getRoundProgress(room) {
  return Array.from(room.players.values())
    .filter((p) => p.active)
    .map((p) => ({
      id: p.id,
      name: p.name,
      isChooser: p.id === room.currentChooserId,
      solved: p.solved,
      guessesUsed: p.guesses.length,
      score: p.roundScore,
      time: p.solvedAt,
      // Who revealed the chooser's hint — visible to the word-picker and to any
      // player already done. Just the boolean; the hint TEXT is never leaked
      // here (only the player who paid for it ever receives the words).
      usedHint: p.usedHint
    }))
    .sort((a, b) => {
      if (a.isChooser !== b.isChooser) return a.isChooser ? 1 : -1; // picker last
      if (a.solved !== b.solved) return a.solved ? -1 : 1;          // solved first
      if (a.solved && b.solved) return (a.time ?? Infinity) - (b.time ?? Infinity);
      if (a.guessesUsed !== b.guessesUsed) return b.guessesUsed - a.guessesUsed;
      return a.name.localeCompare(b.name);
    });
}

// Snapshot of the CURRENT round from one player's perspective, used to rebuild
// their game screen after a hard refresh mid-round. Includes THIS player's own
// guesses + feedback (so the board can be redrawn) plus their solved/hint state.
// Only the player's own letters are ever sent — never the secret word, and never
// another player's guesses. The hint text rides along only if this player has
// already revealed it, so a refresh neither re-charges the penalty nor leaks the
// hint for free.
function getActiveRoundSnapshot(room, player) {
  const chooser = room.players.get(room.currentChooserId);
  return {
    wordLength: WORD_LENGTH,
    maxGuesses: MAX_GUESSES,
    round: room.currentRound,
    totalRounds: room.config.totalRounds,
    roundTime: room.config.roundTime,
    elapsed: Math.max(0, nowSeconds() - room.roundStartedAt),
    chooserId: room.currentChooserId,
    chooserName: chooser ? chooser.name : "",
    hintAvailable: Boolean(room.currentRoundConfig.hint),
    progress: getRoundProgress(room),
    // Player-specific replay data:
    guesses: player.guesses.map((g) => ({ guess: g.guess, feedback: g.feedback })),
    solved: player.solved,
    solvedAt: player.solvedAt,
    usedHint: player.usedHint,
    hint: player.usedHint ? (room.currentRoundConfig.hint || "") : ""
  };
}

function clearRoomTimers(room) {
  if (room.timerInterval) clearInterval(room.timerInterval);
  if (room.countdownInterval) clearInterval(room.countdownInterval);
  room.timerInterval = null;
  room.countdownInterval = null;
}

function finishRound(room, reason = "complete") {
  if (!room || room.status !== "playing") return;
  clearRoomTimers(room);
  room.status = "round-ended";
  touchRoom(room);

  // Award chooser score BEFORE building leaderboard
  const chooserPlayer = room.players.get(room.currentChooserId);
  if (chooserPlayer) {
    const pts = calculateChooserScore(room);
    chooserPlayer.roundScore = pts;
    chooserPlayer.cumulativeScore += pts;
    chooserPlayer.breakdown = {
      base: 0, timeRemaining: 0, timeBonus: 0,
      unusedGuesses: 0, guessBonus: 0,
      chooserBonus: pts, score: pts
    };
  }

  const leaderboard = getRoundLeaderboard(room);
  io.to(room.code).emit("game:roundEnd", {
    reason,
    word: room.currentRoundConfig.word,
    definition: room.currentRoundConfig.definition || "",
    round: room.currentRound,
    totalRounds: room.config.totalRounds,
    chooserId: room.currentChooserId,
    chooserScore: chooserPlayer ? chooserPlayer.roundScore : 0,
    leaderboard
  });

  if (room.currentRound >= room.config.totalRounds) {
    // Final round — hold on the appreciation + round leaderboard before the
    // final scoreboard replaces them, so the last round's standings are seen too.
    setTimeout(() => {
      if (!rooms.has(room.code) || room.status !== "round-ended") return;
      room.status = "session-ended";
      io.to(room.code).emit("game:sessionEnd", {
        leaderboard: getFinalLeaderboard(room)
      });
    }, ROUND_END_DELAY);
  } else {
    // Announce the next chooser once the appreciation has played. Players keep
    // studying the leaderboard until they tap to continue (→ choosing screen) or
    // until the next round starts (→ straight to the game). The next chooser can
    // begin picking right away without waiting on everyone else.
    setTimeout(() => {
      if (rooms.has(room.code) && room.status === "round-ended") {
        startRoundRobin(room);
      }
    }, ROUND_REVEAL_DELAY);
  }
}

function activeGuessers(room) {
  return Array.from(room.players.values()).filter(
    p => p.active && p.id !== room.currentChooserId
  );
}

function allActivePlayersSolved(room) {
  const activePlayers = activeGuessers(room);
  return activePlayers.length > 0 && activePlayers.every(p => p.solved);
}

// A guesser is "finished" once they've either solved the word OR used up all of
// their guesses. The round should end as soon as EVERY guesser is finished — we
// don't keep the survivors (or the picker) waiting on the round timer just
// because someone failed to solve. With a single guesser this means the round
// ends the instant they solve or exhaust their attempts.
function allActivePlayersFinished(room) {
  const activePlayers = activeGuessers(room);
  return activePlayers.length > 0 &&
    activePlayers.every(p => p.solved || p.guesses.length >= MAX_GUESSES);
}

// Reason for an all-finished round: "all-solved" only when everyone actually
// cracked it, otherwise the more accurate "all-finished".
function finishedReason(room) {
  return allActivePlayersSolved(room) ? "all-solved" : "all-finished";
}

// The round timer is SERVER-AUTHORITATIVE. This interval broadcasts the canonical
// countdown (game:timerTick) every second and, when it reaches zero, advances the
// game itself via finishRound — independent of any client action. The client's
// timer display only mirrors these ticks; it never drives round expiry.
function startRoundTimer(room) {
  room.timerInterval = setInterval(() => {
    const remaining = Math.max(0, room.config.roundTime - (nowSeconds() - room.roundStartedAt));
    io.to(room.code).emit("game:timerTick", { remaining });
    if (remaining <= 0) {
      finishRound(room, "timer");
    }
  }, 1000);
}

function startGameRound(room, roundConfig = null) {
  clearRoomTimers(room);
  resetRoundPlayerState(room);

  if (roundConfig) {
    room.currentRoundConfig = roundConfig;
  }

  room.currentRound += 1;
  room.status = "playing";
  room.roundStartedAt = nowSeconds();
  touchRoom(room);

  io.to(room.code).emit("game:started", {
    wordLength: WORD_LENGTH,
    maxGuesses: MAX_GUESSES,
    hintAvailable: Boolean(room.currentRoundConfig.hint),
    round: room.currentRound,
    totalRounds: room.config.totalRounds,
    roundTime: room.config.roundTime,
    timerStart: room.roundStartedAt,
    chooserId: room.currentChooserId,
    chooserName: room.players.get(room.currentChooserId)?.name || "",
    players: getPublicPlayers(room),
    progress: getRoundProgress(room)
  });

  io.to(room.code).emit("game:timerTick", { remaining: room.config.roundTime });
  startRoundTimer(room);
}

function startRoundRobin(room) {
  if (room.currentRound === 0) {
    room.playerOrder = Array.from(room.players.values())
      .filter(p => p.active && p.connected)
      .map(p => p.id);
    room.chooserIndex = 0;
  } else {
    room.chooserIndex = (room.chooserIndex + 1) % Math.max(room.playerOrder.length, 1);
  }

  // Remove players who left or disconnected
  room.playerOrder = room.playerOrder.filter(id => room.players.has(id));

  if (room.playerOrder.length === 0) {
    room.status = "session-ended";
    io.to(room.code).emit("game:sessionEnd", {
      leaderboard: getFinalLeaderboard(room)
    });
    return;
  }

  room.chooserIndex = room.chooserIndex % room.playerOrder.length;
  const chooserId = room.playerOrder[room.chooserIndex];
  room.currentChooserId = chooserId;
  room.waitingForWord = true;
  room.status = "choosing";

  const chooser = room.players.get(chooserId);
  const nextRoundNumber = room.currentRound + 1;

  io.to(room.code).emit("game:choosingWord", {
    chooserId,
    chooserName: chooser ? chooser.name : "Unknown",
    round: nextRoundNumber,
    totalRounds: room.config.totalRounds,
    standings: getChoosingStandings(room)
  });

  const chooserSocket = io.sockets.sockets.get(chooserId);
  if (chooserSocket) {
    chooserSocket.emit("game:requestWord", {
      round: nextRoundNumber,
      totalRounds: room.config.totalRounds
    });
  } else {
    // Chooser disconnected — skip them
    room.waitingForWord = false;
    room.chooserIndex = (room.chooserIndex + 1) % room.playerOrder.length;
    startRoundRobin(room);
  }
}

function promoteOrCloseRoom(room) {
  const connectedPlayers = Array.from(room.players.values()).filter((player) => player.connected);
  const nextHost = connectedPlayers[0];

  if (!nextHost) {
    clearRoomTimers(room);
    rooms.delete(room.code);
    return;
  }

  room.hostId = nextHost.id;
  io.to(room.code).emit("room:hostChanged", {
    hostId: nextHost.id,
    hostName: nextHost.name,
    room: getRoomSummary(room)
  });
}

// Fix 15: when the host drops, give them a grace window to reconnect (this pairs
// with the session-reconnect flow — a brief blip no longer disrupts the room).
// If the host is still absent after the window, end the game for everyone and
// clean up the room. The grace timer is cancelled if the host reconnects.
const HOST_GRACE_MS = 10000;
function startHostGrace(room) {
  if (room.hostGraceTimer) return; // already counting down
  room.hostGraceTimer = setTimeout(() => {
    room.hostGraceTimer = null;
    if (!rooms.has(room.code)) return;
    const host = room.players.get(room.hostId);
    if (host && host.connected) return; // host reconnected within the window
    clearRoomTimers(room);
    io.to(room.code).emit("room:hostLeft", { message: "Host disconnected. Game ended." });
    rooms.delete(room.code);
  }, HOST_GRACE_MS);
}

function removeExpiredRooms() {
  const cutoff = Date.now() - ROOM_EXPIRY_MS;
  for (const [code, room] of rooms.entries()) {
    if (room.lastActive < cutoff) {
      clearRoomTimers(room);
      io.to(code).emit("room:expired");
      rooms.delete(code);
    }
  }
}

setInterval(removeExpiredRooms, 60 * 1000).unref();

// Cleanly remove a socket's player from whatever room it's currently in.
// Shared by room:leave and by room:join/room:create, so a user is never left
// "stuck" already-in-a-room after navigating home without an explicit leave.
// Returns true if the socket was actually in a (still-existing) room.
// A game needs at least two participants (a word-picker plus someone to guess).
// If the session is in progress and only one (or zero) active player remains,
// end the session and show the final leaderboard to whoever's left.
function endSessionIfAbandoned(room) {
  if (!room || !rooms.has(room.code)) return false;
  const inProgress = ["countdown", "choosing", "playing", "round-ended"].includes(room.status);
  if (!inProgress) return false;
  const activeCount = Array.from(room.players.values()).filter(p => p.active && p.connected).length;
  if (activeCount > 1) return false;

  clearRoomTimers(room);
  room.status = "session-ended";
  room.waitingForWord = false;
  io.to(room.code).emit("game:sessionEnd", {
    leaderboard: getFinalLeaderboard(room),
    reason: "not-enough-players"
  });
  return true;
}

function detachFromRoom(socket) {
  const code = socket.data.roomCode;
  socket.data.roomCode = null;
  if (!code) return false;
  socket.leave(code);
  const room = rooms.get(code);
  if (!room) return false; // stale pointer — room already gone

  const wasChooser = socket.id === room.currentChooserId;
  const wasHost = socket.id === room.hostId;

  room.players.delete(socket.id);
  room.playerOrder = room.playerOrder.filter(id => id !== socket.id);
  touchRoom(room);

  if (room.players.size === 0) {
    clearRoomTimers(room);
    rooms.delete(room.code);
    return true;
  }

  if (wasHost) promoteOrCloseRoom(room);
  emitPlayers(room, "room:playerLeft");

  // Only one player left in a live game → close it and show the leaderboard.
  if (endSessionIfAbandoned(room)) return true;

  if (wasChooser && room.waitingForWord && room.status === "choosing") {
    room.waitingForWord = false;
    if (room.playerOrder.length > 0) startRoundRobin(room);
  }
  if (wasChooser && room.status === "playing") {
    finishRound(room, "chooser-left");
  }
  if (room.status === "playing" && allActivePlayersFinished(room)) {
    finishRound(room, finishedReason(room));
  }
  return true;
}

// Hand a disconnected player's slot to a new socket — restoring their score,
// board, host authority, and chooser turn. Shared by room:rejoin (matched by
// session token) and room:join (a returning player matched by name). Returns the
// callback reply, including a roundState snapshot when a round is in progress.
function reclaimPlayerSlot(room, existing, socket) {
  const wasHost = existing.id === room.hostId;
  const wasChooser = existing.id === room.currentChooserId;
  const oldId = existing.id;

  // Swap old socket ID → new socket ID, reactivating the slot.
  room.players.delete(oldId);
  existing.id = socket.id;
  existing.connected = true;
  existing.active = true;
  room.players.set(socket.id, existing);

  if (wasHost) {
    room.hostId = socket.id;
    // Host made it back within the grace window — cancel the end-game timer.
    if (room.hostGraceTimer) { clearTimeout(room.hostGraceTimer); room.hostGraceTimer = null; }
  }
  if (wasChooser) room.currentChooserId = socket.id;
  room.playerOrder = room.playerOrder.map(id => id === oldId ? socket.id : id);

  // Leave any other room this socket was bound to before binding to this one.
  if (socket.data.roomCode && socket.data.roomCode !== room.code) detachFromRoom(socket);
  socket.data.roomCode = room.code;
  socket.join(room.code);
  touchRoom(room);

  emitPlayers(room, "room:playerJoined");
  const reply = {
    ok: true,
    isHost: wasHost,
    room: getRoomSummary(room),
    playerId: socket.id,
    sessionId: existing.sessionId
  };
  // Mid-round: hand back enough to rebuild this player's board on a cold load.
  if (room.status === "playing") reply.roundState = getActiveRoundSnapshot(room, existing);
  return reply;
}

// ── Snapshot / restore ───────────────────────────────────────────────────────
// A room carries live, non-serializable handles (timers) and a Map of players.
// serializeRoom strips the timers and flattens the Map; deserializeRoom rebuilds
// the Map and nulls the timers. Players are marked disconnected on restore — the
// sockets from the previous process are gone; clients re-attach via room:rejoin.
function serializeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    createdAt: room.createdAt,
    lastActive: room.lastActive,
    status: room.status,
    currentRound: room.currentRound,
    roundStartedAt: room.roundStartedAt,
    playerOrder: room.playerOrder || [],
    chooserIndex: room.chooserIndex,
    currentChooserId: room.currentChooserId,
    waitingForWord: room.waitingForWord,
    config: room.config,
    currentRoundConfig: room.currentRoundConfig,
    players: Array.from(room.players.values()).map((p) => ({
      id: p.id, sessionId: p.sessionId, name: p.name, connected: p.connected, active: p.active,
      isHost: p.isHost, cumulativeScore: p.cumulativeScore, roundScore: p.roundScore,
      solved: p.solved, solvedAt: p.solvedAt, guesses: p.guesses, breakdown: p.breakdown,
      usedHint: p.usedHint, hintPenalty: p.hintPenalty
    }))
  };
}

function deserializeRoom(obj) {
  const room = {
    code: obj.code,
    hostId: obj.hostId,
    createdAt: obj.createdAt,
    lastActive: obj.lastActive,
    status: obj.status,
    currentRound: obj.currentRound,
    roundStartedAt: obj.roundStartedAt,
    timerInterval: null,
    countdownInterval: null,
    hostGraceTimer: null,
    players: new Map(),
    playerOrder: obj.playerOrder || [],
    chooserIndex: obj.chooserIndex || 0,
    currentChooserId: obj.currentChooserId || null,
    waitingForWord: Boolean(obj.waitingForWord),
    config: obj.config || { roundTime: 180, totalRounds: 0 },
    currentRoundConfig: obj.currentRoundConfig || { word: null, hint: "" }
  };
  for (const p of (obj.players || [])) {
    p.connected = false;   // previous-process sockets are dead
    p.guessing = false;    // clear any in-flight guard
    room.players.set(p.id, p);
  }
  return room;
}

// Re-establish the live timers/transitions a restored room needs so a round in
// progress keeps moving even though setInterval/setTimeout handles didn't survive.
function resumeRoomAfterRestore(room) {
  if (room.status === "playing") {
    const elapsed = Math.max(0, nowSeconds() - room.roundStartedAt);
    if (elapsed >= room.config.roundTime) {
      finishRound(room, "timer");          // round already expired during downtime
    } else {
      startRoundTimer(room);               // resume the authoritative countdown
    }
  } else if (room.status === "countdown") {
    room.status = "lobby";                  // brief pre-round countdown can't resume; host re-starts
  } else if (room.status === "round-ended") {
    // The auto-advance timer was lost — re-arm it so the session doesn't stall.
    if (room.currentRound >= room.config.totalRounds) {
      room.status = "session-ended";
    } else {
      setTimeout(() => {
        if (rooms.has(room.code) && room.status === "round-ended") startRoundRobin(room);
      }, ROUND_REVEAL_DELAY);
    }
  }
  // "lobby" / "choosing" / "session-ended" need no re-arming: choosing resumes when
  // the chooser submits a word; the others are static until a player/host acts.
}

async function persistState() {
  if (!redis) return;
  try {
    const data = JSON.stringify(Array.from(rooms.values()).map(serializeRoom));
    await redis.set(REDIS_STATE_KEY, data, "EX", Math.ceil(ROOM_EXPIRY_MS / 1000));
  } catch (err) {
    logEvent("error", "persist_failed", { message: err && err.message });
  }
}

async function restoreRooms() {
  if (!redis) return;
  try {
    const raw = await redis.get(REDIS_STATE_KEY);
    if (!raw) return;
    let restored = 0;
    for (const obj of JSON.parse(raw)) {
      if (!obj || !obj.code) continue;
      const room = deserializeRoom(obj);
      rooms.set(room.code, room);
      resumeRoomAfterRestore(room);
      restored += 1;
    }
    logEvent("info", "rooms_restored", { count: restored });
  } catch (err) {
    logEvent("error", "restore_failed", { message: err && err.message });
  }
}

// Attach the signed-in user (if any) to every socket. The session token rides in
// via the httpOnly cookie for browsers, or socket.handshake.auth.token for
// programmatic clients (tests). Never rejects — guests connect fine; only hosting
// a room requires socket.data.user.
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token
      || auth.parseCookies(socket.handshake.headers.cookie)[auth.cookieName]
      || null;
    socket.data.user = await auth.userFromToken(token);
  } catch (err) {
    socket.data.user = null;
    logEvent("error", "socket_auth_error", { message: err && err.message });
  }
  next();
});

io.on("connection", (socket) => {
  // Capture transport-level socket errors so they surface in the Railway logs.
  socket.on("error", (err) => {
    logEvent("error", "socket_error", { socketId: socket.id, message: err && err.message });
  });

  // Host creates a room. Hosting requires a signed-in account (the socket carries
  // the authenticated user); joining a room never does. Word and hint are set by
  // each round's chooser. Total rounds = 2x player count, set when the session starts.
  socket.on("room:create", (payload = {}, callback) => {
    if (!socket.data.user) {
      return callback?.({ ok: false, needAuth: true, error: "Please sign in to create a room." });
    }
    const name = isDisplayName(payload.name) ? payload.name.trim() : "Host";
    const roundTime = Number(payload.roundTime);

    if (![60, 120, 180, 300].includes(roundTime)) return callback?.({ ok: false, error: "Invalid round timer." });

    // Host can pick their own room code (e.g. a word). If they leave it blank,
    // fall back to a random code.
    let code;
    const hasCustomCode = payload.customCode != null && String(payload.customCode).trim() !== "";
    if (hasCustomCode) {
      code = normalizeRoomCode(payload.customCode);
      if (!isValidCustomCode(code)) {
        return callback?.({ ok: false, error: "Room code must be 3–6 letters or numbers." });
      }
      if (rooms.has(code)) {
        return callback?.({ ok: false, error: "That room code is already taken — try another." });
      }
    } else {
      code = makeRoomCode();
    }
    const room = {
      code,
      hostId: socket.id,
      createdBy: socket.data.user.email,
      createdAt: Date.now(),
      lastActive: Date.now(),
      status: "lobby",
      currentRound: 0,
      roundStartedAt: null,
      timerInterval: null,
      countdownInterval: null,
      players: new Map(),
      // Round-robin state
      playerOrder: [],
      chooserIndex: 0,
      currentChooserId: null,
      waitingForWord: false,
      config: {
        roundTime: roundTime,
        totalRounds: 0  // Calculated as 2x players when session starts
      },
      currentRoundConfig: {
        word: null,
        hint: ""
      }
    };

    // Free any previous room so creating a new one never leaves a dangling slot.
    if (socket.data.roomCode) detachFromRoom(socket);

    const host = makePlayer(socket, name, true);
    room.players.set(socket.id, host);
    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.join(code);

    callback?.({ ok: true, room: getRoomSummary(room), playerId: socket.id, isHost: true, sessionId: host.sessionId });
    socket.emit("room:created", { room: getRoomSummary(room), playerId: socket.id });
  });

  // Player joins a room by code with a validated display name.
  socket.on("room:join", (payload = {}, callback) => {
    const code = String(payload.code || "").trim().toUpperCase();
    const name = String(payload.name || "").trim();
    const room = rooms.get(code);

    if (!room) return callback?.({ ok: false, error: "Room not found." });
    if (!isDisplayName(name)) return callback?.({ ok: false, error: "Name must be 3-16 alphanumeric characters." });

    // Mid-game: only RETURNING players may re-enter — reclaim a disconnected slot
    // matched by name, preserving their score, board, and chooser turn. New names
    // are turned away until the next game; an in-use (still-connected) name can't
    // be hijacked. The room key alone gets a returning player back in at any time.
    if (room.status !== "lobby") {
      if (room.status === "session-ended") {
        return callback?.({ ok: false, error: "That game has already ended." });
      }
      const sameName = Array.from(room.players.values())
        .find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (sameName && !sameName.connected) {
        return callback?.(reclaimPlayerSlot(room, sameName, socket));
      }
      if (sameName) {
        return callback?.({ ok: false, error: "That name is already active in the game. If it's you, rejoin from the device you were playing on." });
      }
      return callback?.({ ok: false, error: "This game is already in progress — you can only rejoin if you were already in it. Use the exact name you played with." });
    }

    if (room.players.size >= MAX_PLAYERS) return callback?.({ ok: false, error: "Room is full." });
    if (Array.from(room.players.values()).some((player) => player.id !== socket.id && player.name.toLowerCase() === name.toLowerCase())) {
      return callback?.({ ok: false, error: "That name is already taken in this room." });
    }

    // All checks passed — free any previous room (e.g. after "Play Again" navigated
    // home without an explicit leave) so the user is never blocked as "already in a
    // room". Done only now so a rejected join never strands them out of their room.
    if (socket.data.roomCode && socket.data.roomCode !== code) detachFromRoom(socket);

    const player = makePlayer(socket, name);
    room.players.set(socket.id, player);
    socket.data.roomCode = code;
    socket.join(code);
    touchRoom(room);

    callback?.({ ok: true, room: getRoomSummary(room), playerId: socket.id, isHost: socket.id === room.hostId, sessionId: player.sessionId });
    emitPlayers(room, "room:playerJoined");
  });

  // Player reconnects mid-game with a session token to reclaim their slot.
  socket.on("room:rejoin", ({ code, sessionId } = {}, callback) => {
    const room = rooms.get(String(code || "").trim().toUpperCase());
    if (!room) return callback?.({ ok: false, error: "Room not found." });

    // Locate the existing player by their immutable session token
    const existing = Array.from(room.players.values()).find((p) => p.sessionId === sessionId);
    if (!existing) return callback?.({ ok: false, error: "Session not recognised." });

    callback?.(reclaimPlayerSlot(room, existing, socket));
  });

  // Host starts the session. Total rounds = 2 x active player count.
  // Word selection is handled per-round via round-robin.
  socket.on("game:start", (payload = {}, callback) => {
    const room = getRoomForSocket(socket);
    if (!assertHost(socket, room)) return callback?.({ ok: false, error: "Only the host can start the session." });
    if (room.status === "playing") return callback?.({ ok: false, error: "A round is already running." });
    if (room.status === "choosing") return callback?.({ ok: false, error: "Waiting for word chooser." });
    if (room.currentRound > 0 && room.currentRound >= room.config.totalRounds) {
      return callback?.({ ok: false, error: "All rounds complete." });
    }

    const roundTime = Number(payload.roundTime || room.config.roundTime);
    if (![60, 120, 180, 300].includes(roundTime)) {
      return callback?.({ ok: false, error: "Invalid round timer." });
    }
    room.config.roundTime = roundTime;

    // Lock in total rounds = 2 x active player count (min 2)
    const activePlayers = Array.from(room.players.values())
      .filter(p => p.active && p.connected);
    room.config.totalRounds = Math.max(2, activePlayers.length * 2);

    startRoundRobin(room);
    callback?.({ ok: true, totalRounds: room.config.totalRounds });
  });

  // Word chooser submits the word for the current round.
  socket.on("game:submitWord", async (payload = {}, callback) => {
    const room = getRoomForSocket(socket);
    if (!room) return callback?.({ ok: false, error: "Not in a room." });
    if (!room.waitingForWord) return callback?.({ ok: false, error: "Not waiting for a word." });
    if (socket.id !== room.currentChooserId) return callback?.({ ok: false, error: "It is not your turn to choose." });
    if (room.status !== "choosing") return callback?.({ ok: false, error: "Room is not in choosing state." });

    const word = normalizeWord(payload?.word);
    const hint = String(payload.hint || "").trim().slice(0, 140);

    if (!isFiveLetterWord(word)) {
      return callback?.({ ok: false, error: "Word must be exactly 5 alphabetic characters." });
    }

    // ONE dictionary lookup gives us BOTH the validity verdict and the meaning.
    // Tri-state: reject only a DEFINITIVE non-word. If the dictionary can't be
    // reached (null), fail-open so a missing key / MW outage never blocks play.
    // Because the definition rides along with validation, it's guaranteed
    // available to EVERY player at round end whenever the word was accepted.
    const lookup = await lookupWord(word);
    if (lookup.valid === false) {
      return callback?.({ ok: false, error: "That's not a word we recognise. Try a common English noun, verb, or adjective (no names or places)." });
    }

    room.waitingForWord = false;
    startGameRound(room, { word, hint, definition: lookup.definition || "" });
    callback?.({ ok: true });
  });

  // Host broadcasts a 10-second force-start countdown, then the server starts the round.
  socket.on("game:forceStart", (payload = {}, callback) => {
    const room = getRoomForSocket(socket);
    if (!assertHost(socket, room)) return callback?.({ ok: false, error: "Only the host can force-start." });
    if (room.status === "playing") return callback?.({ ok: false, error: "A round is already running." });

    let remaining = 10;
    clearRoomTimers(room);
    room.status = "countdown";
    io.to(room.code).emit("game:countdown", { remaining });

    room.countdownInterval = setInterval(() => {
      remaining -= 1;
      io.to(room.code).emit("game:countdown", { remaining });
      if (remaining <= 0) {
        clearInterval(room.countdownInterval);
        room.countdownInterval = null;
        startRoundRobin(room);
      }
    }, 1000);

    callback?.({ ok: true });
  });

  // Player submits a guess; validation, feedback, solving, and scoring all happen server-side.
  socket.on("game:guess", async (payload = {}, callback) => {
    const room = getRoomForSocket(socket);
    const player = room ? findPlayer(room, socket.id) : null;
    const guess = normalizeWord(payload.guess);

    if (!room || !player) return callback?.({ ok: false, error: "You are not in a room." });
    if (room.status !== "playing") return callback?.({ ok: false, error: "No round is currently active." });
    if (!player.active) return callback?.({ ok: false, error: "Inactive players cannot guess." });
    if (socket.id === room.currentChooserId) {
      return callback?.({ ok: false, error: "You chose the word this round — you cannot guess." });
    }
    if (player.solved) return callback?.({ ok: false, error: "You already solved this round." });
    if (player.guesses.length >= MAX_GUESSES) return callback?.({ ok: false, error: "No guesses remaining." });
    if (!isFiveLetterWord(guess)) return callback?.({ ok: false, error: "Guess must be exactly 5 alphabetic characters." });

    // Re-entrancy guard: the dictionary await below opens a race window where a
    // rapid second guess from the same player could double-count. Reject overlap.
    if (player.guessing) return callback?.({ ok: false, error: "Still checking your last guess — one sec." });
    player.guessing = true;
    try {
      // Dictionary check (tri-state): reject only a DEFINITIVE non-word. A missing
      // key or MW outage returns null → fail-open so play never stalls.
      const valid = await isValidWord(guess);
      if (valid === false) return callback?.({ ok: false, error: "Not a valid word. Try again." });

      // Re-check terminal conditions in case the round ended during the await.
      if (room.status !== "playing") return callback?.({ ok: false, error: "No round is currently active." });
      if (player.solved) return callback?.({ ok: false, error: "You already solved this round." });
      if (player.guesses.length >= MAX_GUESSES) return callback?.({ ok: false, error: "No guesses remaining." });

      const answer = room.currentRoundConfig.word;
      const feedback = makeFeedback(guess, answer);
      player.guesses.push({ guess, feedback });
      touchRoom(room);

      const solved = guess === answer;
      if (solved) {
        const breakdown = calculateScore(room, player);
        player.solved = true;
        player.solvedAt = Math.max(0, nowSeconds() - room.roundStartedAt);
        player.roundScore = breakdown.score;
        player.cumulativeScore += breakdown.score;
        player.breakdown = breakdown;

        io.to(room.code).emit("game:playerSolved", {
          id: player.id,
          name: player.name,
          time: player.solvedAt,
          score: player.roundScore,
          guessesUsed: player.guesses.length,
          leaderboard: getLiveLeaderboard(room),
          progress: getRoundProgress(room)
        });
      }

      // Live spectator feed: every guess updates the attempt counts the picker
      // (and solved players) are watching. Never includes the guessed letters.
      io.to(room.code).emit("game:guessProgress", { progress: getRoundProgress(room) });

      callback?.({
        ok: true,
        guess,
        feedback,
        solved,
        guessesUsed: player.guesses.length,
        maxGuesses: MAX_GUESSES
      });

      if (allActivePlayersFinished(room)) {
        finishRound(room, finishedReason(room));
      }
    } finally {
      player.guessing = false;
    }
  });

  // Player opts in to reveal the chooser's hint. The cost is computed and locked
  // in server-side at reveal time — it decays the longer the player has battled
  // on their own — and is subtracted from their round score only when they solve.
  // The numeric cost is never sent to the client.
  socket.on("game:useHint", (_payload, callback) => {
    const room = getRoomForSocket(socket);
    const player = room ? findPlayer(room, socket.id) : null;

    if (!room || !player) return callback?.({ ok: false });
    if (room.status !== "playing") return callback?.({ ok: false });
    if (!room.currentRoundConfig.hint) return callback?.({ ok: false });

    // Idempotent: a second reveal never recomputes or re-applies the cost.
    if (player.usedHint) {
      return callback?.({ ok: true, hint: room.currentRoundConfig.hint });
    }

    player.hintPenalty = Math.max(
      0,
      HINT_PENALTY_BASE - HINT_PENALTY_STEP * player.guesses.length
    );
    player.usedHint = true;
    touchRoom(room);

    callback?.({ ok: true, hint: room.currentRoundConfig.hint });

    // Let the word-picker (and anyone already done) see who took the hint right
    // away, instead of waiting for this player's next guess to refresh the feed.
    // The hint TEXT never rides along — getRoundProgress only carries the flag.
    io.to(room.code).emit("game:guessProgress", { progress: getRoundProgress(room) });
  });

  // Host force-ends the active round.
  socket.on("game:endRound", (_payload = {}, callback) => {
    const room = getRoomForSocket(socket);
    if (!assertHost(socket, room)) return callback?.({ ok: false, error: "Only the host can end the round." });
    if (room.status !== "playing") return callback?.({ ok: false, error: "No active round to end." });
    finishRound(room, "host");
    callback?.({ ok: true });
  });

  // Host removes a player from the room while preserving server authority over room membership.
  socket.on("room:kick", (payload = {}, callback) => {
    const room = getRoomForSocket(socket);
    const targetId = String(payload.playerId || "");

    if (!assertHost(socket, room)) return callback?.({ ok: false, error: "Only the host can kick players." });
    if (targetId === room.hostId) return callback?.({ ok: false, error: "The host cannot kick themselves." });
    const target = room.players.get(targetId);
    if (!target) return callback?.({ ok: false, error: "Player not found." });

    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.emit("room:kicked", { reason: "You were removed by the host." });
      targetSocket.leave(room.code);
      targetSocket.data.roomCode = null;
    }
    room.players.delete(targetId);
    touchRoom(room);
    emitPlayers(room, "room:playerLeft");
    callback?.({ ok: true });
  });

  // Any player can voluntarily leave the room at any time.
  socket.on("room:leave", (_payload = {}, callback) => {
    if (!socket.data.roomCode) return callback?.({ ok: false, error: "Not in a room." });
    detachFromRoom(socket);
    callback?.({ ok: true });
  });

  // A disconnected player is marked inactive; if the host leaves, the next connected player is promoted.
  socket.on("disconnect", () => {
    const room = getRoomForSocket(socket);
    if (!room) return;

    const player = findPlayer(room, socket.id);
    if (player) {
      player.connected = false;
      player.active = false;
    }
    touchRoom(room);

    if (socket.id === room.hostId) {
      // Fix 15: grace window before ending the game, in case of a brief drop.
      startHostGrace(room);
    }

    // If the disconnected player was the current chooser
    if (player && socket.id === room.currentChooserId) {
      if (room.waitingForWord && room.status === "choosing") {
        room.waitingForWord = false;
        room.playerOrder = room.playerOrder.filter(id => id !== socket.id);
        if (room.playerOrder.length > 0) {
          setTimeout(() => {
            if (rooms.has(room.code) && room.status !== "session-ended") startRoundRobin(room);
          }, 1500);
        }
      }
    }

    if (rooms.has(room.code)) {
      emitPlayers(room, "room:playerLeft");
      // Only one player left in a live game → close it and show the leaderboard.
      if (endSessionIfAbandoned(room)) return;
      if (room.status === "playing" && allActivePlayersFinished(room)) {
        finishRound(room, finishedReason(room));
      }
    }
  });
});

// Periodic snapshot so a hard crash loses at most a few seconds of progress.
// Only runs when persistence is enabled; unref'd so it never holds the process up.
if (redis) {
  setInterval(() => { persistState(); }, SNAPSHOT_INTERVAL_MS).unref();
}

// Graceful drain. Railway sends SIGTERM before replacing the container. We take a
// final snapshot (so the new container can restore the games) and tell connected
// players an update is rolling — they're reconnected automatically once it's up.
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logEvent("info", "shutdown", { signal });
  try { io.emit("server:restarting", { message: "Server is updating — you'll be reconnected automatically." }); } catch (_) {}
  await persistState();
  server.close(() => { logEvent("info", "server_closed", {}); process.exit(0); });
  // Force exit if open sockets keep the server from closing in time.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Restore any persisted games before accepting traffic, then start listening.
// Guarded so the module can be required in tests without binding a port.
if (require.main === module) {
  (async () => {
    await restoreRooms();
    server.listen(PORT, "0.0.0.0", () => {
      logEvent("info", "server_listening", { port: PORT, env: NODE_ENV, persistence: redis ? "redis" : "memory" });
    });
  })();
}

// Test surface: lets a test require this module (without booting) and exercise the
// persistence layer with an injected client. Not used by the running server.
module.exports = {
  rooms, serializeRoom, deserializeRoom, persistState, restoreRooms,
  setRedisClient: (client) => { redis = client; }
};
