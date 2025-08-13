import { MongoClient } from 'mongodb'

let client = null
let usersCol = null
let roomsCol = null

export async function initDb(uri, dbName = 'scribbly') {
  if (!uri) {
    console.warn('MONGODB_URI not set; user scores will not persist.')
    return { ok: false }
  }
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 })
  await client.connect()
  const db = client.db(dbName)
  usersCol = db.collection('users')
  await usersCol.createIndex({ _id: 1 })
  roomsCol = db.collection('rooms')
  await roomsCol.createIndex({ _id: 1 })
  console.log('Connected to MongoDB')
  return { ok: true }
}

export function getUsersCol() { return usersCol }
export function getRoomsCol() { return roomsCol }

export async function ensureUser(userId, name, tgId) {
  if (!usersCol || !userId) return
  await usersCol.updateOne(
    { _id: String(userId) },
    { $setOnInsert: { _id: String(userId), tgId: tgId || null, name: name || 'Player', score: 0 } },
    { upsert: true }
  )
}

export async function incrementScore(userId, delta) {
  if (!usersCol || !userId || !delta) return
  await usersCol.updateOne(
    { _id: String(userId) },
    { $inc: { score: delta } },
    { upsert: true }
  )
}

export async function incrementGamesPlayed(userId, delta = 1) {
  if (!usersCol || !userId || !delta) return
  await usersCol.updateOne(
    { _id: String(userId) },
    { $inc: { 'stats.gamesPlayed': delta } },
    { upsert: true }
  )
}

export async function addToTotalScore(userId, delta) {
  if (!usersCol || !userId || !delta) return
  await usersCol.updateOne(
    { _id: String(userId) },
    { $inc: { 'stats.totalScore': delta } },
    { upsert: true }
  )
}
