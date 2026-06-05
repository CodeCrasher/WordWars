const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const PORT = process.env.PORT || 3000;
const DEFAULT_PIN = process.env.ADMIN_PIN || "1234";
const ROOM_EXPIRY_MS = 2 * 60 * 60 * 1000;
const MAX_PLAYERS = 20;
const MAX_GUESSES = 6;
const WORD_LENGTH = 5;

const MW_API_KEY = process.env.MW_API_KEY;
if (!MW_API_KEY) {
  console.warn("WARNING: MW_API_KEY not set. Word validation will reject all words.");
}
const wordCache = new Map();
const CACHE_MAX_SIZE = 2000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGIN || "*",
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"],
  allowEIO3: true
});
const rooms = new Map();

app.use(express.static(__dirname));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

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

// Tri-state dictionary check:
//   true  → definitely a valid common word
//   false → definitely NOT a word (MW responded, nothing matched) — safe to cache
//   null  → could not verify (no key / HTTP error / network / timeout) — NEVER cached,
//           callers should fail-open so a transient MW outage never blocks play.
async function isValidWord(word) {
  if (!MW_API_KEY) return null;
  const normalized = normalizeWord(word).toLowerCase();
  if (wordCache.has(normalized)) return wordCache.get(normalized);

  try {
    const url = `https://www.dictionaryapi.com/api/v3/references/collegiate/json/${encodeURIComponent(normalized)}?key=${MW_API_KEY}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    // HTTP error (5xx/429/etc.) is an UNKNOWN result — do not cache, fail-open.
    if (!response.ok) { console.error("MW API HTTP", response.status); return null; }

    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0 || typeof data[0] === "string") {
      // MW answered definitively: not a known word (data[0] strings are spelling suggestions).
      cacheWord(normalized, false);
      return false;
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

    cacheWord(normalized, valid);
    return valid;

  } catch (err) {
    // Network failure / 5s timeout abort — UNKNOWN, do not cache, fail-open.
    console.error("MW API error:", err.message);
    return null;
  }
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
    breakdown: null
  };
}

function resetRoundPlayerState(room) {
  for (const player of room.players.values()) {
    player.roundScore = 0;
    player.solved = false;
    player.solvedAt = null;
    player.guesses = [];
    player.breakdown = null;
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
  const score = 1000 + timeRemaining * 10 + unusedGuesses * 50;
  return {
    base: 1000,
    timeRemaining,
    timeBonus: timeRemaining * 10,
    unusedGuesses,
    guessBonus: unusedGuesses * 50,
    score
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
    round: room.currentRound,
    totalRounds: room.config.totalRounds,
    chooserId: room.currentChooserId,
    chooserScore: chooserPlayer ? chooserPlayer.roundScore : 0,
    leaderboard
  });

  if (room.currentRound >= room.config.totalRounds) {
    room.status = "session-ended";
    io.to(room.code).emit("game:sessionEnd", {
      leaderboard: getFinalLeaderboard(room)
    });
  } else {
    // Auto-advance to next chooser after 3 seconds
    setTimeout(() => {
      if (rooms.has(room.code) && room.status === "round-ended") {
        startRoundRobin(room);
      }
    }, 3000);
  }
}

function allActivePlayersSolved(room) {
  const activePlayers = Array.from(room.players.values()).filter(
    p => p.active && p.id !== room.currentChooserId
  );
  return activePlayers.length > 0 && activePlayers.every(p => p.solved);
}

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
    category: room.currentRoundConfig.category,
    hintAvailable: Boolean(room.currentRoundConfig.hint),
    round: room.currentRound,
    totalRounds: room.config.totalRounds,
    roundTime: room.config.roundTime,
    timerStart: room.roundStartedAt,
    chooserId: room.currentChooserId,
    chooserName: room.players.get(room.currentChooserId)?.name || "",
    players: getPublicPlayers(room)
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
    totalRounds: room.config.totalRounds
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

setInterval(removeExpiredRooms, 60 * 1000);

// Cleanly remove a socket's player from whatever room it's currently in.
// Shared by room:leave and by room:join/room:create, so a user is never left
// "stuck" already-in-a-room after navigating home without an explicit leave.
// Returns true if the socket was actually in a (still-existing) room.
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

  if (wasChooser && room.waitingForWord && room.status === "choosing") {
    room.waitingForWord = false;
    if (room.playerOrder.length > 0) startRoundRobin(room);
  }
  if (wasChooser && room.status === "playing") {
    finishRound(room, "chooser-left");
  }
  if (room.status === "playing" && allActivePlayersSolved(room)) {
    finishRound(room, "all-solved");
  }
  return true;
}

io.on("connection", (socket) => {
  // Host creates room with name, PIN, and round timer only.
  // Word, category, hint are set by each round's chooser.
  // Total rounds = 2x player count, calculated when session starts.
  socket.on("room:create", (payload = {}, callback) => {
    const pin = String(payload.pin || "");
    const name = isDisplayName(payload.name) ? payload.name.trim() : "Host";
    const roundTime = Number(payload.roundTime);

    if (pin !== DEFAULT_PIN) return callback?.({ ok: false, error: "Invalid admin PIN." });
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
        category: null,
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

    callback?.({ ok: true, room: getRoomSummary(room), playerId: socket.id, isHost: true });
    socket.emit("room:created", { room: getRoomSummary(room), playerId: socket.id });
  });

  // Player joins a room by code with a validated display name.
  socket.on("room:join", (payload = {}, callback) => {
    const code = String(payload.code || "").trim().toUpperCase();
    const name = String(payload.name || "").trim();
    const room = rooms.get(code);

    if (!room) return callback?.({ ok: false, error: "Room not found." });
    if (!isDisplayName(name)) return callback?.({ ok: false, error: "Name must be 3-16 alphanumeric characters." });
    if (room.status !== "lobby") return callback?.({ ok: false, error: "This game is already in progress." });
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

    const wasHost = existing.id === room.hostId;
    const wasChooser = existing.id === room.currentChooserId;

    // Swap old socket ID → new socket ID
    room.players.delete(existing.id);
    const oldId = existing.id;
    existing.id = socket.id;
    existing.connected = true;
    existing.active = true;
    room.players.set(socket.id, existing);

    if (wasHost) room.hostId = socket.id;
    if (wasChooser) room.currentChooserId = socket.id;
    room.playerOrder = room.playerOrder.map(id => id === oldId ? socket.id : id);

    socket.data.roomCode = room.code;
    socket.join(room.code);
    touchRoom(room);

    emitPlayers(room, "room:playerJoined");
    callback?.({ ok: true, isHost: wasHost, room: getRoomSummary(room) });
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
    const rawCategory = String(payload.category || "Custom").trim().slice(0, 32);
    const customCategory = String(payload.customCategory || "").trim().slice(0, 32);
    const hint = String(payload.hint || "").trim().slice(0, 140);

    if (!isFiveLetterWord(word)) {
      return callback?.({ ok: false, error: "Word must be exactly 5 alphabetic characters." });
    }

    // Tri-state: reject only a DEFINITIVE non-word. If the dictionary can't be
    // reached (null), fail-open so a missing key / MW outage never blocks play.
    const wordValid = await isValidWord(word);
    if (wordValid === false) {
      return callback?.({ ok: false, error: "That's not a word we recognise. Try a common English noun, verb, or adjective (no names or places)." });
    }

    const resolvedCategory = (rawCategory === "Custom" && customCategory)
      ? customCategory : rawCategory;

    room.waitingForWord = false;
    startGameRound(room, { word, category: resolvedCategory, hint });
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
          leaderboard: getLiveLeaderboard(room)
        });
      }

      callback?.({
        ok: true,
        guess,
        feedback,
        solved,
        guessesUsed: player.guesses.length,
        maxGuesses: MAX_GUESSES,
        hint: player.guesses.length >= 3 ? room.currentRoundConfig.hint || "" : ""
      });

      if (allActivePlayersSolved(room)) {
        finishRound(room, "all-solved");
      }
    } finally {
      player.guessing = false;
    }
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
      promoteOrCloseRoom(room);
    }

    // If the disconnected player was the current chooser
    if (player && socket.id === room.currentChooserId) {
      if (room.waitingForWord && room.status === "choosing") {
        room.waitingForWord = false;
        room.playerOrder = room.playerOrder.filter(id => id !== socket.id);
        if (room.playerOrder.length > 0) {
          setTimeout(() => {
            if (rooms.has(room.code)) startRoundRobin(room);
          }, 1500);
        }
      }
    }

    if (rooms.has(room.code)) {
      emitPlayers(room, "room:playerLeft");
      if (room.status === "playing" && allActivePlayersSolved(room)) {
        finishRound(room, "all-solved");
      }
    }
  });
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received — shutting down gracefully");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`WordWars server running at http://localhost:${PORT}`);
});
