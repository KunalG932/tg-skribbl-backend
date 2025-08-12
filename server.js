import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';

const app = express();
app.use(cors({ origin: ['https://tg-skribbl-frontend.vercel.app'], methods: ['GET','POST'] }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ['https://tg-skribbl-frontend.vercel.app'], methods: ['GET', 'POST'] },
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
        player.score += 100 + Math.floor(timeBonus);
        const drawerId = Array.from(room.players.keys())[room.drawerIndex];
        const drawer = room.players.get(drawerId);
        if (drawer) drawer.score += 20;

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
server.listen(port, () => {
  console.log(`Server listening on :${port}`);
});
