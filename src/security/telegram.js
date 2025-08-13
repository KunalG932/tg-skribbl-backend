import crypto from 'crypto'

// Verify Telegram WebApp initData per official docs
// - initData: the raw initData string from Telegram
// - botToken: your bot token from BotFather
// Returns { ok: boolean, data: MapLike }
export function verifyTelegramInitData(initData, botToken) {
  try {
    if (!initData || !botToken) return { ok: false, data: null }
    const params = new URLSearchParams(initData)
    const receivedHash = params.get('hash')
    if (!receivedHash) return { ok: false, data: null }

    // Build data_check_string of all params except 'hash', sorted by key
    const entries = []
    for (const [k, v] of params.entries()) {
      if (k === 'hash') continue
      entries.push(`${k}=${v}`)
    }
    entries.sort()
    const dataCheckString = entries.join('\n')

    // secret key = sha256(botToken)
    const secretKey = crypto.createHash('sha256').update(botToken).digest()
    const hmac = crypto.createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex')

    const ok = hmac === receivedHash
    return { ok, data: params }
  } catch {
    return { ok: false, data: null }
  }
}

export function extractUserFromInitData(params) {
  if (!params) return null
  try {
    const userStr = params.get('user')
    if (!userStr) return null
    const user = JSON.parse(userStr)
    if (!user || typeof user.id === 'undefined') return null
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || 'Player'
    return { id: user.id, name }
  } catch {
    return null
  }
}
