const db = require('../db');

const MAX_MESSAGE = 500;
const MEMBER_TTL = 45000;

function validUsername(name) {
  return /^[\w\- ]{3,20}$/.test(name);
}

function validRoomName(name) {
  return name.length >= 1 && /^[\w\- ]+$/.test(name);
}

function publicHistory(rows) {
  return rows.map((m) => {
    let file = null;
    if (m.file) {
      try { file = JSON.parse(m.file); } catch { file = null; }
    }
    return {
      id: Number(m.id),
      username: m.username,
      text: m.text,
      time: m.created_at,
      file,
      edited: Boolean(m.edited_at)
    };
  });
}

function ownsMessage(row, as) {
  if (row.sender_id != null) return row.sender_id === as.accountId;
  return row.username === as.username;
}

function sanitizeFile(file) {
  if (!file || typeof file !== 'object') return null;
  const url = String(file.url || '');
  const isLocal = /^\/uploads\/[a-f0-9]{24}\.[a-z0-9]+$/.test(url);
  const isBlob = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/[\w./-]+$/.test(url);
  if (!isLocal && !isBlob) return null;
  if (isLocal) {
    const fs = require('fs');
    const path = require('path');
    const dir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(path.join(dir, path.basename(url)))) return null;
  }
  return {
    url,
    name: String(file.name || '').slice(0, 120),
    size: Math.max(0, Number(file.size) || 0),
    type: String(file.type || '').slice(0, 64)
  };
}

/* ---------- Auth ---------- */

async function register({ username: raw, password, confirm } = {}) {
  await db.ensureReady();
  const username = String(raw || '').trim();
  password = String(password || '');
  const confirmPw = confirm != null ? String(confirm) : password;
  if (!validUsername(username)) return { ok: false, error: 'Username: 3-20 chars, letters/numbers/spaces/-/_ only.' };
  if (password.length < 6) return { ok: false, error: 'Password must be at least 6 characters.' };
  if (password !== confirmPw) return { ok: false, error: 'Passwords do not match.' };
  const created = await db.createUser(username, password);
  if (!created.ok) return created;
  return { ok: true, token: await db.createSession(username), username };
}

async function login({ username: raw, password } = {}) {
  await db.ensureReady();
  const username = String(raw || '').trim();
  password = String(password || '');
  if (!username || !password) return { ok: false, error: 'Enter username and password.' };
  const user = await db.authenticate(username, password);
  if (!user) return { ok: false, error: 'Invalid username or password.' };
  return { ok: true, token: await db.createSession(user.username), username: user.username };
}

async function verify(token) {
  await db.ensureReady();
  const session = await db.getSession(token);
  if (!session) return { ok: false, error: 'Session expired. Please log in again.' };
  return { ok: true, username: session.username };
}

async function logout(token) {
  await db.ensureReady();
  await db.deleteSession(token);
  return { ok: true };
}

async function changePassword({ token, current, next, confirm } = {}) {
  await db.ensureReady();
  const session = await db.getSession(token);
  if (!session) return { ok: false, error: 'Session expired. Please log in again.' };
  current = String(current || '');
  next = String(next || '');
  const confirmPw = confirm != null ? String(confirm) : next;
  if (!current || !next) return { ok: false, error: 'Enter your current and new password.' };
  if (next.length < 6) return { ok: false, error: 'Password must be at least 6 characters.' };
  if (next !== confirmPw) return { ok: false, error: 'Passwords do not match.' };
  const user = await db.authenticate(session.username, current);
  if (!user) return { ok: false, error: 'Current password is incorrect.' };
  await db.updatePassword(session.username, next);
  return { ok: true };
}

/* ---------- Identity (stateless, for REST) ---------- */

async function identity({ token, username } = {}) {
  await db.ensureReady();
  if (token) {
    const session = await db.getSession(token);
    if (!session) return null;
    return { username: session.username, accountId: session.userId };
  }
  const name = String(username || '').trim().slice(0, 20);
  if (!name || (await db.isRegistered(name))) return null;
  return { username: name, accountId: null };
}

/* ---------- Rooms / DMs ---------- */

async function listRooms() {
  await db.ensureReady();
  return db.listRooms();
}

async function listDms(token) {
  await db.ensureReady();
  const session = await db.getSession(token);
  if (!session) return [];
  const me = session.username.toLowerCase();
  const rows = await db.listDmRooms(session.username);
  return rows.map((r) => ({
    room: r.room,
    with: r.user_a.toLowerCase() === me ? r.user_b : r.user_a
  }));
}

async function resolveRoomAccess({ room, username, accountId }) {
  if (db.isDmRoom(room)) {
    if (accountId === null) return { ok: false, error: 'Direct messages require an account — log in first.' };
    const parts = db.dmParticipants(room);
    if (!parts) return { ok: false, error: 'Invalid conversation.' };
    const me = username.toLowerCase();
    const other = parts[0] === me ? parts[1] : parts[1] === me ? parts[0] : null;
    if (!other) return { ok: false, error: 'You are not part of this conversation.' };
    const otherUser = await db.getUser(other);
    if (!otherUser) return { ok: false, error: 'That user does not exist.' };
    if (otherUser.username.toLowerCase() === me) return { ok: false, error: 'You cannot message yourself.' };
    return { ok: true, room: db.dmRoomName(username, otherUser.username), dmWith: otherUser.username };
  }
  if (!validRoomName(room)) return { ok: false, error: 'Room names use letters, numbers, spaces, - and _.' };
  return { ok: true, room, dmWith: null };
}

async function joinRoom({ token, username: rawName, room: rawRoom, checkPresence = true, scan = null } = {}) {
  await db.ensureReady();
  let username;
  let accountId = null;

  if (token) {
    const session = await db.getSession(token);
    if (!session) return { ok: false, error: 'Session expired. Please log in again.' };
    username = session.username;
    accountId = session.userId;
  } else {
    username = String(rawName || '').trim().slice(0, 20);
    if (username.length < 1) return { ok: false, error: 'Enter a display name.' };
    if (await db.isRegistered(username)) {
      return { ok: false, error: 'That name belongs to an account — log in to use it.' };
    }
  }

  let room = String(rawRoom || '').trim().slice(0, 24);
  const access = await resolveRoomAccess({ room, username, accountId });
  if (!access.ok) return access;
  room = access.room;

  if (scan) {
    const verdict = scan({ room, username, accountId });
    if (verdict && verdict.ok === false) return verdict;
  }

  if (checkPresence) {
    const existing = await db.getPresence(room, username);
    if (existing && Date.now() - existing.updated_at < MEMBER_TTL) {
      const sameAccount = accountId !== null && Number(existing.account_id) === accountId;
      const stealsGuest = accountId !== null && existing.account_id == null;
      if (!sameAccount && !stealsGuest) {
        return { ok: false, error: 'That name is already used in this room.' };
      }
    }
  }

  if (db.isDmRoom(room)) await db.ensureDm(room, username, access.dmWith);
  else await db.ensureRoom(room);
  await db.touchPresence(room, username, accountId);

  const history = publicHistory(await db.recentMessages(room));
  const users = await db.listMembers(room);
  return { ok: true, room, username, accountId, guest: accountId === null, dmWith: access.dmWith, history, users };
}

/* ---------- Messages ---------- */

async function postMessage({ room, text, file, as }) {
  await db.ensureReady();
  const clean = String(text || '').trim().slice(0, MAX_MESSAGE);
  const safeFile = sanitizeFile(file);
  if (!clean && !safeFile) return { ok: false, error: 'Empty message.' };
  const id = await db.addMessage(room, as.username, clean, safeFile, as.accountId);
  const message = { id, username: as.username, text: clean, time: Date.now() };
  if (safeFile) message.file = safeFile;
  return { ok: true, message };
}

async function editMessage({ room, id, text, as }) {
  await db.ensureReady();
  id = Number(id);
  text = String(text || '').trim().slice(0, MAX_MESSAGE);
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: 'Invalid message.' };
  if (!text) return { ok: false, error: 'Message cannot be empty.' };
  const row = await db.getMessage(id, room);
  if (!row) return { ok: false, error: 'Message not found.' };
  if (!ownsMessage(row, as)) return { ok: false, error: 'You can only edit your own messages.' };
  await db.updateMessageText(id, text);
  return { ok: true, edit: { id, room, text, edited: true } };
}

async function deleteMessage({ room, id, as }) {
  await db.ensureReady();
  id = Number(id);
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: 'Invalid message.' };
  const row = await db.getMessage(id, room);
  if (!row) return { ok: false, error: 'Message not found.' };
  if (!ownsMessage(row, as)) return { ok: false, error: 'You can only delete your own messages.' };
  await db.deleteMessageRow(id, room);
  return { ok: true, delete: { id, room } };
}

/* ---------- Polling (Vercel mode) ---------- */

async function poll({ token, username, room, sinceId = 0, sinceTime = 0, typing = false } = {}) {
  const as = await identity({ token, username });
  if (!as) return { ok: false, unauthorized: true, error: 'Not logged in.' };
  const access = await resolveRoomAccess({ room, username: as.username, accountId: as.accountId });
  if (!access.ok) return access;
  room = access.room;

  await db.touchPresence(room, as.username, as.accountId, typing ? 1 : 0);
  const serverTime = Date.now();
  const id = Number(sinceId) || 0;
  const time = Number(sinceTime) || 0;
  const messages = publicHistory(await db.messagesSince(room, id, time));
  const deletes = (await db.deletesSince(room, time)).map((r) => Number(r.id));
  const users = await db.listMembers(room);
  const typingUsers = await db.listTyping(room);
  return { ok: true, room, dmWith: access.dmWith, messages, deletes, users, typing: typingUsers, serverTime };
}

async function setTyping({ token, username, room, typing } = {}) {
  const as = await identity({ token, username });
  if (!as) return { ok: false, error: 'Not logged in.' };
  const access = await resolveRoomAccess({ room, username: as.username, accountId: as.accountId });
  if (!access.ok) return access;
  await db.touchPresence(access.room, as.username, as.accountId, typing ? 1 : 0);
  return { ok: true, room: access.room };
}

async function members(room) {
  await db.ensureReady();
  return db.listMembers(room);
}

module.exports = {
  MAX_MESSAGE,
  register,
  login,
  verify,
  logout,
  changePassword,
  identity,
  listRooms,
  listDms,
  resolveRoomAccess,
  joinRoom,
  postMessage,
  editMessage,
  deleteMessage,
  poll,
  setTyping,
  members
};
