export function createRateLimiter({ count, windowMs }) {
  const times = []
  return {
    allow() {
      const now = Date.now()
      while (times.length && now - times[0] > windowMs) times.shift()
      if (times.length >= count) return false
      times.push(now)
      return true
    }
  }
}
