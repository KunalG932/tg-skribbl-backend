import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import { buildAllowedOrigins } from './src/config/env.js';
import { initDb, ensureUser, incrementScore, getRoomsCol, getUsersCol, incrementGamesPlayed, addToTotalScore } from './src/db/mongo.js';
import { broadcastRoomState, startTurn, beginDrawingPhase, endTurn, nextTurnOrRound, allGuessed, clearRoomTimers } from './src/domain/rooms.js';
import { guessScoreForTime, drawerBonus } from './src/domain/scoring.js';
import { createRateLimiter } from './src/security/rateLimit.js';

const app = express();

const allowedOrigins = buildAllowedOrigins(process.env.NODE_ENV, process.env.ALLOWED_ORIGINS);
const normalizeOrigin = (o) => {
  try { return new URL(o).origin; } catch { return String(o || '').replace(/\/$/, ''); }
};
const allowedOriginSet = new Set(allowedOrigins.map(normalizeOrigin));

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const normalized = normalizeOrigin(origin);
    if (allowedOriginSet.has(normalized)) return cb(null, true);
    return cb(new Error('CORS not allowed for origin: ' + origin));
  },
  methods: ['GET','POST'],
}));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/leaderboard', async (_req, res) => {
  try {
    const roomsCol = getRoomsCol();
    const usersCol = getUsersCol();
    if (!usersCol) return res.json({ ok: true, users: [] });
    const top = await usersCol.find({}, { projection: { _id: 1, name: 1, score: 1, tgId: 1, avatarUrl: 1 } })
      .sort({ score: -1 })
      .limit(Number(process.env.LEADERBOARD_LIMIT || 20))
      .toArray();
    return res.json({ ok: true, users: top });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get('/api/rank', async (req, res) => {
  try {
    const usersCol = getUsersCol();
    if (!usersCol) return res.json({ ok: true, rank: null, total: 0 });
    const tgId = req.query.tgId ? String(req.query.tgId) : null;
    if (!tgId) return res.json({ ok: true, rank: null, total: 0 });
    const user = await usersCol.findOne({ _id: tgId }, { projection: { score: 1 } });
    const total = await usersCol.countDocuments({});
    if (!user) return res.json({ ok: true, rank: null, total });
    const greater = await usersCol.countDocuments({ score: { $gt: Number(user.score || 0) } });
    const rank = greater + 1;
    return res.json({ ok: true, rank, total });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get('/api/profile', async (req, res) => {
  try {
    const usersCol = getUsersCol();
    if (!usersCol) return res.json({ ok: true, user: null });
    const tgId = req.query.tgId ? String(req.query.tgId) : null;
    if (!tgId) return res.json({ ok: true, user: null });
    const user = await usersCol.findOne({ _id: String(tgId) }, { projection: { _id: 1, name: 1, score: 1, tgId: 1, avatarUrl: 1, stats: 1 } });
    return res.json({ ok: true, user });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post('/api/profile', async (req, res) => {
  try {
    const usersCol = getUsersCol();
    if (!usersCol) return res.json({ ok: true });
    const { tgId, name, avatarUrl } = req.body || {};
    if (!tgId) return res.status(400).json({ ok: false, error: 'tgId required' });
    const _id = String(tgId);
    const $set = {};
    if (name) $set.name = String(name).slice(0, 50);
    if (avatarUrl) $set.avatarUrl = String(avatarUrl);
    await usersCol.updateOne({ _id }, { $set: { _id, tgId: _id, ...$set } }, { upsert: true });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// On startup, cleanup any persisted theme fields from users collection
(async () => {
  try {
    const usersCol = getUsersCol();
    if (usersCol) {
      await usersCol.updateMany({ theme: { $exists: true } }, { $unset: { theme: '' } });
    }
  } catch {}
})();

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const normalized = normalizeOrigin(origin);
      if (allowedOriginSet.has(normalized)) return cb(null, true);
      return cb(new Error('Socket.IO CORS not allowed: ' + origin));
    },
    methods: ['GET', 'POST'],
  },
});

const rooms = new Map();
const DEFAULTS = { roundTime: 75, maxRounds: 3 };
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 12);
const ROOM_CLEANUP_MS = 60000; // delete ended rooms after 60s

// Helper: apply late-join policy consistently
function applyLateJoinPolicy(room, socketId) {
  if (!room) return;
  if (room.phase !== 'waiting' && room.phase !== 'ended') {
    const order = Array.isArray(room.playerOrder) ? room.playerOrder : Array.from(room.players.keys());
    if (!order.includes(socketId)) {
      const insertAt = (room.drawerIndex + 1) % (order.length + 1);
      order.splice(insertAt, 0, socketId);
      room.playerOrder = order;
    }
  }
}

setInterval(() => {
  try {
    for (const [code, room] of rooms.entries()) {
      if (room && room.phase === 'ended') {
        try { clearRoomTimers(room); } catch {}
        rooms.delete(code);
      }
    }
  } catch {}
}, ROOM_CLEANUP_MS);

function isCloseGuess(guess, word) {
  let a = guess.toLowerCase().trim();
  let b = word.toLowerCase().trim();
  if (!a || !b) return false;
  // Early exit: large length difference relative to answer
  const maxClose = Math.max(1, Math.floor(b.length * 0.25));
  if (Math.abs(a.length - b.length) > maxClose) return false;
  // Limit computation cost
  const MAX_LEN = 40;
  if (a.length > MAX_LEN) a = a.slice(0, MAX_LEN);
  if (b.length > MAX_LEN) b = b.slice(0, MAX_LEN);
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
    joinedSet: new Set(),
    hostId: null,
  };
  rooms.set(code, room);
  return room;
}

function normalizeDrawerIndex(room) {
  const len = Array.isArray(room.playerOrder) ? room.playerOrder.length : room.players.size;
  if (len <= 0) {
    room.drawerIndex = 0;
  } else if (room.drawerIndex >= len) {
    room.drawerIndex = room.drawerIndex % len;
  } else if (room.drawerIndex < 0) {
    room.drawerIndex = 0;
  }
}

function removeFromPlayerOrder(room, socketId) {
  const order = Array.isArray(room.playerOrder) ? room.playerOrder : null;
  if (!order) return;
  const idx = order.indexOf(socketId);
  if (idx !== -1) {
    order.splice(idx, 1);
    // If removed index is before or equal current drawerIndex, shift left
    if (room.drawerIndex >= idx) room.drawerIndex = Math.max(0, room.drawerIndex - 1);
    room.playerOrder = order;
  }
  normalizeDrawerIndex(room);
}

function addToPlayerOrderAfterDrawer(room, socketId) {
  const order = Array.isArray(room.playerOrder) ? room.playerOrder : [];
  const insertAt = ((room.drawerIndex || 0) + 1) % (order.length + 1);
  order.splice(insertAt, 0, socketId);
  room.playerOrder = order;
  normalizeDrawerIndex(room);
}

function verifyTelegramInitData(initData, botToken) {
  try {
    if (!initData || !botToken) return false;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const data = Array.from(params.entries())
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');
    const secret = crypto.createHash('sha256').update(botToken).digest();
    const hmac = crypto.createHmac('sha256', secret).update(data).digest('hex');
    return hmac === hash;
  } catch { return false; }
}

const mongoUri = process.env.MONGODB_URI;

io.on('connection', (socket) => {
  const chatLimiter = createRateLimiter({ count: 5, windowMs: 3000 });
  const drawLimiter = createRateLimiter({ count: 120, windowMs: 3000 });
  const roomCreateLimiter = createRateLimiter({ count: 3, windowMs: 10000 });
  const roomJoinLimiter = createRateLimiter({ count: 5, windowMs: 5000 });
  const startGameLimiter = createRateLimiter({ count: 2, windowMs: 10000 });
  
  socket.on('create_room', ({ code }) => {
    if (!roomCreateLimiter.allow()) {
      io.to(socket.id).emit('chat', { system: true, message: 'Slow down: creating rooms too fast.' });
      return;
    }
    if (!code) return;
    const raw = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(raw)) {
      io.to(socket.id).emit('app_error', { code: 'INVALID_ROOM_CODE', room: raw });
      io.to(socket.id).emit('chat', { system: true, message: 'Invalid room code. Use 4 letters/numbers (e.g., AB1C).' });
      return;
    }
    (async () => {
      try {
        const roomsCol = getRoomsCol();
        if (roomsCol) {
          const r = await roomsCol.findOne({ _id: raw });
          if (r && r.phase !== 'ended') {
            io.to(socket.id).emit('app_error', { code: 'ROOM_EXISTS', room: raw });
            io.to(socket.id).emit('chat', { system: true, message: `Room ${raw} already exists.` });
            return;
          }
          await roomsCol.updateOne(
            { _id: raw },
            { $set: { _id: raw, phase: 'waiting', createdAt: new Date(), endedAt: null } },
            { upsert: true }
          );
        }
      } catch {}
      const created = createRoom(raw);
      if (!created.hostId) created.hostId = socket.id;
      io.to(socket.id).emit('chat', { system: true, message: `Room ${created.code} created.` });
      io.to(socket.id).emit('room_created', { code: created.code });
      broadcastRoomState(io, created);
    })();
  });

  socket.on('join_room', async ({ code, name, tgId, initData }) => {
    if (!roomJoinLimiter.allow()) {
      io.to(socket.id).emit('chat', { system: true, message: 'Slow down: joining too fast.' });
      return;
    }
    const raw = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(raw)) {
      io.to(socket.id).emit('app_error', { code: 'INVALID_ROOM_CODE', room: raw });
      io.to(socket.id).emit('chat', { system: true, message: 'Invalid room code. Use 4 letters/numbers (e.g., AB1C).' });
      return;
    }

    // Optional Telegram auth enforcement: if bot token is configured, require valid initData
    const botToken = process.env.TG_BOT_TOKEN;
    if (botToken) {
      const ok = verifyTelegramInitData(initData, botToken);
      if (!ok) {
        io.to(socket.id).emit('app_error', { code: 'AUTH_FAILED' });
        io.to(socket.id).emit('chat', { system: true, message: 'Authentication failed. Please open inside Telegram.' });
        return;
      }
    }

    const roomsCol = getRoomsCol();
    if (roomsCol) {
      try {
        const r = await roomsCol.findOne({ _id: raw });
        if (!r) {
          io.to(socket.id).emit('chat', { system: true, message: `Room ${raw} not found. Ask host to create it.` });
          io.to(socket.id).emit('app_error', { code: 'ROOM_NOT_FOUND', room: raw });
          return;
        }
        if (r.phase !== 'waiting') {
          const reason = r.phase === 'ended' ? 'has ended' : `is not joinable (current phase: ${r.phase})`;
          io.to(socket.id).emit('chat', { system: true, message: `Room ${raw} ${reason}.` });
          io.to(socket.id).emit('app_error', { code: r.phase === 'ended' ? 'ROOM_ENDED' : 'ROOM_NOT_WAITING', room: raw, phase: r.phase });
          return;
        }
      } catch {}
      
      let room = getRoom(raw);
      if (!room) {
        room = createRoom(raw);
      }
      // Capture or reconcile host identity
      if (!room.hostId) room.hostId = socket.id; // should already be set by create_room
      // Only the original host socket may stamp hostTgId
      if (!room.hostTgId && tgId && socket.id === room.hostId) {
        room.hostTgId = String(tgId);
      }
      // If the same host (by tgId) reconnects with a new socket, move hostId
      if (room.hostTgId && tgId && String(room.hostTgId) === String(tgId)) {
        room.hostId = socket.id;
      }
      
      if (room.players.has(socket.id)) {
        const p = room.players.get(socket.id);
        p.name = name?.slice(0, 24) || p.name;
        p.tgId = tgId || p.tgId;
        socket.join(raw);
        socket.join(socket.id);
        broadcastRoomState(io, room);
        return;
      }
      
      if (tgId) {
        for (const [sid, p] of room.players.entries()) {
          if (p.tgId && String(p.tgId) === String(tgId) && sid !== socket.id) {
            room.players.delete(sid);
            try { io.sockets.sockets.get(sid)?.leave(raw); } catch {}
          }
        }
      }
      
      if (room.players.size >= MAX_PLAYERS) {
        io.to(socket.id).emit('app_error', { code: 'ROOM_FULL', room: raw });
        io.to(socket.id).emit('chat', { system: true, message: `Room ${raw} is full.` });
        return;
      }
      
      socket.join(raw);
      socket.join(socket.id);
      room.players.set(socket.id, {
        id: socket.id, 
        name: name?.slice(0, 24) || 'Player', 
        tgId: tgId || null,
        score: 0, 
        guessed: false
      });
      
      try { await ensureUser(tgId || socket.id, name, tgId); } catch {}
      // Late-join policy: include joiner in current game's order
      applyLateJoinPolicy(room, socket.id);
      
      broadcastRoomState(io, room);
      io.to(raw).emit('chat', { system: true, message: `${name || 'Player'} joined.` });
      return;
    }
    
    const room = getRoom(raw);
    if (!room) {
      io.to(socket.id).emit('chat', { system: true, message: `Room ${raw} not found. Ask host to create it.` });
      io.to(socket.id).emit('app_error', { code: 'ROOM_NOT_FOUND', room: raw });
      return;
    }
    
    if (room.phase !== 'waiting') {
      const reason = room.phase === 'ended' ? 'has ended' : `is not joinable (current phase: ${room.phase})`;
      io.to(socket.id).emit('chat', { system: true, message: `Room ${raw} ${reason}.` });
      io.to(socket.id).emit('app_error', { code: room.phase === 'ended' ? 'ROOM_ENDED' : 'ROOM_NOT_WAITING', room: raw, phase: room.phase });
      return;
    }
    
    if (room.players.has(socket.id)) {
      const p = room.players.get(socket.id);
      p.name = name?.slice(0, 24) || p.name;
      p.tgId = tgId || p.tgId;
      socket.join(raw);
      socket.join(socket.id);
      broadcastRoomState(io, room);
      return;
    }
    
    if (tgId) {
      for (const [sid, p] of room.players.entries()) {
        if (p.tgId && String(p.tgId) === String(tgId) && sid !== socket.id) {
          room.players.delete(sid);
          try { io.sockets.sockets.get(sid)?.leave(raw); } catch {}
        }
      }
    }
    
    if (room.players.size >= MAX_PLAYERS) {
      io.to(socket.id).emit('app_error', { code: 'ROOM_FULL', room: raw });
      io.to(socket.id).emit('chat', { system: true, message: `Room ${raw} is full.` });
      return;
    }
    
    socket.join(raw);
    socket.join(socket.id);
    room.players.set(socket.id, {
      id: socket.id, 
      name: name?.slice(0, 24) || 'Player', 
      tgId: tgId || null,
      score: 0, 
      guessed: false
    });
    
    try { await ensureUser(tgId || socket.id, name, tgId); } catch {}
    // Late-join policy: include joiner in current game's order
    applyLateJoinPolicy(room, socket.id);
    
    broadcastRoomState(io, room);
    io.to(raw).emit('chat', { system: true, message: `${name || 'Player'} joined.` });
  });

  socket.on('leave_room', async ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    room.players.delete(socket.id);
    removeFromPlayerOrder(room, socket.id);
    socket.leave(code);
    io.to(code).emit('chat', { system: true, message: 'A player left.' });
    broadcastRoomState(io, room);
    // Cleanup: delete room if empty
    if (room.players.size === 0) {
      try { clearRoomTimers(room); } catch {}
      try {
        const roomsCol = getRoomsCol();
        if (roomsCol) await roomsCol.updateOne({ _id: code }, { $set: { phase: 'ended', endedAt: new Date() } });
      } catch {}
      rooms.delete(code);
    }
  });

  // Allow host to explicitly close a room
  socket.on('close_room', async ({ code }) => {
    try {
      const raw = String(code || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(raw)) {
        io.to(socket.id).emit('app_error', { code: 'INVALID_ROOM_CODE', room: raw });
        return;
      }
      const room = rooms.get(raw);
      if (!room) {
        io.to(socket.id).emit('app_error', { code: 'ROOM_NOT_FOUND', room: raw });
        return;
      }
      // Only host may close the room (allow by hostId or hostTgId match)
      const player = room.players.get(socket.id);
      const isHostById = room.hostId && socket.id === room.hostId;
      const isHostByTg = room.hostTgId && player?.tgId && String(room.hostTgId) === String(player.tgId);
      if (!(isHostById || isHostByTg)) {
        io.to(socket.id).emit('app_error', { code: 'NOT_HOST', room: raw });
        return;
      }
      // Mark ended in memory
      room.phase = 'ended';
      try { clearRoomTimers(room); } catch {}
      // Persist ended status if Mongo is configured
      try {
        const roomsCol = getRoomsCol();
        if (roomsCol) {
          await roomsCol.updateOne({ _id: raw }, { $set: { phase: 'ended', endedAt: new Date() } });
        }
      } catch {}
      io.to(raw).emit('chat', { system: true, message: `Room ${raw} was closed by host.` });
      broadcastRoomState(io, room);
    } catch {}
  });

  socket.on('start_game', ({ code }) => {
    if (!startGameLimiter.allow()) {
      io.to(socket.id).emit('chat', { system: true, message: 'Slow down: starting games too fast.' });
      return;
    }
    const room = rooms.get(code);
    if (!room) return;
    if (room.players.size < 2) return;
    if (room.phase !== 'waiting') return;
    room.round = 1;
    room.drawerIndex = 0;
    room.phase = 'choosing';
    room.playerOrder = Array.from(room.players.keys());
    room._turnStartedAt = Date.now();
    startTurn(io, room);
    io.to(code).emit('game_started', { ok: true });
  });

  socket.on('choose_word', ({ code, word }) => {
    const room = rooms.get(code);
    if (!room) return;
    const drawerId = Array.from(room.players.keys())[room.drawerIndex];
    if (socket.id !== drawerId) return;
    if (!room.choices.includes(word)) return;
    room._turnStartedAt = Date.now();
    beginDrawingPhase(io, room, DEFAULTS, word);
    io.to(socket.id).emit('word_chosen', { ok: true });
  });

  socket.on('draw', ({ code, stroke }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'drawing') return;
    const drawerId = Array.from(room.players.keys())[room.drawerIndex];
    if (socket.id !== drawerId) return;
    
    if (!drawLimiter.allow()) {
      return;
    }
    
    if (!stroke || typeof stroke !== 'object') return;
    const type = typeof stroke.type === 'string' ? stroke.type : '';
    const allowedTypes = new Set(['begin', 'line', 'clear']);
    if (!allowedTypes.has(type)) return;

    const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
    const inRange = (v) => isNum(v) && v >= -10000 && v <= 10000; // bound coords
    const size = Math.max(1, Math.min(16, Number(stroke.size || 4)));
    const colorRaw = typeof stroke.color === 'string' ? stroke.color.slice(0, 16) : '#111111';
    const hexColor = /^#?[0-9A-Fa-f]{3,8}$/.test(colorRaw) ? (colorRaw.startsWith('#') ? colorRaw : '#' + colorRaw) : '#111111';

    let valid = false;
    let payload = { type };

    if (type === 'begin') {
      if (inRange(stroke.x) && inRange(stroke.y)) {
        valid = true;
        payload.x = Number(stroke.x);
        payload.y = Number(stroke.y);
      }
    } else if (type === 'line') {
      if (inRange(stroke.x1) && inRange(stroke.y1) && inRange(stroke.x2) && inRange(stroke.y2)) {
        valid = true;
        payload.x1 = Number(stroke.x1);
        payload.y1 = Number(stroke.y1);
        payload.x2 = Number(stroke.x2);
        payload.y2 = Number(stroke.y2);
      }
    } else if (type === 'clear') {
      valid = true;
    }

    if (!valid) return;
    payload.size = size;
    payload.color = hexColor;
    socket.to(code).emit('draw', payload);
  });

  socket.on('chat', async ({ code, message, name }) => {
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    
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
        const bonus = drawerBonus();
        if (drawer) drawer.score += bonus;

        try {
          await incrementScore(player.tgId || player.id, guessScore);
          await addToTotalScore(player.tgId || player.id, guessScore);
          if (drawer) {
            await incrementScore(drawer.tgId || drawer.id, bonus);
            await addToTotalScore(drawer.tgId || drawer.id, bonus);
          }
        } catch {}

        io.to(socket.id).emit('chat', { system: true, message: 'You guessed the word!' });
        io.to(room.code).emit('chat', { system: true, message: `${player.name} guessed the word!` });
        broadcastRoomState(io, room);

        if (allGuessed(room)) {
          const minDrawMs = 4000;
          const elapsed = Date.now() - (room._turnStartedAt || 0);
          if (elapsed >= minDrawMs) {
            endTurn(io, room);
          } else {
            const delay = Math.max(0, minDrawMs - elapsed);
            setTimeout(() => {
              if (room.phase === 'drawing') {
                try { endTurn(io, room); } catch {}
              }
            }, delay);
          }
        }
        return;
      } else if (!player.guessed && isCloseGuess(text, room.currentWord)) {
        io.to(socket.id).emit('chat', { system: true, message: 'Close!' });
        return;
      }
    }
    // Prevent name spoofing: always use server-side player.name
    io.to(code).emit('chat', { name: player.name, message: text });
  });

  socket.on('disconnecting', async () => {
    for (const code of socket.rooms) {
      if (rooms.has(code)) {
        const room = rooms.get(code);
        const wasDrawerId = Array.from(room.players.keys())[room.drawerIndex];
        room.players.delete(socket.id);
        removeFromPlayerOrder(room, socket.id);
        io.to(code).emit('chat', { system: true, message: 'A player disconnected.' });
        broadcastRoomState(io, room);
        if (socket.id === wasDrawerId && (room.phase === 'drawing' || room.phase === 'choosing')) {
          try { endTurn(io, room); } catch {}
        }
        // Cleanup: delete room if empty
        if (room.players.size === 0) {
          try { clearRoomTimers(room); } catch {}
          try {
            const roomsCol = getRoomsCol();
            if (roomsCol) await roomsCol.updateOne({ _id: code }, { $set: { phase: 'ended', endedAt: new Date() } });
          } catch {}
          rooms.delete(code);
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
  // Reconcile room states in Mongo to avoid stale non-waiting phases after crashes
  try {
    const roomsCol = getRoomsCol();
    if (roomsCol) {
      // Any room not ended should be set to waiting on startup
      await roomsCol.updateMany({ phase: { $nin: ['waiting', 'ended'] } }, { $set: { phase: 'waiting' } });
      // Optionally end very old rooms with endedAt far in the past is handled by TTL index in db setup
    }
  } catch (e) {
    console.warn('Room reconciliation failed:', e?.message || e);
  }
  server.listen(port, () => {
    console.log(`Server listening on :${port}`);
  });
})();