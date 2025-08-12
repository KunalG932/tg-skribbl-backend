import mongoose from '../db.js';

const PlayerSchema = new mongoose.Schema({
  tgId: { type: String, index: true },
  name: { type: String },
  score: { type: Number, default: 0 },
}, { _id: false });

const RoomSchema = new mongoose.Schema({
  code: { type: String, unique: true, index: true },
  chatId: { type: String, index: true }, // Telegram group chat id (if created from a group)
  players: { type: [PlayerSchema], default: [] },
  active: { type: Boolean, default: true },
}, { timestamps: true });

RoomSchema.statics.addOrUpdatePlayer = async function (code, tgId, name, deltaScore) {
  const room = await this.findOneAndUpdate(
    { code },
    { $setOnInsert: { code } },
    { new: true, upsert: true }
  );
  const idx = room.players.findIndex(p => p.tgId === tgId);
  if (idx === -1) {
    room.players.push({ tgId, name: name || 'Player', score: Math.max(0, deltaScore || 0) });
  } else {
    room.players[idx].name = name || room.players[idx].name;
    if (typeof deltaScore === 'number') room.players[idx].score = Math.max(0, (room.players[idx].score || 0) + deltaScore);
  }
  await room.save();
  return room;
};

RoomSchema.statics.setScore = async function (code, tgId, name, score) {
  const room = await this.findOneAndUpdate(
    { code },
    { $setOnInsert: { code } },
    { new: true, upsert: true }
  );
  const idx = room.players.findIndex(p => p.tgId === tgId);
  if (idx === -1) {
    room.players.push({ tgId, name: name || 'Player', score: Math.max(0, score || 0) });
  } else {
    room.players[idx].name = name || room.players[idx].name;
    if (typeof score === 'number') room.players[idx].score = Math.max(0, score);
  }
  await room.save();
  return room;
};

RoomSchema.statics.leaderboard = async function (code, limit = 10) {
  const room = await this.findOne({ code });
  if (!room) return [];
  return [...room.players]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, limit);
};

const Room = mongoose.model('Room', RoomSchema);
export default Room;
