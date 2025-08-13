export function guessScoreForTime(timer) {
  const timeBonus = Math.max(0, Number(timer) || 0)
  return 100 + Math.floor(timeBonus) // 100 points + time bonus
}

export function drawerBonus() {
  return 20 // 20 points for drawer
}
