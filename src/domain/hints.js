import { maskWord } from './words.js'

export function revealHintOverTime(io, room, defaults) {
  const { currentWord } = room
  const indices = currentWord.split('').map((_, i) => i).filter(i => currentWord[i] !== ' ')
  const toReveal = new Set()
  const interval = Math.max(8, Math.floor(defaults.roundTime * 0.2))
  const hintInterval = setInterval(() => {
    if (room.phase !== 'drawing') { clearInterval(hintInterval); return }
    if (indices.length === 0) { clearInterval(hintInterval); return }
    const idx = indices.splice(Math.floor(Math.random()*indices.length), 1)[0]
    toReveal.add(idx)
    room.hint = maskWord(currentWord, toReveal)
    io.to(room.code).emit('hint_update', room.hint)
  }, interval * 1000)
  return hintInterval
}
