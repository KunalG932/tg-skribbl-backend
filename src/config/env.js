function norm(o) {
  try { return new URL(o).origin }
  catch { return String(o || '').replace(/\/$/, '') }
}

export function buildAllowedOrigins(nodeEnv, envCsv) {
  const dev = nodeEnv !== 'production'
  const envOrigins = (envCsv || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(norm)
  const defaultOrigins = ['https://tg-skribbl-frontend.vercel.app']
  const localOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173']
  const base = envOrigins.length ? envOrigins : defaultOrigins
  const set = new Set([...(base.map(norm)), ...(dev ? localOrigins.map(norm) : [])])
  return Array.from(set)
}
