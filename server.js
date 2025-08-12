import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import 'dotenv/config';
import { connectDB } from './db.js';
import Room from './models/Room.js';

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

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// --- REST APIs for webapp <-> DB sync ---
// Join a room (idempotent)
app.post('/api/room/join', async (req, res) => {
  try {
    const { code, tgId, name } = req.body || {};
    if (!code || !tgId) return res.status(400).json({ error: 'code and tgId required' });
    const room = await Room.addOrUpdatePlayer(String(code).toUpperCase(), String(tgId), name, 0);
    return res.json({ ok: true, room: { code: room.code, players: room.players } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'join_failed' });
  }
});

// Update score (either absolute score or delta)
app.post('/api/score', async (req, res) => {
  try {
    const { code, tgId, name, score, deltaScore } = req.body || {};
    if (!code || !tgId) return res.status(400).json({ error: 'code and tgId required' });
    let room;
    if (typeof score === 'number') {
      room = await Room.setScore(String(code).toUpperCase(), String(tgId), name, score);
    } else {
      room = await Room.addOrUpdatePlayer(String(code).toUpperCase(), String(tgId), name, Number(deltaScore) || 0);
    }
    return res.json({ ok: true, room: { code: room.code, players: room.players } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'score_update_failed' });
  }
});

// Get leaderboard for a room
app.get('/api/leaderboard', async (req, res) => {
  try {
    const code = String(req.query.code || '').toUpperCase();
    if (!code) return res.status(400).json({ error: 'code required' });
    const top = await Room.leaderboard(code, 10);
    return res.json({ ok: true, code, top });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'leaderboard_failed' });
  }
});

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
  if (room.phase === 'ending') return;
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
    room.phase = 'ending';
    const finalScores = Array.from(room.players.values()).map(p => ({
      id: p.id, name: p.name, tgId: p.tgId || null, score: p.score
    }));
    io.to(room.code).emit('game_over', { scores: finalScores });
    return;
  }
  startTurn(room);
}

function ensureRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      players: new Map(),
      drawerIndex: 0,
      round: 1,
      maxRounds: DEFAULTS.maxRounds,
      currentWord: null,
      hint: null,
      phase: 'lobby',
      timer: 0,
      choices: [],
    });
  }
  return rooms.get(code);
}

io.on('connection', (socket) => {
  socket.on('join_room', ({ code, name, tgId }) => {
    const room = ensureRoom(code);
    socket.join(code);
    socket.join(socket.id);
    room.players.set(socket.id, {
      id: socket.id, name: name?.slice(0, 24) || 'Player', tgId: tgId || null,
      score: 0, guessed: false
    });
    broadcastRoomState(room);
    io.to(code).emit('chat', { system: true, message: `${name || 'Player'} joined.` });
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
    if (room.phase !== 'lobby' && room.phase !== 'ending') return;
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

  socket.on('chat', ({ code, message, name }) => {
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    const text = String(message || '').slice(0, 140);

    if (room.phase === 'drawing' && room.currentWord) {
      if (!player.guessed && text.toLowerCase() === room.currentWord.toLowerCase()) {
        player.guessed = true;
        const timeBonus = Math.max(0, room.timer);
        const guessDelta = 100 + Math.floor(timeBonus);
        player.score += guessDelta;
        const drawerId = Array.from(room.players.keys())[room.drawerIndex];
        const drawer = room.players.get(drawerId);
        if (drawer) drawer.score += 20;

        // Persist deltas to MongoDB if tgIds known
        try {
          if (player.tgId) Room.addOrUpdatePlayer(String(room.code).toUpperCase(), String(player.tgId), player.name, guessDelta).catch(()=>{});
          if (drawer?.tgId) Room.addOrUpdatePlayer(String(room.code).toUpperCase(), String(drawer.tgId), drawer.name, 20).catch(()=>{});
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

// Initialize DB only (bot runs in separate project now)
connectDB(process.env.MONGODB_URI).catch((e) => console.error('MongoDB connection error', e));

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server listening on :${port}`);
});
