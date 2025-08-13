export function guessScoreForTime(timer) {
  const timeBonus = Math.max(0, Number(timer) || 0)
  return 100 + Math.floor(timeBonus)
}

export function drawerBonus() {
  return 20
}
