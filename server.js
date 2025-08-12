import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';

const app = express();
// Restrict CORS to your deployed frontend
app.use(cors({ origin: ['https://tg-skribbl-frontend.vercel.app'], methods: ['GET','POST'] }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ['https://tg-skribbl-frontend.vercel.app'], methods: ['GET', 'POST'] },
});

// In-memory store
const rooms = new Map(); // roomCode -> { players: Map(socketId,{id,name,tgId,score,guessed}), drawerIndex, round, maxRounds, currentWord, hint, phase, timer, choices }

const DEFAULTS = {
  roundTime: 75, // seconds per turn
  maxRounds: 3,
};

const WORDS = [
  'cat','dog','house','car','tree','phone','pizza','guitar','rocket','flower','computer','book','chair','bottle','mountain','river','sun','moon','star','cloud'
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
  // reveal every ~20% time
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
  // Levenshtein distance with early stop
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

function allGuessedOrTimerEnded(room) {
  const players = Array.from(room.players.values());
  const allGuessersDone = players.filter(p => p.id !== players[room.drawerIndex]?.id).every(p => p.guessed);
  return allGuessersDone || room.timer <= 0;
}

function broadcastRoomState(room) {
  const players = Array.from(room.players.values()).map(p => ({ id: p.id, name: p.name, tgId: p.tgId || null, score: p.score, guessed: p.guessed }));
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
  // Only send choices to drawer
  io.to(drawerId).emit('word_choices', room.choices);
  // Reset guessed flags
  room.players.forEach(p => { p.guessed = false; });
}

function beginDrawingPhase(room, word) {
  room.currentWord = word;
  room.hint = maskWord(word);
  room.phase = 'drawing';
  room.timer = DEFAULTS.roundTime;
  io.to(room.code).emit('hint_update', room.hint);
  broadcastRoomState(room);
  // Start timers
  revealHintOverTime(room);
  const tick = setInterval(() => {
    if (room.phase !== 'drawing') { clearInterval(tick); return; }
    room.timer -= 1;
    io.to(room.code).emit('timer', room.timer);
    if (allGuessedOrTimerEnded(room)) {
      clearInterval(tick);
      endTurn(room);
    }
  }, 1000);
}

function endTurn(room) {
  room.phase = 'intermission';
  io.to(room.code).emit('turn_end', { word: room.currentWord });
  // small delay then next
  setTimeout(() => nextTurnOrRound(room), 3000);
}

function nextTurnOrRound(room) {
  // Advance drawer
  room.drawerIndex = getNextDrawerIndex(room);
  // Check if round should increment (after cycling back to first drawer)
  if (room.drawerIndex === 0) {
    room.round += 1;
  }
  if (room.round > room.maxRounds) {
    room.phase = 'ending';
    const finalScores = Array.from(room.players.values()).map(p => ({ id: p.id, name: p.name, tgId: p.tgId || null, score: p.score }));
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
  // Join/Create room
  socket.on('join_room', ({ code, name, tgId }) => {
    const room = ensureRoom(code);
    socket.join(code);
    socket.join(socket.id); // private room for drawer choices
    room.players.set(socket.id, { id: socket.id, name: name?.slice(0, 24) || 'Player', tgId: tgId || null, score: 0, guessed: false });
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

  // Start game from lobby
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

  // Drawer picked word
  socket.on('choose_word', ({ code, word }) => {
    const room = rooms.get(code);
    if (!room) return;
    const drawerId = Array.from(room.players.keys())[room.drawerIndex];
    if (socket.id !== drawerId) return; // only drawer
    if (!room.choices.includes(word)) return;
    beginDrawingPhase(room, word);
  });

  // Drawing strokes relay
  socket.on('draw', ({ code, stroke }) => {
    const room = rooms.get(code);
    if (!room || room.phase !== 'drawing') return;
    const drawerId = Array.from(room.players.keys())[room.drawerIndex];
    if (socket.id !== drawerId) return; // only drawer can draw
    socket.to(code).emit('draw', stroke);
  });

  // Chat / guesses
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
        player.score += 100 + Math.floor(timeBonus);
        const drawerId = Array.from(room.players.keys())[room.drawerIndex];
        const drawer = room.players.get(drawerId);
        if (drawer) drawer.score += 20; // small drawer bonus
        io.to(socket.id).emit('chat', { system: true, message: 'You guessed the word!' });
        io.to(room.code).emit('chat', { system: true, message: `${player.name} guessed the word!` });
        broadcastRoomState(room);
        return;
      } else if (!player.guessed && isCloseGuess(text, room.currentWord)) {
        io.to(socket.id).emit('chat', { system: true, message: 'Close!' });
        return;
      }
    }
    io.to(code).emit('chat', { name: name || player.name, message: text });
  });

  socket.on('disconnecting', () => {
    // Remove player from any joined rooms
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
server.listen(port, () => {
  console.log(`Server listening on :${port}`);
});
