import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
// modular imports
import { buildAllowedOrigins } from './src/config/env.js';
import { initDb, ensureUser, incrementScore, getRoomsCol, getUsersCol } from './src/db/mongo.js';
import { WORDS } from './src/domain/words.js';
import { broadcastRoomState, startTurn, beginDrawingPhase, endTurn, nextTurnOrRound, allGuessed } from './src/domain/rooms.js';
// Telegram verification removed: joins and profile no longer require initData
import { guessScoreForTime, drawerBonus } from './src/domain/scoring.js';
import { createRateLimiter } from './src/security/rateLimit.js';

const app = express();

// Build allowed origins from environment (localhost only allowed in dev)
const allowedOrigins = buildAllowedOrigins(process.env.NODE_ENV, process.env.ALLOWED_ORIGINS);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow non-browser tools
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('CORS not allowed for origin: ' + origin));
  },
  methods: ['GET','POST'],
}));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));
// Leaderboard and profile APIs
app.get('/api/leaderboard', async (_req, res) => {
  try {
    const roomsCol = getRoomsCol();
    const usersCol = getUsersCol()
    if (!usersCol) return res.json({ ok: true, users: [] })
    const top = await usersCol.find({}, { projection: { _id: 1, name: 1, score: 1, tgId: 1, avatarUrl: 1, theme: 1 } })
      .sort({ score: -1 })
      .limit(Number(process.env.LEADERBOARD_LIMIT || 20))
      .toArray()
    return res.json({ ok: true, users: top })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
})

app.get('/api/profile', async (req, res) => {
  try {
    const usersCol = getUsersCol()
    if (!usersCol) return res.json({ ok: true, user: null })
    const tgId = req.query.tgId ? String(req.query.tgId) : null
    if (!tgId) return res.json({ ok: true, user: null })
    const user = await usersCol.findOne({ _id: String(tgId) }, { projection: { _id: 1, name: 1, score: 1, tgId: 1, avatarUrl: 1, theme: 1, stats: 1 } })
    return res.json({ ok: true, user })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
})

// Save user profile/theme/avatar
app.post('/api/profile', async (req, res) => {
  try {
    const usersCol = getUsersCol()
    if (!usersCol) return res.json({ ok: true })
    const { tgId, name, avatarUrl, theme } = req.body || {}
    if (!tgId) return res.status(400).json({ ok: false, error: 'tgId required' })
    const _id = String(tgId)
    const $set = {}
    if (name) $set.name = String(name).slice(0, 50)
    if (avatarUrl) $set.avatarUrl = String(avatarUrl)
    if (theme === 'light' || theme === 'dark') $set.theme = theme
    await usersCol.updateOne({ _id }, { $set: { _id, tgId: _id, ...$set } }, { upsert: true })
    return res.json({ ok: true })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
})

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('Socket.IO CORS not allowed: ' + origin));
    },
    methods: ['GET', 'POST'],
  },
});

const rooms = new Map();
const DEFAULTS = { roundTime: 75, maxRounds: 3 };
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 12);

function isCloseGuess(guess, word) {
  const a = guess.toLowerCase().trim();
  const b = word.toLowerCase().trim();
  if (!a || !b) return false;
  const maxClose = Math.max(1, Math.floor(b.length * 0.25));
  const dp = Array(b.length + 1).fill(0);
  for (let j = 0; j <= b.length; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j-1] + 1,
        prev + (a[i-1] === b[j-1] ? 0 : 1)
      );
      prev = temp;
    }
  }
  return dp[b.length] <= maxClose;
}

// lifecycle functions moved to domain/rooms.js

function getRoom(code) {
  return rooms.get(code);
}

function createRoom(code) {
  if (rooms.has(code)) return rooms.get(code);
  const room = {
    code,
    players: new Map(),
    drawerIndex: 0,
    round: 1,
    maxRounds: DEFAULTS.maxRounds,
    currentWord: null,
    hint: null,
    phase: 'waiting',
    timer: 0,
    choices: [],
  };
  rooms.set(code, room);
  return room;
}

// ----------------- MongoDB via module -----------------
const mongoUri = process.env.MONGODB_URI;

io.on('connection', (socket) => {
  // Per-socket rate limiting using sliding windows
  const chatLimiter = createRateLimiter({ count: 5, windowMs: 3000 })
  const drawLimiter = createRateLimiter({ count: 120, windowMs: 3000 })
  socket.on('create_room', ({ code }) => {
    if (!code) return;
    const raw = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(raw)) {
      io.to(socket.id).emit('error', { code: 'INVALID_ROOM_CODE', room: raw });
      io.to(socket.id).emit('chat', { system: true, message: 'Invalid room code. Use 4 letters/numbers (e.g., AB1C).' });
      return;
    }
    (async () => {
      try {
        const roomsCol = getRoomsCol();
        if (roomsCol) {
          const r = await roomsCol.findOne({ _id: raw });
          if (r && r.phase !== 'ended') {
            io.to(socket.id).emit('error', { code: 'ROOM_EXISTS', room: raw });
            io.to(socket.id).emit('chat', { system: true, message: `Room ${raw} already exists.` });
            return;
          }
          // Create or overwrite ended room with new waiting state
          await roomsCol.updateOne(
            { _id: raw },
            { $set: { _id: raw, phase: 'waiting', createdAt: new Date(), endedAt: null } },
            { upsert: true }
          );
        }
      } catch {}
      const created = createRoom(raw);
      io.to(socket.id).emit('chat', { system: true, message: `Room ${created.code} created.` });
      // Explicit ack to fix create/join race on the client
      io.to(socket.id).emit('room_created', { code: created.code });
      broadcastRoomState(io, created);
    })();
  });

  socket.on('join_room', async ({ code, name, tgId, initData }) => {
    const raw = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(raw)) {
      io.to(socket.id).emit('chat', { system: true, message: 'Invalid room code. Use 4 letters/numbers (e.g., AB1C).' });
      io.to(socket.id).emit('error', { code: 'INVALID_ROOM_CODE', room: raw });
      return;
    }
    // Authentication removed: accept provided name/tgId; ignore initData

    // Validate against DB if available
    {
      const roomsCol = getRoomsCol();
      if (roomsCol) {
      try {
        const r = await roomsCol.findOne({ _id: raw });
        if (!r) {
          io.to(socket.id).emit('chat', { system: true, message: `Room ${raw} not found. Ask host to create it.` });
          io.to(socket.id).emit('error', { code: 'ROOM_NOT_FOUND', room: raw });
          return;
        }
        if (r.phase !== 'waiting') {
          const reason = r.phase === 'ended' ? 'has ended' : `is not joinable (current phase: ${r.phase})`;
          io.to(socket.id).emit('chat', { system: true, message: `Room ${raw} ${reason}.` });
          io.to(socket.id).emit('error', { code: r.phase === 'ended' ? 'ROOM_ENDED' : 'ROOM_NOT_WAITING', room: raw, phase: r.phase });
          return;
        }
      } catch {}
      let room = getRoom(raw);
      if (!room) {
        // Materialize in-memory room from DB (validated waiting)
        room = createRoom(raw);
      }
      // Prevent duplicates: if this socket already present, just refresh info
      if (room.players.has(socket.id)) {
        const p = room.players.get(socket.id);
        p.name = name?.slice(0, 24) || p.name;
        p.tgId = tgId || p.tgId;
        socket.join(raw);
        socket.join(socket.id);
        broadcastRoomState(io, room);
        return;
      }
      // If same Telegram user already in room from another session, remove old entry
      if (tgId) {
        for (const [sid, p] of room.players.entries()) {
          if (p.tgId && String(p.tgId) === String(tgId) && sid !== socket.id) {
            room.players.delete(sid);
            try { io.sockets.sockets.get(sid)?.leave(raw); } catch {}
          }
        }
      }
      if (room.players.size >= MAX_PLAYERS) {
        io.to(socket.id).emit('error', { code: 'ROOM_FULL', room: raw });
        io.to(socket.id).emit('chat', { system: true, message: `Room ${raw} is full.` });
        return;
      }
      // proceed with join using validated room
      socket.join(raw);
      socket.join(socket.id);
      room.players.set(socket.id, {
        id: socket.id, name: name?.slice(0, 24) || 'Player', tgId: tgId || null,
        score: 0, guessed: false
      });
      try { await ensureUser(tgId || socket.id, name, tgId); } catch {}
      broadcastRoomState(io, room);
      io.to(raw).emit('chat', { system: true, message: `${name || 'Player'} joined.` });
      return;
    }
    }
    // If no DB, use in-memory validation only (never create on join)
    const room = getRoom(raw);
    if (!room) {
      io.to(socket.id).emit('chat', { system: true, message: `Room ${raw} not found. Ask host to create it.` });
      io.to(socket.id).emit('error', { code: 'ROOM_NOT_FOUND', room: raw });
      return;
    }
    if (room.phase !== 'waiting') {
      const reason = room.phase === 'ended' ? 'has ended' : `is not joinable (current phase: ${room.phase})`;
      io.to(socket.id).emit('chat', { system: true, message: `Room ${raw} ${reason}.` });
      io.to(socket.id).emit('error', { code: room.phase === 'ended' ? 'ROOM_ENDED' : 'ROOM_NOT_WAITING', room: raw, phase: room.phase });
      return;
    }
    // Prevent duplicates: if this socket already present, just refresh info
    if (room.players.has(socket.id)) {
      const p = room.players.get(socket.id);
      p.name = name?.slice(0, 24) || p.name;
      p.tgId = tgId || p.tgId;
      socket.join(raw);
      socket.join(socket.id);
      broadcastRoomState(io, room);
      return;
    }
    // If same Telegram user already in room from another session, remove old entry
    if (tgId) {
      for (const [sid, p] of room.players.entries()) {
        if (p.tgId && String(p.tgId) === String(tgId) && sid !== socket.id) {
          room.players.delete(sid);
          try { io.sockets.sockets.get(sid)?.leave(raw); } catch {}
        }
      }
    }
    if (room.players.size >= MAX_PLAYERS) {
      io.to(socket.id).emit('error', { code: 'ROOM_FULL', room: raw });
      io.to(socket.id).emit('chat', { system: true, message: `Room ${raw} is full.` });
      return;
    }
    socket.join(raw);
    socket.join(socket.id);
    room.players.set(socket.id, {
      id: socket.id, name: name?.slice(0, 24) || 'Player', tgId: tgId || null,
      score: 0, guessed: false
    });
    // ensure user exists in DB
    try { await ensureUser(tgId || socket.id, name, tgId); } catch {}
    broadcastRoomState(io, room);
    io.to(raw).emit('chat', { system: true, message: `${name || 'Player'} joined.` });
  });

  socket.on('leave_room', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    room.players.delete(socket.id);
    socket.leave(code);
    io.to(code).emit('chat', { system: true, message: 'A player left.' });
    broadcastRoomState(io, room);
  });

  socket.on('start_game', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    // require at least 2 players to start
    if (room.players.size < 2) return;
    if (room.phase !== 'waiting' && room.phase !== 'ended') return;
    room.round = 1;
    room.drawerIndex = 0;
    room.phase = 'choosing';
    // Initialize stable player order for rotation
    room.playerOrder = Array.from(room.players.keys());
    // Attach WORDS directly onto the live room object so domain functions mutate the actual room
    room.WORDS = WORDS;
    startTurn(io, room);
    io.to(code).emit('game_started', { ok: true })
  });

  socket.on('choose_word', ({ code, word }) => {
    const room = rooms.get(code);
    if (!room) return;
    const drawerId = Array.from(room.players.keys())[room.drawerIndex];
    if (socket.id !== drawerId) return;
    if (!room.choices.includes(word)) return;
    beginDrawingPhase(io, room, DEFAULTS, word);
    io.to(socket.id).emit('word_chosen', { ok: true })
  });

  socket.on('draw', ({ code, stroke }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'drawing') return;
    const drawerId = Array.from(room.players.keys())[room.drawerIndex];
    if (socket.id !== drawerId) return;
    // rate limit draw events
    if (!drawLimiter.allow()) {
      return;
    }
    // validate stroke payload
    if (!stroke || typeof stroke !== 'object') return;
    const type = stroke.type;
    const size = Math.max(1, Math.min(16, Number(stroke.size || 4)));
    const color = typeof stroke.color === 'string' && stroke.color.length <= 16 ? stroke.color : '#111111';
    const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
    let valid = false;
    if (type === 'begin') {
      valid = isNum(stroke.x) && isNum(stroke.y);
    } else if (type === 'line') {
      valid = isNum(stroke.x1) && isNum(stroke.y1) && isNum(stroke.x2) && isNum(stroke.y2);
    } else if (type === 'clear') {
      valid = true;
    }
    if (!valid) return;
    const safeStroke = { ...stroke, size, color };
    socket.to(code).emit('draw', safeStroke);
  });

  socket.on('chat', async ({ code, message, name }) => {
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    // rate limit chat
    if (!chatLimiter.allow()) {
      io.to(socket.id).emit('chat', { system: true, message: 'You are sending messages too fast.' });
      return;
    }
    const text = String(message || '').trim().slice(0, 140);
    if (!text) return;

    if (room.phase === 'drawing' && room.currentWord) {
      if (!player.guessed && text.toLowerCase() === room.currentWord.toLowerCase()) {
        player.guessed = true;
        const guessScore = guessScoreForTime(room.timer);
        player.score += guessScore;
        const drawerId = Array.from(room.players.keys())[room.drawerIndex];
        const drawer = room.players.get(drawerId);
        if (drawer) drawer.score += drawerBonus();

        // persist scores
        try {
          await incrementScore(player.tgId || player.id, guessScore);
          if (drawer) await incrementScore(drawer.tgId || drawer.id, drawerBonus());
        } catch {}

        io.to(socket.id).emit('chat', { system: true, message: 'You guessed the word!' });
        io.to(room.code).emit('chat', { system: true, message: `${player.name} guessed the word!` });
        broadcastRoomState(io, room);

        if (allGuessed(room)) {
          endTurn(io, room); // now will always advance to next drawer
        }
        return;
      } else if (!player.guessed && isCloseGuess(text, room.currentWord)) {
        io.to(socket.id).emit('chat', { system: true, message: 'Close!' });
        return;
      }
    }
    io.to(code).emit('chat', { name: name || player.name, message: text });
  });

  socket.on('disconnecting', () => {
    for (const code of socket.rooms) {
      if (rooms.has(code)) {
        const room = rooms.get(code);
        const wasDrawerId = Array.from(room.players.keys())[room.drawerIndex];
        room.players.delete(socket.id);
        io.to(code).emit('chat', { system: true, message: 'A player disconnected.' });
        broadcastRoomState(io, room);
        // If the drawer disconnected during an active choosing/drawing phase, end the turn early
        if (socket.id === wasDrawerId && (room.phase === 'drawing' || room.phase === 'choosing')) {
          try { endTurn(io, room); } catch {}
        }
      }
    }
  });
});

const port = process.env.PORT || 3000;
(async () => {
  try {
    await initDb(mongoUri, process.env.MONGODB_DB || 'scribbly');
  } catch (e) {
    console.warn('MongoDB init failed:', e?.message || e);
  }
  server.listen(port, () => {
    console.log(`Server listening on :${port}`);
  });
})();
