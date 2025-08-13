export function buildAllowedOrigins(nodeEnv, envCsv) {
  const dev = nodeEnv !== 'production'
  const envOrigins = (envCsv || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const defaultOrigins = ['https://tg-skribbl-frontend.vercel.app']
  const localOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173']
  const base = envOrigins.length ? envOrigins : defaultOrigins
  return [...new Set([...(base), ...(dev ? localOrigins : [])])]
}
