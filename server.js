import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import { MongoClient } from 'mongodb';

const app = express();

// Build allowed origins from environment
const dev = process.env.NODE_ENV !== 'production';
const envOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const defaultOrigins = ['https://tg-skribbl-frontend.vercel.app'];
const localOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const allowedOrigins = [...new Set([...(envOrigins.length ? envOrigins : defaultOrigins), ...(dev ? localOrigins : [])])];

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
const WORDS = [
  'cat','dog','house','car','tree','phone','pizza','guitar','rocket','flower',
  'computer','book','chair','bottle','mountain','river','sun','moon','star','cloud'
];

function randomChoices(arr, n) {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

function maskWord(word, revealed = new Set()) {
  return word.split('').map((ch, i) => (ch === ' ' ? ' ' : revealed.has(i) ? ch : '_')).join('');
}

function revealHintOverTime(room) {
  const { currentWord } = room;
  const indices = currentWord.split('').map((_, i) => i).filter(i => currentWord[i] !== ' ');
  const toReveal = new Set();
  const interval = Math.max(8, Math.floor(DEFAULTS.roundTime * 0.2));
  const hintInterval = setInterval(() => {
    if (room.phase !== 'drawing') { clearInterval(hintInterval); return; }
    if (indices.length === 0) { clearInterval(hintInterval); return; }
    const idx = indices.splice(Math.floor(Math.random()*indices.length), 1)[0];
    toReveal.add(idx);
    room.hint = maskWord(currentWord, toReveal);
    io.to(room.code).emit('hint_update', room.hint);
  }, interval * 1000);
}

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

function getNextDrawerIndex(room) {
  const playerIds = Array.from(room.players.keys());
  if (playerIds.length === 0) return 0;
  return (room.drawerIndex + 1) % playerIds.length;
}

function allGuessed(room) {
  const players = Array.from(room.players.values());
  return players.filter(p => p.id !== players[room.drawerIndex]?.id).every(p => p.guessed);
}

function broadcastRoomState(room) {
  const players = Array.from(room.players.values()).map(p => ({
    id: p.id, name: p.name, tgId: p.tgId || null, score: p.score, guessed: p.guessed
  }));
  io.to(room.code).emit('room_state', {
    code: room.code,
    players,
    round: room.round,
    maxRounds: room.maxRounds,
    drawerId: Array.from(room.players.keys())[room.drawerIndex] || null,
    hint: room.hint || null,
    phase: room.phase,
    timer: room.timer,
  });
}

function startTurn(room) {
  if (room.phase === 'ended') return;
  room.phase = 'choosing';
  room.currentWord = null;
  room.hint = null;
  room.choices = randomChoices(WORDS, 3);
  const drawerId = Array.from(room.players.keys())[room.drawerIndex];
  io.to(room.code).emit('turn_start', { drawerId });
  io.to(drawerId).emit('word_choices', room.choices);
  room.players.forEach(p => { p.guessed = false; });
}

function beginDrawingPhase(room, word) {
  room.currentWord = word;
  room.hint = maskWord(word);
  room.phase = 'drawing';
  room.timer = DEFAULTS.roundTime;
  io.to(room.code).emit('hint_update', room.hint);
  broadcastRoomState(room);

  revealHintOverTime(room);

  const tick = setInterval(() => {
    if (room.phase !== 'drawing') { clearInterval(tick); return; }
    room.timer -= 1;
    io.to(room.code).emit('timer', room.timer);

    if (room.timer <= 0 || allGuessed(room)) {
      clearInterval(tick);
      endTurn(room);
    }
  }, 1000);
}

function endTurn(room) {
  room.phase = 'intermission';
  io.to(room.code).emit('turn_end', { word: room.currentWord });
  setTimeout(() => nextTurnOrRound(room), 3000);
}

function nextTurnOrRound(room) {
  room.drawerIndex = getNextDrawerIndex(room);
  if (room.drawerIndex === 0) {
    room.round += 1;
  }
  if (room.round > room.maxRounds) {
    room.phase = 'ended';
    const finalScores = Array.from(room.players.values()).map(p => ({
      id: p.id, name: p.name, tgId: p.tgId || null, score: p.score
    }));
    io.to(room.code).emit('game_over', { scores: finalScores });
    // Persist room phase as ended
    (async () => {
      try { if (roomsCol) await roomsCol.updateOne({ _id: room.code }, { $set: { phase: 'ended', endedAt: new Date() } }, { upsert: true }); } catch {}
    })();
    return;
  }
  startTurn(room);
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
  };
  rooms.set(code, room);
  return room;
}

// ----------------- MongoDB -----------------
const mongoUri = process.env.MONGODB_URI;
let mongoClient = null;
let usersCol = null;
let roomsCol = null;

async function initDb() {
  if (!mongoUri) {
    console.warn('MONGODB_URI not set; user scores will not persist.');
    return;
  }
  mongoClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5000 });
  await mongoClient.connect();
  const dbName = process.env.MONGODB_DB || 'scribbly';
  const db = mongoClient.db(dbName);
  usersCol = db.collection('users');
  await usersCol.createIndex({ _id: 1 });
  roomsCol = db.collection('rooms');
  await roomsCol.createIndex({ _id: 1 });
  console.log('Connected to MongoDB');
}

async function ensureUser(userId, name, tgId) {
  if (!usersCol || !userId) return;
  await usersCol.updateOne(
    { _id: String(userId) },
    { $setOnInsert: { _id: String(userId), tgId: tgId || null, name: name || 'Player', score: 0 } },
    { upsert: true }
  );
}

async function incrementScore(userId, delta) {
  if (!usersCol || !userId || !delta) return;
  await usersCol.updateOne(
    { _id: String(userId) },
    { $inc: { score: delta } },
    { upsert: true }
  );
}

io.on('connection', (socket) => {
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
      broadcastRoomState(created);
    })();
  });

  socket.on('join_room', async ({ code, name, tgId }) => {
    const raw = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(raw)) {
      io.to(socket.id).emit('chat', { system: true, message: 'Invalid room code. Use 4 letters/numbers (e.g., AB1C).' });
      io.to(socket.id).emit('error', { code: 'INVALID_ROOM_CODE', room: raw });
      return;
    }
    // Validate against DB if available
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
      // proceed with join using validated room
      socket.join(raw);
      socket.join(socket.id);
      room.players.set(socket.id, {
        id: socket.id, name: name?.slice(0, 24) || 'Player', tgId: tgId || null,
        score: 0, guessed: false
      });
      try { await ensureUser(tgId || socket.id, name, tgId); } catch {}
      broadcastRoomState(room);
      io.to(raw).emit('chat', { system: true, message: `${name || 'Player'} joined.` });
      return;
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
    socket.join(raw);
    socket.join(socket.id);
    room.players.set(socket.id, {
      id: socket.id, name: name?.slice(0, 24) || 'Player', tgId: tgId || null,
      score: 0, guessed: false
    });
    // ensure user exists in DB
    try { await ensureUser(tgId || socket.id, name, tgId); } catch {}
    broadcastRoomState(room);
    io.to(raw).emit('chat', { system: true, message: `${name || 'Player'} joined.` });
  });

  socket.on('leave_room', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    room.players.delete(socket.id);
    socket.leave(code);
    io.to(code).emit('chat', { system: true, message: 'A player left.' });
    broadcastRoomState(room);
  });

  socket.on('start_game', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (room.players.size < 1) return;
    if (room.phase !== 'waiting' && room.phase !== 'ended') return;
    room.round = 1;
    room.drawerIndex = 0;
    room.phase = 'choosing';
    startTurn(room);
  });

  socket.on('choose_word', ({ code, word }) => {
    const room = rooms.get(code);
    if (!room) return;
    const drawerId = Array.from(room.players.keys())[room.drawerIndex];
    if (socket.id !== drawerId) return;
    if (!room.choices.includes(word)) return;
    beginDrawingPhase(room, word);
  });

  socket.on('draw', ({ code, stroke }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'drawing') return;
    const drawerId = Array.from(room.players.keys())[room.drawerIndex];
    if (socket.id !== drawerId) return;
    socket.to(code).emit('draw', stroke);
  });

  socket.on('chat', async ({ code, message, name }) => {
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    const text = String(message || '').slice(0, 140);

    if (room.phase === 'drawing' && room.currentWord) {
      if (!player.guessed && text.toLowerCase() === room.currentWord.toLowerCase()) {
        player.guessed = true;
        const timeBonus = Math.max(0, room.timer);
        const guessScore = 100 + Math.floor(timeBonus);
        player.score += guessScore;
        const drawerId = Array.from(room.players.keys())[room.drawerIndex];
        const drawer = room.players.get(drawerId);
        if (drawer) drawer.score += 20;

        // persist scores
        try {
          await incrementScore(player.tgId || player.id, guessScore);
          if (drawer) await incrementScore(drawer.tgId || drawer.id, 20);
        } catch {}

        io.to(socket.id).emit('chat', { system: true, message: 'You guessed the word!' });
        io.to(room.code).emit('chat', { system: true, message: `${player.name} guessed the word!` });
        broadcastRoomState(room);

        if (allGuessed(room)) {
          endTurn(room); // now will always advance to next drawer
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
        room.players.delete(socket.id);
        io.to(code).emit('chat', { system: true, message: 'A player disconnected.' });
        broadcastRoomState(room);
      }
    }
  });
});

const port = process.env.PORT || 3000;
(async () => {
  try {
    await initDb();
  } catch (e) {
    console.warn('MongoDB init failed:', e?.message || e);
  }
  server.listen(port, () => {
    console.log(`Server listening on :${port}`);
  });
})();
