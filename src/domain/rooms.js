import { randomChoices, maskWord } from './words.js';
import { revealHintOverTime } from './hints.js';

export function broadcastRoomState(io, room) {
  const players = Array.from(room.players.values()).map(p => ({
    id: p.id, 
    name: p.name, 
    tgId: p.tgId || null, 
    score: p.score, 
    guessed: p.guessed
  }));
  const drawerOrder = Array.isArray(room.playerOrder) ? room.playerOrder : Array.from(room.players.keys());
  const drawerId = drawerOrder[room.drawerIndex] || null;
  io.to(room.code).emit('room_state', {
    code: room.code,
    players,
    round: room.round,
    maxRounds: room.maxRounds,
    drawerId,
    hint: room.hint || null,
    phase: room.phase,
    timer: room.timer,
  });
}

export function getNextDrawerIndex(room) {
  const order = Array.isArray(room.playerOrder) ? room.playerOrder : Array.from(room.players.keys());
  if (order.length === 0) return 0;
  const n = order.length;
  for (let step = 1; step <= n; step++) {
    const idx = (room.drawerIndex + step) % n;
    const candidateId = order[idx];
    if (room.players.has(candidateId)) return idx;
  }
  return 0;
}

export function allGuessed(room) {
  const players = Array.from(room.players.values());
  const order = Array.isArray(room.playerOrder) ? room.playerOrder : Array.from(room.players.keys());
  const currentDrawerId = order[room.drawerIndex];
  return players.filter(p => p.id !== currentDrawerId).every(p => p.guessed);
}

export function startTurn(io, room) {
  if (room.phase === 'ended') return;
  room.phase = 'choosing';
  room.currentWord = null;
  room.hint = null;
  room.choices = randomChoices(room.WORDS || [], 3);
  const order = Array.isArray(room.playerOrder) ? room.playerOrder : Array.from(room.players.keys());
  const drawerId = order[room.drawerIndex];
  io.to(room.code).emit('turn_start', { drawerId });
  io.to(drawerId).emit('word_choices', room.choices);
  room.players.forEach(p => { p.guessed = false; });
}

export function beginDrawingPhase(io, room, defaults, word) {
  room.currentWord = word;
  room.hint = maskWord(word);
  room.phase = 'drawing';
  const base = Number(defaults?.roundTime || 75);
  const multipliers = [1.0, 0.85, 0.7];
  const m = multipliers[(room.round - 1) % multipliers.length] || 0.6;
  room.timer = Math.max(20, Math.round(base * m));
  io.to(room.code).emit('hint_update', room.hint);
  broadcastRoomState(io, room);
  revealHintOverTime(io, room, defaults);

  const tick = setInterval(() => {
    if (room.phase !== 'drawing') { 
      clearInterval(tick); 
      return; 
    }
    room.timer -= 1;
    io.to(room.code).emit('timer', room.timer);

    if (room.timer <= 0 || allGuessed(room)) {
      clearInterval(tick);
      endTurn(io, room);
    }
  }, 1000);
}

export function endTurn(io, room) {
  room.phase = 'intermission';
  io.to(room.code).emit('turn_end', { word: room.currentWord });
  setTimeout(() => nextTurnOrRound(io, room), 3000);
}

export function nextTurnOrRound(io, room) {
  const prevIndex = room.drawerIndex;
  room.drawerIndex = getNextDrawerIndex(room);
  if (room.drawerIndex === 0 && prevIndex !== 0) {
    room.round += 1;
    const base = 75;
    const multipliers = [1.0, 0.85, 0.7];
    const idx = Math.max(0, Math.min(multipliers.length - 1, room.round - 1));
    const time = Math.max(20, Math.round(base * multipliers[idx]));
    io.to(room.code).emit('round_started', { round: room.round, time });
  }
  if (room.round > room.maxRounds) {
    room.phase = 'ended';
    const finalScores = Array.from(room.players.values()).map(p => ({
      id: p.id, 
      name: p.name, 
      tgId: p.tgId || null, 
      score: p.score
    }));
    io.to(room.code).emit('game_over', { scores: finalScores });
    return { ended: true, finalScores };
  }
  startTurn(io, room);
  return { ended: false };
}