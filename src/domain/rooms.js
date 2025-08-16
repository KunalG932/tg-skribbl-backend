import { getRandomChoices, maskWord } from './words.js';
import { revealHintOverTime } from './hints.js';
import { incrementGamesPlayed, getRoomsCol } from '../db/mongo.js';

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
    hostId: room.hostId || null,
    hostTgId: room.hostTgId || null,
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
  // Persist phase change
  (async () => {
    try { const roomsCol = getRoomsCol(); if (roomsCol) await roomsCol.updateOne({ _id: room.code }, { $set: { phase: 'choosing' } }, { upsert: true }); } catch {}
  })();
  // Fetch fresh choices dynamically each turn to reflect updated word cache
  // Note: this is async; emit choices once available
  (async () => {
    try {
      room.choices = await getRandomChoices(3);
    } catch {
      room.choices = room.choices && room.choices.length ? room.choices : ['cat','dog','tree'];
    }
    const order = Array.isArray(room.playerOrder) ? room.playerOrder : Array.from(room.players.keys());
    const drawerId = order[room.drawerIndex];
    io.to(room.code).emit('turn_start', { drawerId });
    io.to(drawerId).emit('word_choices', room.choices);
    room.players.forEach(p => { p.guessed = false; });
  })();
}

export function beginDrawingPhase(io, room, defaults, word) {
  room.currentWord = word;
  room.hint = maskWord(word);
  room.phase = 'drawing';
  // Persist phase change
  (async () => {
    try { const roomsCol = getRoomsCol(); if (roomsCol) await roomsCol.updateOne({ _id: room.code }, { $set: { phase: 'drawing', startedAt: new Date(), endedAt: null } }); } catch {}
  })();
  const base = Number(defaults?.roundTime || 75);
  const multipliers = [1.0, 0.85, 0.7];
  const m = multipliers[(room.round - 1) % multipliers.length] || 0.6;
  room.timer = Math.max(20, Math.round(base * m));
  io.to(room.code).emit('hint_update', room.hint);
  broadcastRoomState(io, room);
  // Clear any existing timers before starting new ones
  if (room._hintHandle) { try { clearInterval(room._hintHandle); } catch {} }
  if (room._tickHandle) { try { clearInterval(room._tickHandle); } catch {} }
  if (room._intermissionHandle) { try { clearTimeout(room._intermissionHandle); } catch {} finally { room._intermissionHandle = null } }
  room._hintHandle = revealHintOverTime(io, room, defaults);

  const tick = setInterval(() => {
    if (room.phase !== 'drawing') { 
      clearInterval(tick); 
      if (room._tickHandle === tick) room._tickHandle = null;
      return; 
    }
    room.timer -= 1;
    io.to(room.code).emit('timer', room.timer);

    if (room.timer <= 0 || allGuessed(room)) {
      clearInterval(tick);
      endTurn(io, room);
    }
  }, 1000);
  room._tickHandle = tick;
}

export function endTurn(io, room) {
  room.phase = 'intermission';
  // Persist phase change
  (async () => {
    try { const roomsCol = getRoomsCol(); if (roomsCol) await roomsCol.updateOne({ _id: room.code }, { $set: { phase: 'intermission' } }); } catch {}
  })();
  io.to(room.code).emit('turn_end', { word: room.currentWord });
  // Proactively clear timers to avoid leaks while in intermission
  if (room._tickHandle) { try { clearInterval(room._tickHandle); } catch {} finally { room._tickHandle = null } }
  if (room._hintHandle) { try { clearInterval(room._hintHandle); } catch {} finally { room._hintHandle = null } }
  if (room._intermissionHandle) { try { clearTimeout(room._intermissionHandle); } catch {} }
  room._intermissionHandle = setTimeout(() => nextTurnOrRound(io, room), 3000);
}

export function nextTurnOrRound(io, room) {
  if (room.phase === 'ended') return { ended: true };
  // Normalize player order to existing sockets
  const currentIds = new Set(room.players.keys());
  const baseOrder = Array.isArray(room.playerOrder) ? room.playerOrder : Array.from(room.players.keys());
  const order = baseOrder.filter(id => currentIds.has(id));
  room.playerOrder = order;

  // If fewer than 2 players remain, end the game early
  if (order.length < 2) {
    room.phase = 'ended';
    const finalScores = Array.from(room.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      tgId: p.tgId || null,
      score: p.score
    }));
    io.to(room.code).emit('game_over', { scores: finalScores });
    (async () => {
      try { const roomsCol = getRoomsCol(); if (roomsCol) await roomsCol.updateOne({ _id: room.code }, { $set: { phase: 'ended', endedAt: new Date() } }); } catch {}
    })();
    return { ended: true, finalScores };
  }

  const prevIndex = room.drawerIndex;
  room.drawerIndex = getNextDrawerIndex(room);
  // Robust wrap detection: increment round only when we wrapped around and there are at least 2 players
  if (order.length > 1 && room.drawerIndex <= prevIndex) {
    room.round += 1;
    // If exceeding maxRounds, end the game now without emitting round_started
    if (room.round > room.maxRounds) {
      room.phase = 'ended';
      const finalScores = Array.from(room.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        tgId: p.tgId || null,
        score: p.score
      }));
      io.to(room.code).emit('game_over', { scores: finalScores });
      (async () => {
        try { const roomsCol = getRoomsCol(); if (roomsCol) await roomsCol.updateOne({ _id: room.code }, { $set: { phase: 'ended', endedAt: new Date() } }); } catch {}
      })();
      return { ended: true, finalScores };
    }
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
    // Persist ended state with endedAt for TTL cleanup
    (async () => {
      try { const roomsCol = getRoomsCol(); if (roomsCol) await roomsCol.updateOne({ _id: room.code }, { $set: { phase: 'ended', endedAt: new Date() } }); } catch {}
    })();
    // Persist gamesPlayed for all participants
    (async () => {
      try {
        const uniq = new Set();
        for (const p of room.players.values()) {
          const key = String(p.tgId || p.id);
          if (!uniq.has(key)) {
            uniq.add(key);
            await incrementGamesPlayed(key, 1);
          }
        }
      } catch {}
    })();
    return { ended: true, finalScores };
  }
  startTurn(io, room);
  return { ended: false };
}

export function clearRoomTimers(room) {
  try { if (room._tickHandle) clearInterval(room._tickHandle); } catch {}
  try { if (room._hintHandle) clearInterval(room._hintHandle); } catch {}
  try { if (room._intermissionHandle) clearTimeout(room._intermissionHandle); } catch {}
  room._tickHandle = null;
  room._hintHandle = null;
  room._intermissionHandle = null;
}