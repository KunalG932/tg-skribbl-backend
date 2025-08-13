export const WORDS = [
  'cat','dog','house','car','tree','phone','pizza','guitar','rocket','flower',
  'computer','book','chair','bottle','mountain','river','sun','moon','star','cloud'
]

export function randomChoices(arr, n) {
  const copy = [...arr]
  const out = []
  while (out.length < n && copy.length) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0])
  }
  return out
}

export function maskWord(word, revealed = new Set()) {
  return word
    .split('')
    .map((ch, i) => (ch === ' ' ? ' ' : revealed.has(i) ? ch : '_'))
    .join('')
}
