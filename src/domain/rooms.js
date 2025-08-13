import { randomChoices, maskWord } from './words.js'
import { revealHintOverTime } from './hints.js'

export function broadcastRoomState(io, room) {
  const players = Array.from(room.players.values()).map(p => ({
    id: p.id, name: p.name, tgId: p.tgId || null, score: p.score, guessed: p.guessed
  }))
  io.to(room.code).emit('room_state', {
    code: room.code,
    players,
    round: room.round,
    maxRounds: room.maxRounds,
    drawerId: Array.from(room.players.keys())[room.drawerIndex] || null,
    hint: room.hint || null,
    phase: room.phase,
    timer: room.timer,
  })
}

export function getNextDrawerIndex(room) {
  const playerIds = Array.from(room.players.keys())
  if (playerIds.length === 0) return 0
  return (room.drawerIndex + 1) % playerIds.length
}

export function allGuessed(room) {
  const players = Array.from(room.players.values())
  return players.filter(p => p.id !== players[room.drawerIndex]?.id).every(p => p.guessed)
}

export function startTurn(io, room) {
  if (room.phase === 'ended') return
  room.phase = 'choosing'
  room.currentWord = null
  room.hint = null
  room.choices = randomChoices(room.WORDS || [], 3)
  const drawerId = Array.from(room.players.keys())[room.drawerIndex]
  io.to(room.code).emit('turn_start', { drawerId })
  io.to(drawerId).emit('word_choices', room.choices)
  room.players.forEach(p => { p.guessed = false })
}

export function beginDrawingPhase(io, room, defaults, word) {
  room.currentWord = word
  room.hint = maskWord(word)
  room.phase = 'drawing'
  room.timer = defaults.roundTime
  io.to(room.code).emit('hint_update', room.hint)
  broadcastRoomState(io, room)
  revealHintOverTime(io, room, defaults)

  const tick = setInterval(() => {
    if (room.phase !== 'drawing') { clearInterval(tick); return }
    room.timer -= 1
    io.to(room.code).emit('timer', room.timer)

    if (room.timer <= 0 || allGuessed(room)) {
      clearInterval(tick)
      endTurn(io, room)
    }
  }, 1000)
}

export function endTurn(io, room) {
  room.phase = 'intermission'
  io.to(room.code).emit('turn_end', { word: room.currentWord })
  setTimeout(() => nextTurnOrRound(io, room), 3000)
}

export function nextTurnOrRound(io, room) {
  room.drawerIndex = getNextDrawerIndex(room)
  if (room.drawerIndex === 0) {
    room.round += 1
  }
  if (room.round > room.maxRounds) {
    room.phase = 'ended'
    const finalScores = Array.from(room.players.values()).map(p => ({
      id: p.id, name: p.name, tgId: p.tgId || null, score: p.score
    }))
    io.to(room.code).emit('game_over', { scores: finalScores })
    return { ended: true, finalScores }
  }
  startTurn(io, room)
  return { ended: false }
}
