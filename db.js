const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const REMOTE_URL = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || '';
const REMOTE_TOKEN = process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN || '';
const isRemote = Boolean(REMOTE_URL);

let localDb = null;
let remoteClient = null;

if (!isRemote) {
  const dbPath = process.env.VERCEL
    ? path.join('/tmp', 'chat.db')
    : process.env.CHAT_DB || path.join(__dirname, 'chat.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  try {
    localDb = new DatabaseSync(dbPath);
  } catch (err) {
    console.warn(`[chat] Cannot open ${dbPath} (${err.message}) — using in-memory database.`);
    localDb = new DatabaseSync(':memory:');
  }
} else {
  remoteClient = require('@libsql/client').createClient({ url: REMOTE_URL, authToken: REMOTE_TOKEN || undefined });
}

if (process.env.VERCEL && !isRemote) {
  console.warn('[chat] TURSO_DATABASE_URL not set — falling back to local SQLite (data will not persist).');
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rooms (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL COLLATE NOCASE,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    file TEXT,
    sender_id INTEGER,
    edited_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_messages_room ON messages (room, id)',
  `CREATE TABLE IF NOT EXISTS dms (
    room TEXT PRIMARY KEY,
    user_a TEXT NOT NULL COLLATE NOCASE,
    user_b TEXT NOT NULL COLLATE NOCASE,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS presence (
    room TEXT NOT NULL COLLATE NOCASE,
    username TEXT NOT NULL COLLATE NOCASE,
    account_id INTEGER,
    typing INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room, username)
  )`,
  `CREATE TABLE IF NOT EXISTS deleted_log (
    id INTEGER PRIMARY KEY,
    room TEXT NOT NULL COLLATE NOCASE,
    deleted_at INTEGER NOT NULL
  )`,
  "INSERT OR IGNORE INTO rooms (name, created_at) VALUES ('General', ?)"
];

const MSG_COLS = ['file', 'sender_id', 'edited_at'];

async function run(sql, args = []) {
  if (isRemote) {
    await remoteClient.execute({ sql, args });
  } else {
    localDb.prepare(sql).run(...args);
  }
}

function normalize(columns, row) {
  if (!row) return row;
  if (Array.isArray(row)) {
    const out = {};
    for (let i = 0; i < columns.length; i++) out[columns[i]] = row[i];
    return out;
  }
  return { ...row };
}

async function get(sql, args = []) {
  if (isRemote) {
    const res = await remoteClient.execute({ sql, args });
    return res.rows[0] ? normalize(res.columns, res.rows[0]) : null;
  }
  return localDb.prepare(sql).get(...args) || null;
}

async function all(sql, args = []) {
  if (isRemote) {
    const res = await remoteClient.execute({ sql, args });
    return res.rows.map((r) => normalize(res.columns, r));
  }
  return localDb.prepare(sql).all(...args);
}

let readyPromise = null;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      for (const sql of SCHEMA) await run(sql, sql.includes('INSERT OR IGNORE') ? [Date.now()] : []);
      const cols = await all('PRAGMA table_info(messages)');
      const names = cols.map((c) => c.name);
      for (const col of MSG_COLS) {
        if (!names.includes(col)) {
          const type = col === 'file' ? 'TEXT' : col === 'sender_id' ? 'INTEGER' : 'INTEGER';
          await run(`ALTER TABLE messages ADD COLUMN ${col} ${type}`);
        }
      }
    })();
  }
  return readyPromise;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(password, salt, 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function createUser(username, password) {
  try {
    await run('INSERT INTO users (username, pass, created_at) VALUES (?, ?, ?)', [username, hashPassword(password), Date.now()]);
    return { ok: true };
  } catch (err) {
    if (/UNIQUE/i.test(String(err.message))) return { ok: false, error: 'That username is already taken.' };
    throw err;
  }
}

async function authenticate(username, password) {
  const row = await get('SELECT id, username, pass FROM users WHERE username = ?', [username]);
  if (!row || !verifyPassword(password, row.pass)) return null;
  return { userId: row.id, username: row.username };
}

async function isRegistered(username) {
  return Boolean(await get('SELECT id FROM users WHERE username = ?', [username]));
}

async function getUser(username) {
  return get('SELECT id, username FROM users WHERE username = ?', [username]);
}

async function createSession(username) {
  const row = await getUser(username);
  if (!row) return null;
  const token = crypto.randomBytes(32).toString('hex');
  await run('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)', [token, row.id, Date.now()]);
  return token;
}

async function getSession(token) {
  if (!token) return null;
  const row = await get(
    'SELECT s.token, s.user_id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?',
    [token]
  );
  return row ? { userId: row.user_id, username: row.username } : null;
}

async function deleteSession(token) {
  if (token) await run('DELETE FROM sessions WHERE token = ?', [token]);
}

async function ensureRoom(name) {
  await run('INSERT OR IGNORE INTO rooms (name, created_at) VALUES (?, ?)', [name, Date.now()]);
}

async function listRooms() {
  const rows = await all('SELECT name FROM rooms WHERE name NOT LIKE \'dm:%\' ORDER BY name COLLATE NOCASE');
  return rows.map((r) => r.name);
}

function isDmRoom(room) {
  return String(room).startsWith('dm:');
}

function dmRoomName(a, b) {
  const [x, y] = [String(a).toLowerCase(), String(b).toLowerCase()].sort();
  return `dm:${x}:${y}`;
}

function dmParticipants(room) {
  const parts = String(room).slice(3).split(':');
  return parts.length === 2 && parts[0] && parts[1] ? parts : null;
}

async function ensureDm(room, a, b) {
  await run('INSERT OR IGNORE INTO dms (room, user_a, user_b, created_at) VALUES (?, ?, ?, ?)', [room, a, b, Date.now()]);
}

async function listDmRooms(username) {
  return all('SELECT room, user_a, user_b FROM dms WHERE user_a = ? OR user_b = ? ORDER BY created_at DESC', [username, username]);
}

async function addMessage(room, username, text, file = null, senderId = null) {
  const row = await get(
    'INSERT INTO messages (room, username, text, file, sender_id, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    [room, username, text, file ? JSON.stringify(file) : null, senderId, Date.now()]
  );
  return Number(row.id);
}

async function recentMessages(room, limit = 100) {
  return all('SELECT id, username, text, file, sender_id, edited_at, created_at FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?', [room, limit]).then(
    (rows) => rows.reverse()
  );
}

async function messagesSince(room, sinceId, sinceTime, limit = 100) {
  return all(
    `SELECT id, username, text, file, edited_at, created_at FROM messages
     WHERE room = ? AND (id > ? OR (edited_at IS NOT NULL AND edited_at > ?))
     ORDER BY id ASC LIMIT ?`,
    [room, sinceId, sinceTime, limit]
  );
}

async function getMessage(id, room) {
  return get(
    'SELECT id, username, text, file, sender_id, edited_at, created_at FROM messages WHERE id = ? AND room = ?',
    [id, room]
  );
}

async function updateMessageText(id, text) {
  await run('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?', [text, Date.now(), id]);
}

async function deleteMessageRow(id, room) {
  await run('INSERT OR REPLACE INTO deleted_log (id, room, deleted_at) VALUES (?, ?, ?)', [id, room, Date.now()]);
  await run('DELETE FROM messages WHERE id = ?', [id]);
}

async function deletesSince(room, sinceTime) {
  return all('SELECT id FROM deleted_log WHERE room = ? AND deleted_at > ?', [room, sinceTime]);
}

async function touchPresence(room, username, accountId, typing = null) {
  await run(
    `INSERT INTO presence (room, username, account_id, typing, updated_at) VALUES (?, ?, ?, COALESCE(?, 0), ?)
     ON CONFLICT(room, username) DO UPDATE SET
       account_id = excluded.account_id,
       typing = COALESCE(?, presence.typing),
       updated_at = excluded.updated_at`,
    [room, username, accountId, typing, Date.now(), typing]
  );
}

async function listMembers(room, maxAge = 45000) {
  const rows = await all('SELECT username FROM presence WHERE room = ? AND updated_at > ? ORDER BY username COLLATE NOCASE', [room, Date.now() - maxAge]);
  return rows.map((r) => r.username);
}

async function listTyping(room, maxAge = 8000) {
  const rows = await all('SELECT username FROM presence WHERE room = ? AND typing = 1 AND updated_at > ? ORDER BY username COLLATE NOCASE', [room, Date.now() - maxAge]);
  return rows.map((r) => r.username);
}

async function getPresence(room, username) {
  return get('SELECT room, username, account_id, typing, updated_at FROM presence WHERE room = ? AND username = ?', [room, username]);
}

async function removePresence(room, username) {
  await run('DELETE FROM presence WHERE room = ? AND username = ?', [room, username]);
}

async function removePresenceByName(username) {
  await run('DELETE FROM presence WHERE username = ?', [username]);
}

module.exports = {
  ensureReady,
  isRemote,
  createUser,
  authenticate,
  isRegistered,
  getUser,
  createSession,
  getSession,
  deleteSession,
  ensureRoom,
  listRooms,
  isDmRoom,
  dmRoomName,
  dmParticipants,
  ensureDm,
  listDmRooms,
  addMessage,
  recentMessages,
  messagesSince,
  getMessage,
  updateMessageText,
  deleteMessageRow,
  deletesSince,
  touchPresence,
  listMembers,
  listTyping,
  getPresence,
  removePresence,
  removePresenceByName
};
