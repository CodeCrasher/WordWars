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

app.get("/api/validate-word/:word", (req, res) => {
  const word = String(req.params.word || "").trim().toUpperCase();
  if (!isFiveLetterWord(word)) {
    return res.json({ valid: false, reason: "not-five-letters" });
  }
  if (!isValidWord(word)) {
    return res.json({ valid: false, reason: "not-a-common-word" });
  }
  res.json({ valid: true });
});

const VALID_WORDS = new Set([
  "abbey","abide","abode","abort","about","above","abuse","acorn","acres","acute",
  "adept","admit","adobe","adopt","adore","adult","after","again","agate","agent",
  "agile","agony","agree","ahead","alarm","album","alert","algae","alibi","alien",
  "align","alike","alive","allay","alley","allot","allow","alloy","aloft","along",
  "aloof","aloud","alpha","alter","amber","amble","amend","angel","anger","angle",
  "angry","anime","ankle","annex","antic","anvil","apart","apple","apply","apron",
  "aptly","ardor","arena","argue","arid","arise","armor","aroma","arose","array",
  "arrow","arson","artsy","ascot","ashen","asset","astir","atone","attic","audio",
  "audit","avert","avoid","awake","award","aware","awful","awoke","axial",
  "badge","basic","basil","basis","baste","batch","bathe","bayou","beach","beard",
  "beast","began","begin","being","below","bench","berry","bible","birch","birth",
  "black","blade","blame","bland","blank","blare","blast","blaze","bleak","blend",
  "bless","bliss","block","blood","bloom","blown","board","boast","boggy","bonus",
  "boost","booth","bound","brain","brand","brave","bread","break","breed","brief",
  "bring","broad","broke","brook","broom","brown","brush","built","burst","butch",
  "buyer","byway",
  "camel","candy","cargo","carry","carve","caste","catch","cause","cedar","chain",
  "chair","chalk","champ","chaos","charm","chart","chase","cheat","cheek","cheer",
  "chess","chest","chief","child","chill","chimp","choir","chord","civil","clamp",
  "clang","clash","clasp","class","claw","clean","clear","cleft","clerk","click",
  "cliff","climb","cling","cloak","clock","close","cloth","cloud","clump","coast",
  "cobra","color","comet","comic","comma","coral","could","count","court","cover",
  "covet","craft","crane","crash","crave","crawl","creak","creek","crest","crisp",
  "cross","crowd","crown","cruel","crush","crust","crypt","curly","curve","cycle",
  "daisy","dance","deals","debut","decoy","deity","delay","delta","delve","demon",
  "depot","depth","derby","deter","digit","dimly","dirty","disco","ditty","dodge",
  "dogma","dolce","dowry","draft","drain","drama","drape","dream","dress","drift",
  "drink","drive","drool","drove","drown","drugs","dryer","dully","dummy","dunce",
  "dwarf","dwell","dying",
  "eager","early","earth","eight","elite","email","ember","emote","empty","enact",
  "enjoy","enter","entry","equal","equip","error","ethic","evade","event","every",
  "exact","exert","exist","extra","exult",
  "fable","faith","false","fancy","faint","fatal","fault","feast","feral","ferry",
  "fetch","fever","fiber","field","fiend","fiery","fifth","fifty","fight","final",
  "first","fixed","fjord","flame","flank","flare","flash","flask","flats","flesh",
  "flick","fling","flint","float","flock","flood","floor","flour","flout","flown",
  "flute","focus","foggy","force","forge","forth","forum","found","frame","frank",
  "fraud","fresh","front","frost","froze","frugal","fruit","fumed","funny","furry",
  "fused","fuzzy",
  "gavel","geese","giant","giddy","given","gizmo","glacé","gland","glare","glass",
  "glaze","gleam","glide","gloat","globe","gloom","glory","gloss","glove","gnome",
  "going","goose","grace","grade","grain","grand","grant","grasp","grass","grave",
  "graze","great","greed","greet","grief","grill","grimy","grind","groan","groin",
  "grope","gross","group","growl","grown","gruel","guard","guess","guest","guide",
  "guild","guile","guilt","guise","gusto",
  "habit","happy","harsh","haven","heart","heavy","hedge","herbs","heron","hexed",
  "hinge","hippo","hoist","holly","homer","honey","honor","horde","hotel","hound",
  "hover","human","humid","hurry","hyena","hyper",
  "ideal","igloo","image","impel","inept","infer","inner","inset","inter","inure",
  "irony","issue",
  "jazzy","jewel","jiffy","joint","joker","joust","judge","juice","juicy","jumpy",
  "knack","kneel","knife","knock","known",
  "label","lance","large","laser","latch","later","laugh","layer","leach","leafy",
  "learn","least","ledge","legal","lemon","level","libel","light","lilac","limit",
  "linen","liver","llama","local","lodge","lofty","logic","loose","lotus","lousy",
  "lover","lower","lucid","lucky","lunar","lunch","lusty","lying",
  "magic","major","maker","mambo","manic","maple","march","marsh","matte","mayor",
  "mealy","meant","medal","media","melee","mercy","merit","metal","might","mince",
  "minor","minus","mirth","miser","mixed","moose","moral","mossy","mourn","mouth",
  "moody","movie","muddy","mural","music","musty","myrrh","mysql","mystic","myth",
  "naive","nasty","naval","nerve","never","night","ninja","noble","noise","noisy",
  "nomad","noted","novel","nudge","nymph",
  "oaken","occur","offer","olive","onset","opera","optic","order","other","outer",
  "ounce","ought","oxide","ozone",
  "paddy","paint","panic","paper","party","paste","patch","pause","peace","peach",
  "pearl","petal","petty","phase","phone","photo","piano","piece","pilot","pinch",
  "pixel","pizza","place","plain","plane","plank","plant","plate","plaza","plead",
  "pleat","pluck","plumb","plume","plump","plunge","plunk","plush","polar","polka",
  "poker","posit","potent","pound","power","prank","press","price","prick","pride",
  "prime","print","prior","prism","prize","probe","prone","prose","proud","prove",
  "prowl","prune","psalm","puffy","pulse","punch","pupil","purge","pushy","pygmy",
  "quack","quaff","qualm","queen","query","quest","queue","quiet","quirk","quota",
  "quote",
  "rabbi","radar","radio","rainy","raise","rally","ramen","raven","reach","react",
  "rebel","reedy","regal","reign","relax","relay","relic","remit","repay","repel",
  "rider","ridge","right","risky","rivet","robot","rocky","rogue","round","route",
  "rover","rowdy","ruler","runny","rural","rusty",
  "sadly","saint","salad","satin","sauce","savor","savvy","scald","scalp","scam",
  "scamp","scant","scarf","scary","scoff","scold","scone","score","scorn","scout",
  "scowl","scram","scrap","screw","scrub","seize","sense","serum","serve","shack",
  "shade","shady","shake","shall","shame","shape","share","sharp","shear","sheen",
  "sheer","shelf","shell","shift","shine","shirt","shone","shook","shore","short",
  "shout","shrug","sight","silky","since","sixth","sixty","sized","skate","skill",
  "skimp","skirt","skull","slant","slash","slate","slave","sleek","sleep","sleet",
  "slick","slide","slime","sling","sloth","slump","slunk","slyly","smart","smash",
  "smear","smell","smelt","smile","smirk","smoke","snack","snail","snake","snare",
  "sneak","sneer","sniff","snore","snort","snowy","snuck","soapy","solar","solid",
  "solve","songs","sonic","sorry","south","space","spade","spare","spark","spasm",
  "speak","spear","speck","speed","spell","spend","spice","spill","spine","spire",
  "spite","splat","split","spoke","sport","spout","spree","sprig","spunk","squad",
  "squat","squid","stack","staff","stage","stain","stair","stake","stale","stall",
  "stand","stank","stare","stark","start","state","steal","steam","steel","steep",
  "steer","stern","stick","stiff","still","sting","stock","stoic","stomp","stood",
  "store","stork","storm","story","stout","stove","strap","straw","stray","strip",
  "strut","study","stump","stung","stunk","style","sugar","suite","sulky","sunny",
  "super","surge","swamp","swear","sweat","sweet","swift","swine","swirl","sword",
  "swore","syrup",
  "table","taunt","teary","tense","thank","theme","there","these","thick","thing",
  "think","thorn","those","three","threw","throw","thumb","tiger","tight","timer",
  "tired","title","toast","today","token","tonic","tooth","torch","total","touch",
  "tough","towel","tower","toxic","trail","train","trait","tramp","trash","trawl",
  "tread","treat","trend","trial","tribe","trick","tried","tripe","troop","trout",
  "truck","trump","trunk","truss","trust","truth","tulip","tumor","tuner","tunic",
  "twist","tying",
  "ultra","uncut","under","unfed","unfit","unity","unlit","until","upper","upset",
  "urban","usage","usher","usurp","utter",
  "vague","valid","valor","valve","vapor","vault","vaunt","vicar","vigor","viral",
  "virus","visit","visor","vista","vivid","vocal","vodka","voice","vouch","vying",
  "waltz","waste","watch","water","weary","weave","wedge","weird","whale","whack",
  "wheat","wheel","where","which","while","whiff","whole","whose","wider","wield",
  "windy","witch","witty","women","world","worry","worse","worst","worth","would",
  "wound","wrath","wring","wrist","wrote","wryly",
  "yacht","yearn","yeast","young","youth","yummy",
  "zappy","zebra","zesty","zilch","zippy","zones","zoned"
]);

function normalizeWord(word) {
  return String(word || "").trim().toUpperCase();
}

function isFiveLetterWord(word) {
  return /^[A-Z]{5}$/.test(normalizeWord(word));
}

function isValidWord(word) {
  return VALID_WORDS.has(normalizeWord(word).toLowerCase());
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
  socket.on("room:create", (payload = {}, callback) => {
    const pin = String(payload.pin || "");
    const word = normalizeWord(payload.word);
    const name = isDisplayName(payload.name) ? payload.name.trim() : "Host";
    const category = String(payload.category || "Custom").trim().slice(0, 32);
    const customCategory = String(payload.customCategory || "").trim().slice(0, 32);
    const hint = String(payload.hint || "").trim().slice(0, 140);
    const roundTime = Number(payload.roundTime);
    const totalRounds = Number(payload.totalRounds);

    if (pin !== DEFAULT_PIN) return callback?.({ ok: false, error: "Invalid admin PIN." });
    if (!isFiveLetterWord(word)) return callback?.({ ok: false, error: "Word must be exactly 5 alphabetic characters." });
    if (!isValidWord(word)) return callback?.({ ok: false, error: "Please choose a common English word. Proper nouns and made-up words are not allowed." });

    const code = makeRoomCode();
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

    callback?.({ ok: true, room: getRoomSummary(room), playerId: socket.id, isHost: socket.id === room.hostId });
    emitPlayers(room, "room:playerJoined");
  });

  // Host starts the next round immediately, optionally replacing the next word/category/hint.
  socket.on("game:start", (payload = {}, callback) => {
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
    if (!isValidWord(word)) return callback?.({ ok: false, error: "Please choose a common English word. Proper nouns and made-up words are not allowed." });
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

    room.countdownInterval = setInterval(() => {
      remaining -= 1;
      io.to(room.code).emit("game:countdown", { remaining });
      if (remaining <= 0) {
        clearInterval(room.countdownInterval);
        room.countdownInterval = null;
        const word = payload.word ? normalizeWord(payload.word) : room.currentRoundConfig.word;
        if (!isFiveLetterWord(word)) {
          room.status = "lobby";
          io.to(room.code).emit("room:error", { error: "Word must be a common English word. Proper nouns not allowed." });
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
  socket.on("game:guess", (payload = {}, callback) => {
    const room = getRoomForSocket(socket);
    const player = room ? findPlayer(room, socket.id) : null;
    const guess = normalizeWord(payload.guess);

    if (!room || !player) return callback?.({ ok: false, error: "You are not in a room." });
    if (room.status !== "playing") return callback?.({ ok: false, error: "No round is currently active." });
    if (!player.active) return callback?.({ ok: false, error: "Inactive players cannot guess." });
    if (player.solved) return callback?.({ ok: false, error: "You already solved this round." });
    if (player.guesses.length >= MAX_GUESSES) return callback?.({ ok: false, error: "No guesses remaining." });
    if (!isFiveLetterWord(guess)) return callback?.({ ok: false, error: "Guess must be exactly 5 alphabetic characters." });

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
