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
  console.warn("WARNING: MW_API_KEY is not set. Word validation will reject all words.");
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
  if (!isFiveLetterWord(word)) {
    return res.json({ valid: false, reason: "not-five-letters" });
  }
  try {
    const valid = await isValidWord(word);
    if (valid === null) return res.json({ valid: false, reason: "api-error" });
    if (!valid) return res.json({ valid: false, reason: "not-a-common-word" });
    res.json({ valid: true });
  } catch {
    res.json({ valid: false, reason: "api-error" });
  }
});


function normalizeWord(word) {
  return String(word || "").trim().toUpperCase();
}

function isFiveLetterWord(word) {
  return /^[A-Z]{5}$/.test(normalizeWord(word));
}

async function isValidWord(word) {
  if (!MW_API_KEY) return false;

  const normalized = normalizeWord(word).toLowerCase();

  const cacheKey = normalized;
  if (wordCache.has(cacheKey)) return wordCache.get(cacheKey);

  try {
    const url = `https://www.dictionaryapi.com/api/v3/references/collegiate/json/${encodeURIComponent(normalized)}?key=${MW_API_KEY}`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      return null; // HTTP error from MW API — unknown state, don't cache
    }

    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
      wordCache.set(cacheKey, false);
      if (wordCache.size > CACHE_MAX_SIZE) wordCache.delete(wordCache.keys().next().value);
      return false;
    }
    if (typeof data[0] === "string") {
      wordCache.set(cacheKey, false);
      if (wordCache.size > CACHE_MAX_SIZE) wordCache.delete(wordCache.keys().next().value);
      return false;
    }

    const REJECTED_LABELS = new Set([
      "biographical name",
      "geographical name",
      "trademark",
      "abbreviation",
      "symbol"
    ]);

    const hasValidEntry = data.some(entry => {
      if (typeof entry !== "object" || !entry.fl) return false;
      const fl = entry.fl.toLowerCase();
      if (REJECTED_LABELS.has(fl)) return false;
      const hw = entry?.hwi?.hw || "";
      if (hw && hw[0] === hw[0].toUpperCase() && hw[0] !== hw[0].toLowerCase()) return false;
      return true;
    });

    wordCache.set(cacheKey, hasValidEntry);
    if (wordCache.size > CACHE_MAX_SIZE) wordCache.delete(wordCache.keys().next().value);
    return hasValidEntry;

  } catch (err) {
    console.error("MW API error:", err.message);
    return null; // network/timeout error — unknown state, don't cache
  }
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
    category: room.config.category,
    customCategory: room.config.customCategory,
    roundTime: room.config.roundTime,
    totalRounds: room.config.totalRounds,
    currentRound: room.currentRound,
    hintAvailable: Boolean(room.currentRoundConfig?.hint),
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
    .sort((a, b) => {
      if (b.roundScore !== a.roundScore) return b.roundScore - a.roundScore;
      if ((a.solvedAt || Infinity) !== (b.solvedAt || Infinity)) return (a.solvedAt || Infinity) - (b.solvedAt || Infinity);
      return a.name.localeCompare(b.name);
    })
    .map((player) => ({
      id: player.id,
      name: player.name,
      active: player.active,
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

  const leaderboard = getRoundLeaderboard(room);
  io.to(room.code).emit("game:roundEnd", {
    reason,
    word: room.currentRoundConfig.word,
    round: room.currentRound,
    totalRounds: room.config.totalRounds,
    leaderboard
  });

  if (room.currentRound >= room.config.totalRounds) {
    room.status = "session-ended";
    io.to(room.code).emit("game:sessionEnd", {
      leaderboard: getFinalLeaderboard(room)
    });
  }
}

function allActivePlayersSolved(room) {
  const activePlayers = Array.from(room.players.values()).filter((player) => player.active);
  return activePlayers.length > 0 && activePlayers.every((player) => player.solved);
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
    players: getPublicPlayers(room)
  });

  io.to(room.code).emit("game:timerTick", { remaining: room.config.roundTime });
  startRoundTimer(room);
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

io.on("connection", (socket) => {
  // Host creates a room after PIN, word, category, hint, timer, and round count are validated server-side.
  socket.on("room:create", async (payload = {}, callback) => {
    const pin = String(payload.pin || "");
    const word = normalizeWord(payload.word);
    const name = isDisplayName(payload.name) ? payload.name.trim() : "Host";
    const category = String(payload.category || "Custom").trim().slice(0, 32);
    const customCategory = String(payload.customCategory || "").trim().slice(0, 32);
    const hint = String(payload.hint || "").trim().slice(0, 140);
    const roundTime = Number(payload.roundTime);
    const totalRounds = Number(payload.totalRounds);

    const customCode = String(payload.customCode || "").trim().toUpperCase();

    if (pin !== DEFAULT_PIN) return callback?.({ ok: false, error: "Invalid admin PIN." });
    if (!isFiveLetterWord(word)) return callback?.({ ok: false, error: "Word must be exactly 5 alphabetic characters." });
    const wordValid = await isValidWord(word);
    if (!wordValid) return callback?.({ ok: false, error: "Please choose a real English common noun, verb, or adjective. Proper nouns (names, places, brands) are not allowed." });

    let code;
    if (customCode) {
      if (!/^[A-Z0-9]{6}$/.test(customCode)) return callback?.({ ok: false, error: "Room code must be exactly 6 letters or numbers." });
      if (rooms.has(customCode)) return callback?.({ ok: false, error: "That room code is already in use. Choose another or leave blank for a random one." });
      code = customCode;
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
      config: {
        category: category === "Custom" && customCategory ? customCategory : category,
        customCategory,
        hint,
        roundTime: [60, 120, 180, 300].includes(roundTime) ? roundTime : 180,
        totalRounds: Number.isInteger(totalRounds) && totalRounds >= 1 && totalRounds <= 10 ? totalRounds : 1
      },
      currentRoundConfig: {
        word,
        category: category === "Custom" && customCategory ? customCategory : category,
        hint
      }
    };

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
    if (room.players.size >= MAX_PLAYERS) return callback?.({ ok: false, error: "Room is full." });
    if (room.status !== "lobby") return callback?.({ ok: false, error: "This game is already in progress." });
    if (Array.from(room.players.values()).some((player) => player.name.toLowerCase() === name.toLowerCase())) {
      return callback?.({ ok: false, error: "That name is already taken in this room." });
    }

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

    // Swap old socket ID → new socket ID
    room.players.delete(existing.id);
    existing.id = socket.id;
    existing.connected = true;
    existing.active = true;
    room.players.set(socket.id, existing);

    if (wasHost) room.hostId = socket.id;

    socket.data.roomCode = room.code;
    socket.join(room.code);
    touchRoom(room);

    emitPlayers(room, "room:playerJoined");
    callback?.({ ok: true, isHost: wasHost, room: getRoomSummary(room) });
  });

  // Host starts the next round immediately, optionally replacing the next word/category/hint.
  socket.on("game:start", async (payload = {}, callback) => {
    const room = getRoomForSocket(socket);
    if (!assertHost(socket, room)) return callback?.({ ok: false, error: "Only the host can start a round." });
    if (room.status === "playing") return callback?.({ ok: false, error: "A round is already running." });
    if (room.currentRound >= room.config.totalRounds) return callback?.({ ok: false, error: "The session has already ended." });

    const word = payload.word ? normalizeWord(payload.word) : room.currentRoundConfig.word;
    const category = payload.category ? String(payload.category).trim().slice(0, 32) : room.config.category;
    const hint = payload.hint !== undefined ? String(payload.hint || "").trim().slice(0, 140) : room.config.hint;
    const roundTime = Number(payload.roundTime || room.config.roundTime);
    const totalRounds = Number(payload.totalRounds || room.config.totalRounds);

    if (!isFiveLetterWord(word)) return callback?.({ ok: false, error: "Word must be exactly 5 alphabetic characters." });
    const wordValid = await isValidWord(word);
    if (!wordValid) return callback?.({ ok: false, error: "Please choose a real English common noun, verb, or adjective. Proper nouns (names, places, brands) are not allowed." });
    if (![60, 120, 180, 300].includes(roundTime)) return callback?.({ ok: false, error: "Invalid round timer." });
    if (!Number.isInteger(totalRounds) || totalRounds < room.currentRound + 1 || totalRounds > 10) {
      return callback?.({ ok: false, error: "Round count must be between the current round and 10." });
    }

    room.config.category = category || "Custom";
    room.config.hint = hint;
    room.config.roundTime = roundTime;
    room.config.totalRounds = totalRounds;
    startGameRound(room, { word, category: room.config.category, hint });
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

    room.countdownInterval = setInterval(async () => {
      remaining -= 1;
      io.to(room.code).emit("game:countdown", { remaining });
      if (remaining <= 0) {
        clearInterval(room.countdownInterval);
        room.countdownInterval = null;
        const word = payload.word ? normalizeWord(payload.word) : room.currentRoundConfig.word;
        if (!isFiveLetterWord(word)) {
          room.status = "lobby";
          io.to(room.code).emit("room:error", { error: "Word must be exactly 5 alphabetic characters." });
          return;
        }
        const wordValid = await isValidWord(word);
        if (!wordValid) {
          room.status = "lobby";
          io.to(room.code).emit("room:error", { error: "Word must be a real English common word. Proper nouns are not allowed." });
          return;
        }
        startGameRound(room, {
          word,
          category: payload.category ? String(payload.category).trim().slice(0, 32) : room.config.category,
          hint: payload.hint !== undefined ? String(payload.hint || "").trim().slice(0, 140) : room.config.hint
        });
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
    if (player.solved) return callback?.({ ok: false, error: "You already solved this round." });
    if (player.guesses.length >= MAX_GUESSES) return callback?.({ ok: false, error: "No guesses remaining." });
    if (!isFiveLetterWord(guess)) return callback?.({ ok: false, error: "Guess must be exactly 5 alphabetic characters." });

    // Dictionary check — only when MW_API_KEY is configured.
    // null means the API was unreachable; fail-open so the game keeps running.
    if (MW_API_KEY) {
      const valid = await isValidWord(guess);
      if (valid === false) return callback?.({ ok: false, error: "Not a valid word. Try again." });
    }

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
